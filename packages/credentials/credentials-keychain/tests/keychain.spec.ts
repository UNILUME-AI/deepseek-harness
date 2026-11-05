// The keychain-held credentials move out of the file at boot, live only in the
// keychain or process memory afterwards, and never fall back to the file;
// every other credential keeps the file store's behavior.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { KeychainCredentialProvider } from '../src/index.ts'
import type { Keychain } from '../src/index.ts'

const MODEL_TOKEN = credentialRef('UNILUME_MODEL_TOKEN')
const DESKTOP = credentialKey('unilume-desktop', 'default')
const BROWSER = credentialKey('client-connection', 'browser-session')
const PLATFORM = credentialKey('deepseek-account-platform', 'default')

const DESKTOP_RECORD: CredentialRecord = {
  kind: 'grant',
  payload: { version: 1, token: 'desktop-token', expiresAt: '2026-11-05T10:00:00.000Z' },
}
const BROWSER_RECORD: CredentialRecord = { kind: 'grant', payload: { version: 1, secret: 'browser-secret' } }
const PLATFORM_RECORD: CredentialRecord = { kind: 'grant', payload: { access: 'platform-access' } }

const LEGACY = `version: 1
refs:
  UNILUME_MODEL_TOKEN: model-token
  OTHER_KEY: other-value
records:
  unilume-desktop/default:
    kind: grant
    payload: { version: 1, token: desktop-token, expiresAt: "2026-11-05T10:00:00.000Z" }
  client-connection/browser-session:
    kind: grant
    payload: { version: 1, secret: browser-secret }
  deepseek-account-platform/default:
    kind: grant
    payload: { access: platform-access }
`

/** In-memory keychain with switchable failures. */
class MemoryKeychain implements Keychain {
  readonly entries = new Map<string, string>()
  denied = false
  failSet = false
  corruptReads = false

  get(account: string): Promise<string | undefined> {
    if (this.denied) return Promise.reject(new Error('access denied'))
    const value = this.entries.get(account)
    return Promise.resolve(value !== undefined && this.corruptReads ? `${value} ` : value)
  }

  set(account: string, value: string): Promise<void> {
    if (this.denied || this.failSet) return Promise.reject(new Error('access denied'))
    this.entries.set(account, value)
    return Promise.resolve()
  }

  delete(account: string): Promise<boolean> {
    if (this.denied) return Promise.reject(new Error('access denied'))
    return Promise.resolve(this.entries.delete(account))
  }
}

/** Keychain whose every operation fails with the same platform error. */
class UnavailableKeychain implements Keychain {
  readonly error = new Error('access denied')
  readonly get = vi.fn<Keychain['get']>().mockRejectedValue(this.error)
  readonly set = vi.fn<Keychain['set']>().mockRejectedValue(this.error)
  readonly delete = vi.fn<Keychain['delete']>().mockRejectedValue(this.error)
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cred-keychain-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return join(dir, '.credentials.yaml')
}

async function boot(path: string, keychain: Keychain, warn?: Context['logger']['warn']): Promise<Context> {
  class Provider extends KeychainCredentialProvider {
    constructor(ctx: Context, config: { path: string; watch: boolean }) {
      super(ctx, config, keychain)
    }
  }
  const ctx = new Context()
  if (warn !== undefined) {
    const spy = vi.spyOn(ctx.logger, 'warn').mockImplementation(warn)
    cleanups.push(async () => { spy.mockRestore() })
  }
  const fiber = ctx.plugin(Provider, { path, watch: false })
  cleanups.push(async () => { await fiber.dispose() })
  await fiber
  return ctx
}

async function seedLegacy(path: string): Promise<void> {
  await writeFile(path, LEGACY, { mode: 0o600 })
  await writeFile(`${path}.bak-20261101`, LEGACY, { mode: 0o600 })
  await writeFile(`${path}.0123456789ab.tmp`, LEGACY, { mode: 0o600 })
}

async function siblings(path: string): Promise<string[]> {
  return (await readdir(join(path, '..'))).sort()
}

function put(ctx: Context, key: typeof DESKTOP, record: CredentialRecord): Promise<CredentialRecord | undefined> {
  return ctx.credentials.modifyRecord(key, () => Promise.resolve(record))
}

