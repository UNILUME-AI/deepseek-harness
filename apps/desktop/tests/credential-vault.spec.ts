import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { CredentialVault } from '../src/credential-vault.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const electronMock = vi.hoisted(() => {
  const mockSafeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: vi.fn((buf: Buffer) => {
      const str = buf.toString('utf8')
      if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length)
      throw new Error('Invalid encrypted buffer')
    }),
  }
  return {
    safeStorage: mockSafeStorage,
  }
})
vi.mock('electron', () => electronMock)

describe('CredentialVault', () => {
  let vault: CredentialVault
  let testPath: string

  beforeEach(async () => {
    testPath = await mkdtemp(join(tmpdir(), 'dsh-credential-vault-'))
    vault = new CredentialVault(testPath)
  })

  afterEach(async () => {
    try {
      await rm(testPath, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('loads empty vault on initialization', async () => {
    await vault.load()
    expect(vault.list()).toEqual([])
  })

  it('rejects write when encryption is not available', async () => {
    const { safeStorage } = electronMock
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)

    await vault.load()
    await expect(
      vault.add('https://example.com', 'Example', 'user', 'pass'),
    ).rejects.toThrow('System keyring encryption is not available')
  })

  it('adds credentials and lists them without plaintext', async () => {
    await vault.load()
    const id = await vault.add('https://example.com', 'My Site', 'alice', 'secret123')

    const entries = vault.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual({
      id,
      origin: 'https://example.com',
      label: 'My Site',
      username: 'alice',
      hasTotp: false,
    })
    expect(JSON.stringify(entries)).not.toContain('secret123')
  })

  it('adds TOTP secret and marks hasTotp', async () => {
    await vault.load()
    await vault.add(
      'https://example.com',
      'My Site',
      'alice',
      'secret123',
      'JBSWY3DPEBLW64TMMQ======',
    )

    const entries = vault.list()
    expect(entries[0]?.hasTotp).toBe(true)
  })

  it('normalizes origin URLs', async () => {
    await vault.load()
    await vault.add('https://example.com:443/', 'Site 1', 'user', 'pass')
    await vault.add('https://example.com/path', 'Site 2', 'user', 'pass')

    const entries = vault.list()
    expect(entries).toHaveLength(2)
    expect(entries[0]?.origin).toBe('https://example.com')
    expect(entries[1]?.origin).toBe('https://example.com')
  })

  it('retrieves decrypted secrets', async () => {
    await vault.load()
    const id = await vault.add('https://example.com', 'Site', 'alice', 'password123', 'TOTPSECRET')

    const secrets = await vault.getSecrets(id)
    expect(secrets).toEqual({
      password: 'password123',
      totpSecret: 'TOTPSECRET',
    })
  })

  it('returns null for non-existent credential', async () => {
    await vault.load()
    const secrets = await vault.getSecrets('non-existent-id')
    expect(secrets).toBeNull()
  })

  it('removes credentials', async () => {
    await vault.load()
    const credentialId = await vault.add('https://example.com', 'Site', 'alice', 'pass')
    expect(vault.list()).toHaveLength(1)

    await vault.remove(credentialId)
    expect(vault.list()).toHaveLength(0)
  })

  it('lists credentials filtered by origin', async () => {
    await vault.load()
    await vault.add('https://example.com', 'Ex1', 'user1', 'pass1')
    await vault.add('https://example.com', 'Ex2', 'user2', 'pass2')
    await vault.add('https://other.com', 'Other', 'user3', 'pass3')

    const filtered = vault.list('https://example.com')
    expect(filtered).toHaveLength(2)
    expect(filtered.map(e => e.label)).toEqual(['Ex1', 'Ex2'])
  })
})
