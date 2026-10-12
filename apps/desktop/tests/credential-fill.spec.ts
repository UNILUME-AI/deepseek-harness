import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { BrowserWindow, WebSource, MessageBoxReturnValue } from 'electron'
import { CredentialFiller } from '../src/credential-fill.ts'
import { CredentialVault } from '../src/credential-vault.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const electronMock = vi.hoisted(() => {
  const mockDialog = {
    showMessageBox: vi.fn(async (): Promise<MessageBoxReturnValue> => ({ response: 0, checkboxChecked: false })),
  }

  const mockSystemPreferences = {
    canPromptTouchID: vi.fn(() => false),
    promptTouchID: vi.fn(async () => {}),
  }

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
    dialog: mockDialog,
    systemPreferences: mockSystemPreferences,
    safeStorage: mockSafeStorage,
  }
})
vi.mock('electron', () => electronMock)

describe('CredentialFiller', () => {
  let vault: CredentialVault
  let filler: CredentialFiller
  let mockGuest: { getURL: ReturnType<typeof vi.fn<() => string>>
    executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn<(world: number, scripts: WebSource[]) => Promise<boolean>>> }
  let mockMainWindow: BrowserWindow
  let testPath: string

  beforeEach(async () => {
    testPath = await mkdtemp(join(tmpdir(), 'dsh-credential-fill-'))
    vault = new CredentialVault(testPath)
    await vault.load()

    filler = new CredentialFiller(vault)

    mockGuest = {
      getURL: vi.fn(() => 'https://example.com/login'),
      executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
    }

    mockMainWindow = {
      webContents: {},
    } as BrowserWindow
  })

  afterEach(async () => {
    try {
      await rm(testPath, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  describe('origin validation', () => {
    it('rejects mismatched origins', async () => {
      await vault.add('https://example.com', 'Site', 'user', 'pass')
      const entries = vault.list()
      const credentialId = entries[0]!.id

      mockGuest.getURL.mockReturnValue('https://attacker.com/login')

      await expect(
        filler.fill(mockGuest, { credentialId, fields: ['password'] }, mockMainWindow),
      ).rejects.toThrow('Origin mismatch')
    })

    it('accepts matching origins', async () => {
      await vault.add('https://example.com', 'Site', 'user', 'pass')
      const entries = vault.list()
      const credentialId = entries[0]!.id

      mockGuest.getURL.mockReturnValue('https://example.com/login')

      const { dialog } = electronMock
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })

      const result = await filler.fill(mockGuest, { credentialId, fields: ['password'] }, mockMainWindow)

      expect(result.filled).toContain('password')
    })
  })

  describe('approval', () => {
    it('rejects when user declines approval', async () => {
      await vault.add('https://example.com', 'Site', 'user', 'pass')
      const entries = vault.list()
      const credentialId = entries[0]!.id

      const { dialog } = electronMock
      vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false })

      mockGuest.getURL.mockReturnValue('https://example.com/login')

      await expect(
        filler.fill(mockGuest, { credentialId, fields: ['password'] }, mockMainWindow),
      ).rejects.toThrow('not approved')
    })

    it('shows approval dialog with correct details', async () => {
      await vault.add('https://example.com', 'My Account', 'alice', 'pass')
      const entries = vault.list()
      const credentialId = entries[0]!.id

      const { dialog } = electronMock
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })

      mockGuest.getURL.mockReturnValue('https://example.com/login')

      await filler.fill(mockGuest, { credentialId, fields: ['password', 'username'] }, mockMainWindow)

      const detail: unknown = expect.stringContaining('password, username')
      expect(vi.mocked(dialog.showMessageBox)).toHaveBeenCalledWith(
        mockMainWindow,
        expect.objectContaining({
          type: 'question',
          detail,
        }),
      )
    })
  })

  describe('field filling', () => {
    it('returns filled fields without plaintext', async () => {
      await vault.add('https://example.com', 'Site', 'alice', 'secretpass123', 'TOTPSECRET')
      const entries = vault.list()
      const credentialId = entries[0]!.id

      const { dialog } = electronMock
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      mockGuest.getURL.mockReturnValue('https://example.com/login')

      const result = await filler.fill(
        mockGuest,
        { credentialId, fields: ['username', 'password', 'totp'] },
        mockMainWindow,
      )

      expect(result.filled.includes('password')).toBe(true)
      expect(JSON.stringify(result)).not.toContain('secretpass123')
      expect(JSON.stringify(result)).not.toContain('TOTPSECRET')
    })

    it('reports unfound fields', async () => {
      await vault.add('https://example.com', 'Site', 'alice', 'pass')
      const entries = vault.list()
      const credentialId = entries[0]!.id

      const { dialog } = electronMock
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      mockGuest.getURL.mockReturnValue('https://example.com/login')

      // Simulate field not found
      mockGuest.executeJavaScriptInIsolatedWorld.mockResolvedValue(false)

      const result = await filler.fill(
        mockGuest,
        { credentialId, fields: ['totp'] },
        mockMainWindow,
      )

      expect(result.notFound).toContain('totp')
    })
  })

  describe('TOTP handling', () => {
    it('generates TOTP from base32 secret', async () => {
      await vault.add('https://example.com', 'Site', 'alice', 'pass', 'JBSWY3DPEBLW64TMMQ======')
      const entries = vault.list()
      const credentialId = entries[0]!.id

      const { dialog } = electronMock
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      mockGuest.getURL.mockReturnValue('https://example.com/login')

      mockGuest.executeJavaScriptInIsolatedWorld.mockImplementation(async (_: number, scripts: WebSource[]) => {
        const code = scripts[0]?.code ?? ''
        // Check that code contains a valid 6-digit TOTP
        return code.match(/\d{6}/) !== null
      })

      const result = await filler.fill(
        mockGuest,
        { credentialId, fields: ['totp'] },
        mockMainWindow,
      )

      expect(result.filled).toContain('totp')
    })

    it('skips TOTP when secret is missing', async () => {
      await vault.add('https://example.com', 'Site', 'alice', 'pass')
      const entries = vault.list()
      const credentialId = entries[0]!.id

      const { dialog } = electronMock
      vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({ response: 0, checkboxChecked: false })
      mockGuest.getURL.mockReturnValue('https://example.com/login')

      const result = await filler.fill(
        mockGuest,
        { credentialId, fields: ['totp'] },
        mockMainWindow,
      )

      expect(result.notFound).toContain('totp')
    })
  })
})