describe('boot migration', () => {
  it('moves the three credentials into the keychain and removes every plaintext copy', async () => {
    const path = await tempFile()
    await seedLegacy(path)
    const keychain = new MemoryKeychain()
    const ctx = await boot(path, keychain)

    expect(keychain.entries.get('UNILUME ref UNILUME_MODEL_TOKEN')).toBe('model-token')
    expect(JSON.parse(keychain.entries.get('UNILUME record unilume-desktop/default')!)).toEqual(DESKTOP_RECORD)
    expect(JSON.parse(keychain.entries.get('UNILUME record client-connection/browser-session')!)).toEqual(BROWSER_RECORD)

    const text = await readFile(path, 'utf8')
    const document = parseCredentialsDocument(text, path)
    expect([...document.refs.keys()]).toEqual(['OTHER_KEY'])
    expect([...document.records.keys()]).toEqual(['deepseek-account-platform/default'])
    expect(text).not.toContain('model-token')
    expect(text).not.toContain('desktop-token')
    expect(text).not.toContain('browser-secret')
    expect(await siblings(path)).toEqual(['.credentials.yaml'])

    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'model-token', source: 'keychain' })
    expect(await ctx.credentials.describe(MODEL_TOKEN)).toEqual({ configured: true, source: 'keychain', writable: true })
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)
    expect(await ctx.credentials.describeRecord(BROWSER)).toEqual({ configured: true, kind: 'grant', writable: true })
    expect(await ctx.credentials.listRecords()).toEqual(expect.arrayContaining([
      { key: PLATFORM, kind: 'grant' },
      { key: DESKTOP, kind: 'grant' },
      { key: BROWSER, kind: 'grant' },
    ]))
    expect(ctx.credentials.agentDeniedReadPaths).toEqual([path])
  })

  it('leaves the file untouched when a keychain write fails, and the next start migrates', async () => {
    const path = await tempFile()
    await seedLegacy(path)
    const keychain = new MemoryKeychain()
    keychain.failSet = true
    const ctx = await boot(path, keychain)

    expect(await readFile(path, 'utf8')).toBe(LEGACY)
    expect(await siblings(path)).toHaveLength(3)
    // The unmigrated file value keeps serving, so the sign-in survives.
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)

    keychain.failSet = false
    await boot(path, keychain)
    expect(await readFile(path, 'utf8')).not.toContain('desktop-token')
    expect(keychain.entries.size).toBe(3)
  })

  it('leaves the file untouched when a keychain entry reads back different, and the next start migrates', async () => {
    const path = await tempFile()
    await seedLegacy(path)
    const keychain = new MemoryKeychain()
    keychain.corruptReads = true
    await boot(path, keychain)

    expect(await readFile(path, 'utf8')).toBe(LEGACY)
    expect(await siblings(path)).toHaveLength(3)

    keychain.corruptReads = false
    const ctx = await boot(path, keychain)
    expect(await readFile(path, 'utf8')).not.toContain('model-token')
    expect(await siblings(path)).toEqual(['.credentials.yaml'])
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'model-token', source: 'keychain' })
  })
})

