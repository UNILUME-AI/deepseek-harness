import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents, WebSource } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { CredentialId, DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { createCredentialRequestHandler, type DesktopCredentialHostResponse } from '../src/credential-host.ts'
import { CredentialVault } from '../src/credential-vault.ts'

const electronMock = vi.hoisted(() => {
  const mockDialog = {
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
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
  return { dialog: mockDialog, systemPreferences: mockSystemPreferences, safeStorage: mockSafeStorage }
})
vi.mock('electron', () => electronMock)
const { dialog, systemPreferences } = electronMock

/** Password carrying the characters most likely to escape into logs or JSON. */
const SECRET = 'p"\\\n秘  c'

let directory: string
let vault: CredentialVault
const guests = {
  getActiveGuest: vi.fn<() => WebContents | undefined>(),
  getActiveLease: vi.fn<() => DesktopBrowserLeaseId | undefined>(),
}
const confirmVisible = vi.fn<(owner: WebContents, lease: DesktopBrowserLeaseId) => Promise<boolean>>()
let window: BrowserWindow | undefined

function handler(): (request: Parameters<ReturnType<typeof createCredentialRequestHandler>>[0]) => Promise<DesktopCredentialHostResponse> {
  return createCredentialRequestHandler({ primary: () => window, guests, confirmVisible, vault })
}

function liveWindow(): BrowserWindow {
  return { webContents: { id: 1 }, isDestroyed: () => false } as BrowserWindow
}

function guestAt(url: string, execute?: (world: number, scripts: WebSource[]) => Promise<boolean>): WebContents {
  const methods: Pick<WebContents, 'getURL' | 'executeJavaScriptInIsolatedWorld'> = {
    getURL: () => url,
    executeJavaScriptInIsolatedWorld: vi.fn(execute ?? (async () => true)),
  }
  return methods as WebContents
}

beforeEach(async () => {
  vi.clearAllMocks()
  dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
  systemPreferences.canPromptTouchID.mockReturnValue(false)
  directory = await mkdtemp(join(tmpdir(), 'dsh-credential-host-'))
  vault = new CredentialVault(directory)
  window = liveWindow()
  guests.getActiveLease.mockReturnValue('00000000-0000-4000-8000-0000000000aa' as DesktopBrowserLeaseId)
  confirmVisible.mockResolvedValue(true)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('credential request handler', () => {
  it('lists only site-matched metadata for the active page', async () => {
    const added = await vault.add('https://example.com', 'Shop', 'alice', SECRET, 'JBSWY3DPEHPK3PXP')
    await vault.add('https://other.example', 'Bank', 'bob', 'other-password')
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login'))
    const response = await handler()({ type: 'credentials-list' })
    expect(response).toEqual({
      site: 'https://example.com',
      entries: [{ id: added, origin: 'https://example.com', label: 'Shop', username: 'alice', hasTotp: true }],
    })
    // Neither the stored password nor the TOTP seed appears anywhere in the reply.
    expect(JSON.stringify(response)).not.toContain(SECRET)
    expect(JSON.stringify(response)).not.toContain('JBSWY3DPEHPK3PXP')
    expect(JSON.stringify(response)).not.toContain('secrets')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('answers no-active-page when the tab shows no HTTP(S) site', async () => {
    guests.getActiveGuest.mockReturnValue(guestAt('about:blank'))
    await expect(handler()({ type: 'credentials-list' })).resolves.toEqual({ error: 'no-active-page' })
  })

  it('answers no-active-page when no browser tab was activated', async () => {
    guests.getActiveGuest.mockReturnValue(undefined)
    await expect(handler()({ type: 'credentials-list' })).resolves.toEqual({ error: 'no-active-page' })
    const id = (await vault.add('https://example.com', 'Shop', 'alice', SECRET))
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['password'] })).resolves.toEqual({ error: 'no-active-page' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('answers no-active-page when the renderer reports the tracked tab hidden', async () => {
    // The deactivation report raced or a stale guest focus re-marked a hidden tab;
    // the pre-fill renderer confirmation must refuse to fill what the user cannot see.
    confirmVisible.mockResolvedValue(false)
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login'))
    await expect(handler()({ type: 'credentials-list' })).resolves.toEqual({ error: 'no-active-page' })
    const id = (await vault.add('https://example.com', 'Shop', 'alice', SECRET))
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['password'] })).resolves.toEqual({ error: 'no-active-page' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('confirms visibility with the tracked lease before answering', async () => {
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login'))
    await handler()({ type: 'credentials-list' })
    expect(confirmVisible).toHaveBeenCalledExactlyOnceWith(
      window!.webContents,
      '00000000-0000-4000-8000-0000000000aa',
    )
  })

  it('answers no-active-page when the tracked lease vanished while confirming', async () => {
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login'))
    guests.getActiveLease.mockReturnValue(undefined)
    await expect(handler()({ type: 'credentials-list' })).resolves.toEqual({ error: 'no-active-page' })
    expect(confirmVisible).not.toHaveBeenCalled()
  })

  it('fills nothing when the tab is hidden while the approval dialog is open', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    const execute = vi.fn(async () => true)
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login', execute))
    dialog.showMessageBox.mockImplementation(async () => {
      confirmVisible.mockResolvedValue(false)
      return { response: 0, checkboxChecked: false }
    })
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['username', 'password'] }))
      .resolves.toEqual({ error: 'no-active-page' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('fills nothing when another tab becomes active while the approval dialog is open', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    const execute = vi.fn(async () => true)
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login', execute))
    dialog.showMessageBox.mockImplementation(async () => {
      guests.getActiveLease.mockReturnValue('00000000-0000-4000-8000-0000000000bb' as DesktopBrowserLeaseId)
      return { response: 0, checkboxChecked: false }
    })
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['username', 'password'] }))
      .resolves.toEqual({ error: 'no-active-page' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('fills nothing when another tab becomes active during the confirmation right before injection', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    const execute = vi.fn(async () => true)
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login', execute))
    // Confirmations run at entry, after approval, then before each field; switch during the third.
    let confirmations = 0
    confirmVisible.mockImplementation(async () => {
      confirmations += 1
      if (confirmations === 3) guests.getActiveLease.mockReturnValue('00000000-0000-4000-8000-0000000000bb' as DesktopBrowserLeaseId)
      return true
    })
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['username', 'password'] }))
      .resolves.toEqual({ error: 'no-active-page' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('stops before the next field when the tab is hidden after one field was injected', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    const execute = vi.fn(async () => {
      confirmVisible.mockResolvedValue(false)
      return true
    })
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login', execute))
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['username', 'password'] }))
      .resolves.toEqual({ error: 'no-active-page' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('answers no-window when the main window is missing or destroyed', async () => {
    window = undefined
    await expect(handler()({ type: 'credentials-list' })).resolves.toEqual({ error: 'no-window' })
    const destroyed = { webContents: { id: 2 }, isDestroyed: () => true } as BrowserWindow
    window = destroyed
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com'))
    await expect(handler()({ type: 'credentials-list' })).resolves.toEqual({ error: 'no-window' })
  })

  it('fills approved fields and reports names only', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login'))
    const response = await handler()({ type: 'credentials-fill', credentialId: id, fields: ['username', 'password'] })
    expect(response).toEqual({ filled: ['username', 'password'], notFound: [] })
    expect(JSON.stringify(response)).not.toContain(SECRET)
    expect(dialog.showMessageBox).toHaveBeenCalledOnce()
  })

  it('classifies a refused approval as denied', async () => {
    dialog.showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login'))
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['password'] }))
      .resolves.toEqual({ error: 'denied' })
  })

  it('classifies a failed Touch ID check as denied', async () => {
    systemPreferences.canPromptTouchID.mockReturnValue(true)
    systemPreferences.promptTouchID.mockRejectedValue(new Error('cancelled'))
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login'))
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['password'] }))
      .resolves.toEqual({ error: 'denied' })
  })

  it('classifies a site change as origin-mismatch and fills nothing', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    guests.getActiveGuest.mockReturnValue(guestAt('https://attacker.example/'))
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['password'] }))
      .resolves.toEqual({ error: 'origin-mismatch' })
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('classifies unknown and malformed entry ids as not-found', async () => {
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login'))
    await expect(handler()({ type: 'credentials-fill', credentialId: 'not-a-uuid' as CredentialId, fields: ['password'] }))
      .resolves.toEqual({ error: 'not-found' })
    await expect(handler()({ type: 'credentials-fill', credentialId: randomUUID() as CredentialId, fields: ['password'] }))
      .resolves.toEqual({ error: 'not-found' })
  })

  it('never leaks a special-character password through the reply, even when the guest throws it back', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    let capturedCode = ''
    const guest = guestAt('https://example.com/login', async (_world, scripts) => {
      capturedCode = scripts[0]!.code
      return true
    })
    guests.getActiveGuest.mockReturnValue(guest)
    const filled = await handler()({ type: 'credentials-fill', credentialId: id, fields: ['password'] })
    expect(filled).toEqual({ filled: ['password'], notFound: [] })
    expect(JSON.stringify(filled)).not.toContain(SECRET)

    // A hostile page throws the injected source — secret included — back at the filler.
    const hostile = guestAt('https://example.com/login', async () => {
      throw new Error(`page exception: ${capturedCode}`)
    })
    guests.getActiveGuest.mockReturnValue(hostile)
    const failed = await handler()({ type: 'credentials-fill', credentialId: id, fields: ['password'] })
    expect(failed).toEqual({ error: 'error' })
    expect(JSON.stringify(failed)).not.toContain(SECRET)
  })

  it('reports fields without a page target as notFound', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET)
    guests.getActiveGuest.mockReturnValue(guestAt('https://example.com/login', async () => false))
    await expect(handler()({ type: 'credentials-fill', credentialId: id, fields: ['username', 'password'] }))
      .resolves.toEqual({ filled: [], notFound: ['username', 'password'] })
  })
})
