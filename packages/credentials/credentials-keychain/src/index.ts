/**
 * Credentials provider that keeps a fixed set of UNILUME desktop credentials
 * in the OS keychain (macOS Keychain, Windows Credential Manager) and every
 * other credential in the `dsh-credentials-local` file store it extends.
 *
 * Keychain-held credentials ({@link KEYCHAIN_REFS}, {@link KEYCHAIN_RECORDS}):
 *
 * - Each one is one keychain entry under {@link KEYCHAIN_SERVICE}; a reference
 *   entry holds the value, a record entry holds the record's JSON text.
 * - An entry still present in the credentials file is an unmigrated value and
 *   wins over the keychain entry: boot migration copies it over the keychain
 *   entry on its next attempt, so reads return what that attempt will keep.
 * - While the keychain is available, writes and deletes take the credentials
 *   file's cross-process writer lock, commit to the keychain, then remove any
 *   file entry, so a write becomes visible once no file entry shadows it.
 * - The first keychain failure logs its cause and switches this instance to
 *   memory for every subsequent keychain operation, including the failed one.
 *   Memory updates shadow unmigrated file entries without changing the file;
 *   they are lost on restart, when a new instance tries the keychain again.
 *
 * Boot migration copies the file entries into the keychain, reads each entry
 * back and compares it with the file value, and only then rewrites the file
 * without them and removes `.credentials.yaml.bak-*` and leftover
 * `.credentials.yaml.*.tmp` siblings. Any failure leaves the file untouched
 * and the next boot retries.
 * @module @deepseek-ai/dsh-credentials-keychain
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { parseDocument } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { LocalCredentialProvider, parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import type { Config as LocalConfig } from '@deepseek-ai/dsh-credentials-local'

/** Plugin config: the `dsh-credentials-local` file location and hot-reload fields, unchanged. */
export interface Config extends LocalConfig {}

/** Keychain service name of every entry; the `UNILUME` prefix identifies the owner in OS keychain UIs. */
export const KEYCHAIN_SERVICE = 'UNILUME dsh credentials'

/** References held in the keychain instead of the file. */
export const KEYCHAIN_REFS: ReadonlySet<string> = new Set(['UNILUME_MODEL_TOKEN'])

/** Records held in the keychain instead of the file. */
export const KEYCHAIN_RECORDS: ReadonlySet<string> = new Set([
  'unilume-desktop/default',
  'client-connection/browser-session',
])

/** Source id `resolve` and `describe` report for a keychain-held reference. */
export const KEYCHAIN_SOURCE = 'keychain'

/**
 * Same wait as the `dsh-credentials-local` document lock: this provider's
 * writes contend for that lock with every other writer of the file, including
 * record mutations that hold it across a token-refresh round trip.
 */
const DOCUMENT_LOCK_WAIT_MS = 30_000

/**
 * One keychain service's entries, addressed by account name. Every method
 * rejects when the keychain cannot be used (access denied, no keychain
 * service, platform failure).
 */
export interface Keychain {
  /**
   * Read one entry.
   * @param account - entry account name.
   * @returns the stored text, or `undefined` when no entry exists.
   */
  get(account: string): Promise<string | undefined>
  /**
   * Create or replace one entry.
   * @param account - entry account name.
   * @param value - text to store.
   */
  set(account: string, value: string): Promise<void>
  /**
   * Remove one entry.
   * @param account - entry account name.
   * @returns whether an entry existed.
   */
  delete(account: string): Promise<boolean>
}

/**
 * The OS keychain through `@napi-rs/keyring`. Windows Credential Manager names
 * an entry `<account>.<service>`, which is why account names also start with
 * `UNILUME`.
 * @param service - keychain service name.
 * @returns the keychain over that service.
 */
export function osKeychain(service: string = KEYCHAIN_SERVICE): Keychain {
  // Loaded on first use: a native module that fails to load (unsigned, missing
  // platform package) must fail only these entries, not the whole provider.
  let loaded: Promise<typeof import('@napi-rs/keyring')> | undefined
  const entry = async (account: string) => new (await (loaded ??= import('@napi-rs/keyring'))).AsyncEntry(service, account)
  return {
    // getSecret rejects when the store cannot be read; getPassword is only documented to return null.
    async get(account) {
      const bytes = await (await entry(account)).getSecret()
      return bytes === null ? undefined : Buffer.from(bytes).toString('utf8')
    },
    async set(account, value) {
      assertSecretSize(account, value)
      const bytes = Buffer.from(value, 'utf8')
      await (await entry(account)).setSecret(bytes)
    },
    delete: async account => (await entry(account)).deleteCredential(),
  }
}

/** Windows Credential Manager's per-entry limit (CRED_MAX_CREDENTIAL_BLOB_SIZE); macOS allows more. */
const MAX_SECRET_BYTES = 2560