describe('unavailable keychain', () => {
  it('keeps keychain-held credentials in memory, warns once, and writes nothing to the file', async () => {
    const path = await tempFile()
    await writeFile(path, 'version: 1\nrefs:\n  OTHER_KEY: other-value\n', { mode: 0o600 })
    const keychain = new UnavailableKeychain()
    const warn = vi.fn<Context['logger']['warn']>()
    const ctx = await boot(path, keychain, warn)
    const before = await readFile(path, 'utf8')

    expect(await ctx.credentials.readRecord(DESKTOP)).toBeUndefined()
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toBeUndefined()
    await put(ctx, DESKTOP, DESKTOP_RECORD)
    await put(ctx, BROWSER, BROWSER_RECORD)
    await ctx.credentials.set(MODEL_TOKEN, 'model-token')
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'model-token', source: 'keychain' })
    expect(await ctx.credentials.describe(MODEL_TOKEN)).toEqual({ configured: true, source: 'keychain', writable: true })
    expect(await ctx.credentials.describeRecord(BROWSER)).toEqual({ configured: true, kind: 'grant', writable: true })
    expect(await ctx.credentials.listRecords()).toEqual([
      { key: DESKTOP, kind: 'grant' },
      { key: BROWSER, kind: 'grant' },
    ])

    await ctx.credentials.deleteRecord(BROWSER)
    await ctx.credentials.unset(MODEL_TOKEN)
    expect(await ctx.credentials.readRecord(BROWSER)).toBeUndefined()
    expect(await ctx.credentials.describeRecord(BROWSER)).toEqual({ configured: false, writable: true })
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toBeUndefined()
    expect(await ctx.credentials.describe(MODEL_TOKEN)).toEqual({ configured: false, writable: true })
    expect(await ctx.credentials.listRecords()).toEqual([{ key: DESKTOP, kind: 'grant' }])

    expect(keychain.get).toHaveBeenCalledTimes(1)
    expect(keychain.set).not.toHaveBeenCalled()
    expect(keychain.delete).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/OS keychain is unavailable.*memory only.*sign in again after restarting/),
      DESKTOP,
      keychain.error,
    )
    expect(await siblings(path)).toEqual(['.credentials.yaml'])

    expect(await readFile(path, 'utf8')).toBe(before)
    // The file store keeps working for everything else.
    expect(await ctx.credentials.resolve(credentialRef('OTHER_KEY'))).toEqual({ value: 'other-value', source: 'file' })
  })

  it.each(['set', 'unset', 'deleteRecord', 'listRecords'] as const)(
    'completes the failing %s operation in memory without creating a credential file',
    async (operation) => {
      const path = await tempFile()
      const keychain = new UnavailableKeychain()
      const warn = vi.fn<Context['logger']['warn']>()
      const ctx = await boot(path, keychain, warn)

      const operations = {
        set: async () => {
          await ctx.credentials.set(MODEL_TOKEN, 'model-token')
          expect(await ctx.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'model-token', source: 'keychain' })
        },
        unset: async () => {
          await ctx.credentials.unset(MODEL_TOKEN)
          expect(await ctx.credentials.resolve(MODEL_TOKEN)).toBeUndefined()
        },
        deleteRecord: async () => {
          await ctx.credentials.deleteRecord(DESKTOP)
          expect(await ctx.credentials.readRecord(DESKTOP)).toBeUndefined()
        },
        listRecords: async () => {
          expect(await ctx.credentials.listRecords()).toEqual([])
        },
      }
      await operations[operation]()

      await put(ctx, DESKTOP, DESKTOP_RECORD)
      await put(ctx, BROWSER, BROWSER_RECORD)
      expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)
      expect(await ctx.credentials.readRecord(BROWSER)).toEqual(BROWSER_RECORD)
      expect(keychain.get.mock.calls.length + keychain.set.mock.calls.length + keychain.delete.mock.calls.length).toBe(1)
      expect(warn).toHaveBeenCalledTimes(1)
      await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await siblings(path)).toEqual([])
    },
  )

  it('completes a record write in memory when its keychain set fails after a successful read', async () => {
    const path = await tempFile()
    const keychain = new MemoryKeychain()
    keychain.failSet = true
    const get = vi.spyOn(keychain, 'get')
    const set = vi.spyOn(keychain, 'set')
    const warn = vi.fn<Context['logger']['warn']>()
    const ctx = await boot(path, keychain, warn)

    await put(ctx, DESKTOP, DESKTOP_RECORD)
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)
    await put(ctx, DESKTOP, BROWSER_RECORD)
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(BROWSER_RECORD)
    expect(get).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(await siblings(path)).toEqual([])
  })

  it('tries the keychain again in a new provider without retaining the previous memory values', async () => {
    const path = await tempFile()
    const keychain = new MemoryKeychain()
    keychain.denied = true
    const get = vi.spyOn(keychain, 'get')
    const set = vi.spyOn(keychain, 'set')
    const first = await boot(path, keychain, vi.fn())
    await first.credentials.set(MODEL_TOKEN, 'memory-token')
    await put(first, DESKTOP, DESKTOP_RECORD)
    await put(first, BROWSER, BROWSER_RECORD)

    keychain.denied = false
    expect(await first.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'memory-token', source: 'keychain' })
    expect(await first.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)
    expect(get).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledTimes(1)

    const second = await boot(path, keychain)
    expect(await second.credentials.resolve(MODEL_TOKEN)).toBeUndefined()
    expect(await second.credentials.readRecord(DESKTOP)).toBeUndefined()
    expect(await second.credentials.readRecord(BROWSER)).toBeUndefined()
    await second.credentials.set(MODEL_TOKEN, 'keychain-token')
    await put(second, DESKTOP, DESKTOP_RECORD)
    expect(keychain.entries.get('UNILUME ref UNILUME_MODEL_TOKEN')).toBe('keychain-token')
    expect(JSON.parse(keychain.entries.get('UNILUME record unilume-desktop/default')!)).toEqual(DESKTOP_RECORD)
    expect(await second.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'keychain-token', source: 'keychain' })
    expect(await first.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'memory-token', source: 'keychain' })
    expect(get).toHaveBeenCalled()
    expect(await siblings(path)).toEqual([])
  })

  it('retains unmigrated plaintext copies while memory updates and deletions take effect for this process', async () => {
    const path = await tempFile()
    await seedLegacy(path)
    const keychain = new UnavailableKeychain()
    const warn = vi.fn<Context['logger']['warn']>()
    const ctx = await boot(path, keychain, warn)
    const updated: string[] = []
    ctx.on('credentials/record-updated', (key) => { updated.push(key) })
    const next: CredentialRecord = { kind: 'api-key', key: 'memory-desktop-token' }

    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'model-token', source: 'file' })
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)
    await ctx.credentials.set(MODEL_TOKEN, 'memory-model-token')
    await put(ctx, DESKTOP, next)
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'memory-model-token', source: 'keychain' })
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(next)
    expect(await ctx.credentials.describeRecord(DESKTOP)).toEqual({ configured: true, kind: 'api-key', writable: true })
    expect(await ctx.credentials.listRecords()).toContainEqual({ key: DESKTOP, kind: 'api-key' })

    await ctx.credentials.unset(MODEL_TOKEN)
    await ctx.credentials.deleteRecord(DESKTOP)
    await ctx.credentials.deleteRecord(BROWSER)
    await ctx.credentials.deleteRecord(DESKTOP)
    await ctx.credentials.deleteRecord(BROWSER)
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toBeUndefined()
    expect(await ctx.credentials.describe(MODEL_TOKEN)).toEqual({ configured: false, writable: true })
    expect(await ctx.credentials.readRecord(DESKTOP)).toBeUndefined()
    expect(await ctx.credentials.describeRecord(DESKTOP)).toEqual({ configured: false, writable: true })
    expect(await ctx.credentials.readRecord(BROWSER)).toBeUndefined()
    expect(await ctx.credentials.listRecords()).toEqual([{ key: PLATFORM, kind: 'grant' }])
    expect(updated).toEqual([DESKTOP, DESKTOP, BROWSER])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.any(String), MODEL_TOKEN, keychain.error)
    expect(keychain.set).toHaveBeenCalledTimes(1)
    expect(keychain.get).not.toHaveBeenCalled()
    expect(keychain.delete).not.toHaveBeenCalled()
    expect(await readFile(path, 'utf8')).toBe(LEGACY)
    expect(await readFile(`${path}.bak-20261101`, 'utf8')).toBe(LEGACY)
    expect(await readFile(`${path}.0123456789ab.tmp`, 'utf8')).toBe(LEGACY)
    expect(await siblings(path)).toHaveLength(3)

    const recovered = new MemoryKeychain()
    const restarted = await boot(path, recovered)
    expect(await restarted.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)
    expect(recovered.entries.size).toBe(3)
    expect(await siblings(path)).toEqual(['.credentials.yaml'])
  })

  it('keeps the file and its copies when migration loses keychain access during readback', async () => {
    const path = await tempFile()
    await seedLegacy(path)
    const keychain = new MemoryKeychain()
    const error = new Error('keychain service stopped')
    const get = vi.spyOn(keychain, 'get').mockRejectedValue(error)
    const set = vi.spyOn(keychain, 'set')
    const warn = vi.fn<Context['logger']['warn']>()
    const ctx = await boot(path, keychain, warn)

    await put(ctx, BROWSER, { kind: 'grant', payload: { secret: 'memory-secret' } })
    expect(await ctx.credentials.readRecord(BROWSER)).toEqual({ kind: 'grant', payload: { secret: 'memory-secret' } })
    expect(get).toHaveBeenCalledTimes(1)
    expect(set).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.any(String), MODEL_TOKEN, error)
    expect(await readFile(path, 'utf8')).toBe(LEGACY)
    expect(await siblings(path)).toHaveLength(3)
  })

  it('warns once when concurrent keychain reads fail', async () => {
    const path = await tempFile()
    const keychain = new UnavailableKeychain()
    const warn = vi.fn<Context['logger']['warn']>()
    const ctx = await boot(path, keychain, warn)
    const failure = Promise.withResolvers<string | undefined>()
    const ready = Promise.withResolvers<undefined>()
    keychain.get.mockImplementation(() => {
      if (keychain.get.mock.calls.length === 3) ready.resolve(undefined)
      return failure.promise
    })

    const reads = Promise.all([
      ctx.credentials.readRecord(DESKTOP),
      ctx.credentials.readRecord(BROWSER),
      ctx.credentials.resolve(MODEL_TOKEN),
    ])
    await ready.promise
    failure.reject(keychain.error)
    expect(await reads).toEqual([undefined, undefined, undefined])
    expect(warn).toHaveBeenCalledTimes(1)
    await ctx.credentials.listRecords()
    await ctx.credentials.resolve(MODEL_TOKEN)
    expect(keychain.get).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('rejects values over 2560 UTF-8 bytes without disabling the keychain', async () => {
    const path = await tempFile()
    const keychain = new MemoryKeychain()
    const set = vi.spyOn(keychain, 'set')
    const warn = vi.fn<Context['logger']['warn']>()
    const ctx = await boot(path, keychain, warn)
    const exact = `${'界'.repeat(853)}x`
    const recordOverhead = Buffer.byteLength(JSON.stringify({ kind: 'grant', payload: '' }), 'utf8')
    const exactRecord: CredentialRecord = { kind: 'grant', payload: 'x'.repeat(2560 - recordOverhead) }

    await expect(ctx.credentials.set(MODEL_TOKEN, `${exact}x`)).rejects.toThrow(/2561 bytes.*2560-byte keychain limit/)
    await expect(put(ctx, DESKTOP, { kind: 'grant', payload: 'x'.repeat(2561 - recordOverhead) }))
      .rejects.toThrow(/2561 bytes.*2560-byte keychain limit/)
    expect(set).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()

    await ctx.credentials.set(MODEL_TOKEN, exact)
    await put(ctx, DESKTOP, exactRecord)
    expect(keychain.entries.get('UNILUME ref UNILUME_MODEL_TOKEN')).toBe(exact)
    expect(keychain.entries.get('UNILUME record unilume-desktop/default')).toBe(JSON.stringify(exactRecord))
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toEqual({ value: exact, source: 'keychain' })
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(exactRecord)
    expect(warn).not.toHaveBeenCalled()
    expect(await siblings(path)).toEqual([])
  })

  it('keeps the byte limit after switching to memory', async () => {
    const path = await tempFile()
    const keychain = new UnavailableKeychain()
    const warn = vi.fn<Context['logger']['warn']>()
    const ctx = await boot(path, keychain, warn)
    await ctx.credentials.set(MODEL_TOKEN, 'memory-token')

    await expect(ctx.credentials.set(MODEL_TOKEN, 'x'.repeat(2561))).rejects.toThrow(/2560-byte keychain limit/)
    await expect(put(ctx, DESKTOP, { kind: 'grant', payload: 'x'.repeat(2561) })).rejects.toThrow(/2560-byte keychain limit/)
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toEqual({ value: 'memory-token', source: 'keychain' })
    expect(await ctx.credentials.readRecord(DESKTOP)).toBeUndefined()
    expect(keychain.set).toHaveBeenCalledTimes(1)
    expect(keychain.get).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(await siblings(path)).toEqual([])
  })
})

