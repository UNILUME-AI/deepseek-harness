/** Main-process-only credential storage; only metadata crosses the application IPC. */
import { readFile } from 'node:fs/promises'
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { CredentialEntry, CredentialId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { credentialId, credentialOrigin, credentialText } from './credential-validation.ts'
import { generateTotp, parseTotpUri } from './totp.ts'

interface StoredCredential extends CredentialEntry {
  readonly secrets: string
}

interface SecretData {
  readonly password: string
  readonly totpSecret?: string
}

function parseRecord(value: unknown): StoredCredential {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('origin' in value)
    || !('label' in value) || !('username' in value) || !('hasTotp' in value) || !('secrets' in value)
    || typeof value.hasTotp !== 'boolean') throw new Error('Invalid credential vault record')
  const origin = credentialOrigin(value.origin)
  const secrets = credentialText(value.secrets, 262144)
  if (origin !== value.origin || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(secrets)) {
    throw new Error('Invalid credential vault record')
  }
  return { id: credentialId(value.id), origin, label: credentialText(value.label, 256),
    username: credentialText(value.username, 1024, true), hasTotp: value.hasTotp, secrets }
}

/** Owns one encrypted file; failed loads or writes never replace the last persisted state. */
export class CredentialVault {
  private readonly vaultPath: string
  private vault = new Map<string, StoredCredential>()
  private loading: Promise<void> | undefined

  /** @param userDataPath - Electron's application userData directory. */
  constructor(userDataPath: string) {
    this.vaultPath = join(userDataPath, 'credential-vault.json')
  }

  /** @returns after validated loading; only ENOENT creates an empty vault. Other failures remain sticky. */
  load(): Promise<void> {
    this.loading ??= this.read()
    return this.loading
  }

  private async read(): Promise<void> {
    let data: string
    try {
      data = await readFile(this.vaultPath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      throw new Error('Cannot read credential vault; existing file was not changed')
    }
    try {
      const values: unknown = JSON.parse(data)
      if (!Array.isArray(values)) throw new Error('Invalid vault')
      const records = values.map(parseRecord)
      const next = new Map(records.map(item => [item.id, item]))
      if (next.size !== records.length) throw new Error('Duplicate vault ID')
      this.vault = next
    } catch (_error) {
      // JSON parser errors can contain file contents; never forward them to IPC or logs.
      throw new Error('Invalid credential vault; existing file was not changed')
    }
  }

  /** @param origin - optional HTTP(S) site filter. @returns metadata only; never decrypts. Call load first. */
  list(origin?: string): CredentialEntry[] {
    const filter = origin === undefined ? undefined : credentialOrigin(origin)
    return [...this.vault.values()].filter(item => filter === undefined || item.origin === filter)
      .map(({ id, origin: site, label, username, hasTotp }) => ({ id, origin: site, label, username, hasTotp }))
  }

  /**
   * @param origin - HTTP(S) site URL. @param label - display name. @param username - login name.
   * @param password - password to encrypt. @param totpSecret - optional base32 key or otpauth URI.
   * @returns UUID after atomic persistence; unavailable keyring encryption rejects the write.
   */
  async add(origin: string, label: string, username: string, password: string, totpSecret?: string): Promise<CredentialId> {
    await this.load()
    if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      throw new Error('System keyring encryption is not available. Cannot save credentials.')
    }
    origin = credentialOrigin(origin)
    label = credentialText(label, 256)
    username = credentialText(username, 1024, true)
    password = credentialText(password, 16384)
    if (totpSecret !== undefined) credentialText(totpSecret, 4096, true)
    if (totpSecret) generateTotp(totpSecret.startsWith('otpauth:') ? parseTotpUri(totpSecret) : { secret: totpSecret })
    const id = randomUUID() as CredentialId
    const secrets: SecretData = totpSecret ? { password, totpSecret } : { password }
    let encrypted: Buffer
    try { encrypted = safeStorage.encryptString(JSON.stringify(secrets)) } catch (_error) {
      throw new Error('Cannot encrypt credential; check the system keyring')
    }
    const next = new Map(this.vault)
    next.set(id, { id, origin, label, username, hasTotp: Boolean(totpSecret), secrets: encrypted.toString('base64') })
    this.save(next)
    return id
  }

  /** @param id - entry to remove. @returns after atomic persistence. */
  async remove(id: string): Promise<void> {
    await this.load()
    const next = new Map(this.vault)
    next.delete(id)
    this.save(next)
  }

  /** @param id - approved entry. @returns main-process-only secrets, or null if absent; never expose through IPC. */
  async getSecrets(id: string): Promise<SecretData | null> {
    await this.load()
    const stored = this.vault.get(id)
    if (stored === undefined) return null
    try {
      const value: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(stored.secrets, 'base64')))
      if (typeof value !== 'object' || value === null || !('password' in value)) throw new Error('Invalid secrets')
      const password = credentialText(value.password, 16384)
      return 'totpSecret' in value ? { password, totpSecret: credentialText(value.totpSecret, 4096) } : { password }
    } catch (_error) {
      throw new Error('Cannot decrypt credential; check the system keyring')
    }
  }

  private save(next: Map<string, StoredCredential>): void {
    const temporary = `${this.vaultPath}.${randomUUID()}.tmp`
    // The synchronous commit keeps concurrent IPC mutations ordered, including their in-memory state.
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      try {
        writeFileSync(fd, JSON.stringify([...next.values()]), 'utf8')
        fsyncSync(fd)
      } finally { closeSync(fd) }
      renameSync(temporary, this.vaultPath)
      this.vault = next
    } finally { rmSync(temporary, { force: true }) }
  }
}