/** Reject oversized input before a backend call can mark the keychain unavailable. */
function assertSecretSize(account: string, value: string): void {
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes > MAX_SECRET_BYTES) {
    throw new Error(`credentials-keychain: "${account}" is ${bytes} bytes, over the ${MAX_SECRET_BYTES}-byte keychain limit`)
  }
}

/** Keychain account of one reference. */
function refAccount(ref: string): string {
  return `UNILUME ref ${ref}`
}

/** Keychain account of one record. */
function recordAccount(key: string): string {
  return `UNILUME record ${key}`
}

/** File section and key of one keychain-held entry. */
type FileEntry = readonly ['refs' | 'records', string]

/**
 * Admit one record's keychain text through the file store's strict record
 * parser. JSON is YAML, so the text is embedded as the record's value; the
 * parser's diagnostics name a position, never a value.
 * @param key - the record's key.
 * @param text - the keychain entry's text.
 * @returns the admitted record.
 */
function parseKeychainRecord(key: string, text: string): CredentialRecord {
  const document = `{"version": 1, "records": {${JSON.stringify(key)}: ${text}}}`
  const record = parseCredentialsDocument(document, `OS keychain entry "${recordAccount(key)}"`).records.get(key)
  if (record === undefined) throw new Error(`credentials-keychain: OS keychain entry "${recordAccount(key)}" holds no record`)
  return record
}