describe('sign-out', () => {
  it('deletes the keychain entries through deleteRecord and unset', async () => {
    const path = await tempFile()
    await seedLegacy(path)
    const keychain = new MemoryKeychain()
    const ctx = await boot(path, keychain)
    const updated: string[] = []
    ctx.on('credentials/record-updated', (key) => { updated.push(key) })

    await ctx.credentials.deleteRecord(DESKTOP)
    await ctx.credentials.deleteRecord(BROWSER)
    await ctx.credentials.unset(MODEL_TOKEN)

    expect(keychain.entries.size).toBe(0)
    expect(updated).toEqual([DESKTOP, BROWSER])
    expect(await ctx.credentials.readRecord(DESKTOP)).toBeUndefined()
    expect(await ctx.credentials.resolve(MODEL_TOKEN)).toBeUndefined()
  })

  it('also removes a copy left in the file', async () => {
    const path = await tempFile()
    const keychain = new MemoryKeychain()
    const ctx = await boot(path, keychain)
    await put(ctx, DESKTOP, DESKTOP_RECORD)
    await writeFile(path, LEGACY, { mode: 0o600 })

    await ctx.credentials.deleteRecord(DESKTOP)
    await ctx.credentials.unset(MODEL_TOKEN)

    expect(keychain.entries.has('UNILUME record unilume-desktop/default')).toBe(false)
    const document = parseCredentialsDocument(await readFile(path, 'utf8'), path)
    expect(document.records.has(DESKTOP)).toBe(false)
    expect(document.refs.has(MODEL_TOKEN)).toBe(false)
    expect(document.records.has(BROWSER)).toBe(true)
  })
})

