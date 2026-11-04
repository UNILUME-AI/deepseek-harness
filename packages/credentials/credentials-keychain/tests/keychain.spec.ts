// The keychain-held credentials move out of the file at boot, live only in the
// keychain afterwards, and never fall back to the file; every other credential
// keeps the file store's behavior.
import { afterEach, describe, expect, it } from 'vitest'
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

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cred-keychain-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return join(dir, '.credentials.yaml')
}

async function boot(path: string, keychain: Keychain): Promise<Context> {
  class Provider extends KeychainCredentialProvider {
    constructor(ctx: Context, config: { path: string; watch: boolean }) {
      super(ctx, config, keychain)
    }
  }
  const ctx = new Context()
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
  it('rejects reads and writes of keychain-held credentials and writes nothing to the file', async () => {
    const path = await tempFile()
    await writeFile(path, 'version: 1\nrefs:\n  OTHER_KEY: other-value\n', { mode: 0o600 })
    const keychain = new MemoryKeychain()
    keychain.denied = true
    const ctx = await boot(path, keychain)
    const before = await readFile(path, 'utf8')

    await expect(ctx.credentials.readRecord(DESKTOP)).rejects.toThrow(/OS keychain is unavailable/)
    await expect(ctx.credentials.resolve(MODEL_TOKEN)).rejects.toThrow(/OS keychain is unavailable/)
    await expect(put(ctx, DESKTOP, DESKTOP_RECORD)).rejects.toThrow(/OS keychain is unavailable/)
    await expect(ctx.credentials.set(MODEL_TOKEN, 'model-token')).rejects.toThrow(/OS keychain is unavailable/)
    await expect(ctx.credentials.deleteRecord(BROWSER)).rejects.toThrow(/OS keychain is unavailable/)

    expect(await readFile(path, 'utf8')).toBe(before)
    // The file store keeps working for everything else.
    expect(await ctx.credentials.resolve(credentialRef('OTHER_KEY'))).toEqual({ value: 'other-value', source: 'file' })
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