/** Whether a filesystem error means absence. */
function isENOENT(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/** File store with selected credentials in the OS keychain, or only in memory after a keychain failure. */
export class KeychainCredentialProvider extends LocalCredentialProvider {
  private keychainUnavailable = false
  /** Undefined entries mask unmigrated file values deleted during this process. */
  private readonly memoryEntries = new Map<string, string | undefined>()
  private readonly memoryKeychain: Keychain = {
    get: account => Promise.resolve(this.memoryEntries.get(account)),
    set: (account, value) => {
      this.memoryEntries.set(account, value)
      return Promise.resolve()
    },
    delete: (account) => {
      const existed = this.memoryEntries.get(account) !== undefined
      this.memoryEntries.set(account, undefined)
      return Promise.resolve(existed)
    },
  }

  /** Availability can change during an awaited call from another operation. */
  private isKeychainUnavailable(): boolean {
    return this.keychainUnavailable
  }

  /**
   * @param ctx - plugin context.
   * @param config - the file store's config.
   * @param keychain - keychain backend; the OS keychain unless a test injects one.
   */
  constructor(ctx: Context, config: Config, private readonly keychain: Keychain = osKeychain()) {
    super(ctx, config)
    // Build smoke runs boot the desktop profile on the packaging machine; they must not touch its login keychain.
    if (process.env.DSH_CREDENTIALS_KEYCHAIN === 'off') {
      this.keychainUnavailable = true
      ctx.logger.warn('credentials-keychain: DSH_CREDENTIALS_KEYCHAIN=off; credentials are kept in memory only for this process and never written to the file')
    }
  }

  override async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    yield* super[Service.init]()
    try {
      await this.migrate()
    } catch (error) {
      this.ctx.logger.warn('credentials-keychain: keychain migration of %s failed; the next start retries', this.spec.filename)
      this.ctx.logger.warn(error)
    }
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const base = await super.resolve(ref)
    if (!KEYCHAIN_REFS.has(ref) || base?.source === 'env'
      || (base?.source === 'file' && !this.memoryEntries.has(refAccount(ref)))) return base
    const value = await this.keychainRef(ref)
    return value === undefined ? (base?.source === 'file' ? undefined : base) : { value, source: KEYCHAIN_SOURCE }
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    const base = await super.describe(ref)
    if (!KEYCHAIN_REFS.has(ref) || base.source === 'env'
      || (base.source === 'file' && !this.memoryEntries.has(refAccount(ref)))) return base
    const value = await this.keychainRef(ref)
    if (value !== undefined) return { configured: true, source: KEYCHAIN_SOURCE, writable: true }
    return base.source === 'file' ? { configured: false, writable: true } : base
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (!KEYCHAIN_REFS.has(ref)) return super.set(ref, value)
    if (value.length === 0) {
      throw new Error(`credentials-keychain: an empty value cannot be stored for "${ref}"; use unset`)
    }
    await this.assertUnshadowedRef(ref, 'set')
    await this.locked(ref, 'set', async () => {
      await this.assertUnshadowedRef(ref, 'set')
      assertSecretSize(refAccount(ref), value)
      await this.keychainCall(ref, keychain => keychain.set(refAccount(ref), value))
      if (!await this.removeFromFile([['refs', ref]])) this.notifyUpdated(ref)
    })
  }

  override async unset(ref: CredentialRef): Promise<void> {
    if (!KEYCHAIN_REFS.has(ref)) return super.unset(ref)
    await this.assertUnshadowedRef(ref, 'unset')
    await this.locked(ref, 'unset', async () => {
      await this.assertUnshadowedRef(ref, 'unset')
      const fileValue = !this.memoryEntries.has(refAccount(ref)) && (await super.describe(ref)).source === 'file'
      const existed = await this.keychainCall(ref, keychain => keychain.delete(refAccount(ref)))
      if (!await this.removeFromFile([['refs', ref]]) && (existed || (this.keychainUnavailable && fileValue))) this.notifyUpdated(ref)
    })
  }

  override async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const fileRecord = await super.readRecord(key)
    if (!KEYCHAIN_RECORDS.has(key)
      || (fileRecord !== undefined && !this.memoryEntries.has(recordAccount(key)))) return fileRecord
    return this.keychainRecord(key)
  }

  override async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const base = await super.describeRecord(key)
    if (!KEYCHAIN_RECORDS.has(key)
      || (base.configured && !this.memoryEntries.has(recordAccount(key)))) return base
    const record = await this.keychainRecord(key)
    return record === undefined ? { configured: false, writable: true } : { configured: true, kind: record.kind, writable: true }
  }

  /**
   * File records plus keychain-held records, with memory updates and deletions
   * taking precedence over unmigrated file records after a keychain failure.
   */
  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    const entries = (await super.listRecords()).filter(entry => !this.memoryEntries.has(recordAccount(entry.key)))
    for (const key of KEYCHAIN_RECORDS) {
      if (entries.some(entry => entry.key === key)) continue
      let record: CredentialRecord | undefined
      try {
        record = await this.keychainRecord(parseCredentialKey(key))
      } catch (error) {
        // Unreadable record text does not hide the other records.
        void error
        continue
      }
      if (record !== undefined) entries.push({ key: parseCredentialKey(key), kind: record.kind })
    }
    return entries
  }

  override async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    if (!KEYCHAIN_RECORDS.has(key)) return super.modifyRecord(key, mutate)
    return this.locked(key, 'modify', async () => {
      const current = await this.readRecord(key)
      const next = await mutate(current)
      if (next === undefined) return current
      const text = JSON.stringify(next)
      // Refuses what the keychain text cannot reproduce exactly — a Date, a
      // class instance, a non-finite number — like the file store's admission.
      if (!isDeepStrictEqual(parseKeychainRecord(key, text), next)) {
        throw new TypeError(`credentials-keychain: record "${key}" holds a value JSON cannot represent`)
      }
      assertSecretSize(recordAccount(key), text)
      await this.keychainCall(key, keychain => keychain.set(recordAccount(key), text))
      if (!await this.removeFromFile([['records', key]])) this.notifyRecordUpdated(key)
      return next
    })
  }

  override async deleteRecord(key: CredentialKey): Promise<void> {
    if (!KEYCHAIN_RECORDS.has(key)) return super.deleteRecord(key)
    await this.locked(key, 'delete', async () => {
      const fileRecord = !this.memoryEntries.has(recordAccount(key)) && await super.readRecord(key) !== undefined
      const existed = await this.keychainCall(key, keychain => keychain.delete(recordAccount(key)))
      if (!await this.removeFromFile([['records', key]]) && (existed || (this.keychainUnavailable && fileRecord))) {
        this.notifyRecordUpdated(key)
      }
    })
  }

  /** Reject a reference write the inherited environment would shadow, as the file store does. */
  private async assertUnshadowedRef(ref: CredentialRef, verb: 'set' | 'unset'): Promise<void> {
    if ((await super.describe(ref)).source !== 'env') return
    throw new Error(
      `credentials-keychain: "${ref}" is supplied read-only by the launching environment, so ${verb} would be`
      + ' shadowed; unset it in the shell you start dsh from instead',
    )
  }

  /**
   * Serialize mutations; persistent writes also take the file's writer lock
   * and reconcile its current content. Memory operations need no file lock.
   */
  private locked<T>(subject: string, verb: string, operation: () => Promise<T>): Promise<T> {
    if (this.isClosed()) throw new Error(`credentials-keychain is disposed: cannot ${verb} "${subject}"`)
    return this.enqueue(async () => {
      if (this.isClosed()) {
        throw new Error(`credentials-keychain was disposed before the queued "${subject}" ${verb} ran`)
      }
      if (this.keychainUnavailable) return operation()
      await mkdir(dirname(this.spec.filename), { recursive: true, mode: 0o700 })
      return withFileLock(this.spec.filename, async () => {
        await this.reconcileFromDisk()
        return operation()
      }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
    })
  }

  /**
   * Call the keychain until its first failure, then repeat that call and all
   * subsequent calls in memory. A call that succeeds after a concurrent failure
   * switched to memory is repeated in memory, so this process reads its own
   * writes and deletions. Concurrent failures share one warning.
   */
  private async keychainCall<T>(subject: string, call: (keychain: Keychain) => Promise<T>): Promise<T> {
    if (!this.isKeychainUnavailable()) {
      try {
        const result = await call(this.keychain)
        if (!this.isKeychainUnavailable()) return result
      } catch (error) {
        if (!this.keychainUnavailable) {
          this.keychainUnavailable = true
          this.ctx.logger.warn(
            'credentials-keychain: the OS keychain is unavailable for "%s"; credentials are kept in memory only for this process; sign in again after restarting: %O',
            subject,
            error,
          )
        }
      }
    }
    return call(this.memoryKeychain)
  }

  /** The keychain value of one reference; an empty entry is absent, like everywhere on the seam. */
  private async keychainRef(ref: string): Promise<string | undefined> {
    const value = await this.keychainCall(ref, keychain => keychain.get(refAccount(ref)))
    return value === undefined || value.length === 0 ? undefined : value
  }

  /** The keychain record for one key. */
  private async keychainRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const text = await this.keychainCall(key, keychain => keychain.get(recordAccount(key)))
    return text === undefined ? undefined : parseKeychainRecord(key, text)
  }

  /**
   * Rewrite the file without the given entries and refresh the snapshot, which
   * publishes each removed entry's update. The caller holds the writer lock.
   * @returns whether any entry was in the file.
   */
  private async removeFromFile(entries: readonly FileEntry[]): Promise<boolean> {
    if (this.keychainUnavailable) return false
    let text: string
    try {
      text = await readFile(this.spec.filename, 'utf8')
    } catch (error) {
      if (!isENOENT(error)) throw error
      return false
    }
    const document = parseDocument(text)
    const present = entries.filter(([section, key]) => document.hasIn([section, key]))
    if (present.length === 0) return false
    for (const [section, key] of present) document.deleteIn([section, key])
    // 0600: the file still holds every other credential.
    await writeFileAtomic(this.spec.filename, document.toString(), { mode: 0o600, dirMode: 0o700 })
    await this.reconcileFromDisk()
    return true
  }

  /**
   * Boot migration of keychain-held credentials still in the file. Every value
   * is written and read back before the file loses any of them, so a failure
   * at any step rejects with the file unchanged.
   */
  private async migrate(): Promise<void> {
    await this.locked(this.spec.filename, 'migrate', async () => {
      let text: string
      try {
        text = await readFile(this.spec.filename, 'utf8')
      } catch (error) {
        if (!isENOENT(error)) throw error
        return
      }
      const document = parseCredentialsDocument(text, this.spec.filename)
      const moves: Array<{ entry: FileEntry; account: string; value: string }> = []
      for (const [ref, value] of document.refs) {
        if (KEYCHAIN_REFS.has(ref)) moves.push({ entry: ['refs', ref], account: refAccount(ref), value })
      }
      for (const [key, record] of document.records) {
        if (KEYCHAIN_RECORDS.has(key)) {
          moves.push({ entry: ['records', key], account: recordAccount(key), value: JSON.stringify(record) })
        }
      }
      for (const { entry, account, value } of moves) {
        assertSecretSize(account, value)
        // Migration must never accept memory storage as a persistent copy.
        await this.keychainCall(entry[1], keychain => keychain === this.keychain ? keychain.set(account, value) : Promise.resolve())
        if (this.isKeychainUnavailable()) return
        const stored = await this.keychainCall(entry[1], keychain => keychain.get(account))
        if (this.isKeychainUnavailable()) return
        if (stored !== value) {
          throw new Error(`credentials-keychain: OS keychain entry "${account}" did not read back as written`)
        }
      }
      if (moves.length > 0) {
        await this.removeFromFile(moves.map(move => move.entry))
        this.ctx.logger.info('credentials-keychain: moved %d credentials from %s to the OS keychain', moves.length, this.spec.filename)
      }
      await this.removePlaintextCopies()
    })
  }

  /**
   * Remove `<file>.bak-*` backups and `<file>.*.tmp` atomic-write leftovers.
   * Every writer of the file writes its temp file under the writer lock the
   * caller holds, so no live temp file can match.
   */
  private async removePlaintextCopies(): Promise<void> {
    const name = basename(this.spec.filename)
    const dir = dirname(this.spec.filename)
    for (const sibling of await readdir(dir)) {
      if (!sibling.startsWith(`${name}.`)) continue
      const suffix = sibling.slice(name.length + 1)
      if (suffix.startsWith('bak-') || suffix.endsWith('.tmp')) await rm(join(dir, sibling), { force: true })
    }
  }
}

export default KeychainCredentialProvider