describe('writes', () => {
  it('stores keychain-held credentials only in the keychain', async () => {
    const path = await tempFile()
    const keychain = new MemoryKeychain()
    const ctx = await boot(path, keychain)

    await put(ctx, DESKTOP, DESKTOP_RECORD)
    await ctx.credentials.set(MODEL_TOKEN, 'model-token')

    expect(keychain.entries.size).toBe(2)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await ctx.credentials.readRecord(DESKTOP)).toEqual(DESKTOP_RECORD)
  })

  it('refuses a record the keychain text cannot reproduce', async () => {
    const path = await tempFile()
    const keychain = new MemoryKeychain()
    const ctx = await boot(path, keychain)

    await expect(put(ctx, DESKTOP, { kind: 'grant', payload: { at: new Date(0) } })).rejects.toThrow(/JSON cannot represent/)
    expect(keychain.entries.size).toBe(0)
  })

  it('keeps every other credential in the file', async () => {
    const path = await tempFile()
    const keychain = new MemoryKeychain()
    const ctx = await boot(path, keychain)

    await put(ctx, PLATFORM, PLATFORM_RECORD)
    await ctx.credentials.set(credentialRef('OTHER_KEY'), 'other-value')

    expect(keychain.entries.size).toBe(0)
    const document = parseCredentialsDocument(await readFile(path, 'utf8'), path)
    expect(document.records.get(PLATFORM)).toEqual(PLATFORM_RECORD)
    expect(document.refs.get('OTHER_KEY')).toBe('other-value')
    expect(await ctx.credentials.resolve(credentialRef('OTHER_KEY'))).toEqual({ value: 'other-value', source: 'file' })

    await ctx.credentials.deleteRecord(PLATFORM)
    expect(parseCredentialsDocument(await readFile(path, 'utf8'), path).records.has(PLATFORM)).toBe(false)
  })

  it('serializes concurrent modifyRecord calls from two providers without losing a write', async () => {
    const path = await tempFile()
    const keychain = new MemoryKeychain()
    const first = await boot(path, keychain)
    const second = await boot(path, keychain)
    const increment = (ctx: Context) => ctx.credentials.modifyRecord(DESKTOP, async (current) => {
      const count = current?.kind === 'grant' ? (current.payload as { count: number }).count : 0
      await new Promise(resolve => setTimeout(resolve, 5))
      return { kind: 'grant', payload: { count: count + 1 } }
    })

    await Promise.all(Array.from({ length: 10 }, (_, index) => increment(index % 2 === 0 ? first : second)))

    expect(await first.credentials.readRecord(DESKTOP)).toEqual({ kind: 'grant', payload: { count: 10 } })
  })
})
