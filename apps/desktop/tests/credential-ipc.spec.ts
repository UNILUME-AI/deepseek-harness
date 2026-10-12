import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { registerCredentialHandlers } from '../src/credential-ipc.ts'
import { CredentialVault } from '../src/credential-vault.ts'
import { DESKTOP_IPC, SCHEME } from '../src/ipc.ts'

const electronMock = vi.hoisted(() => ({
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
  systemPreferences: { canPromptTouchID: () => false },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (text: string) => Buffer.from(text),
    decryptString: (text: Buffer) => text.toString() },
}))
vi.mock('electron', () => electronMock)
const { dialog } = electronMock
const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()
const sender = { mainFrame: { url: `${SCHEME}://app/index.html` } } as WebContents
const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent
const window = { webContents: sender, isDestroyed: () => false } as BrowserWindow
const guestMethods: Pick<WebContents, 'getURL' | 'executeJavaScriptInIsolatedWorld'> = {
  getURL: () => 'https://example.com/login', executeJavaScriptInIsolatedWorld: vi.fn(async () => true),
}
const guest = guestMethods as WebContents
const guests = { getGuest: vi.fn(() => guest) }
const lease = '00000000-0000-4000-8000-000000000001'
let directory: string

async function call(channel: string, caller: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error('Handler missing')
  return handler(caller, ...args)
}
beforeEach(async () => {
  vi.clearAllMocks(); handlers.clear()
  directory = await mkdtemp(join(tmpdir(), 'keychain-ipc-'))
  registerCredentialHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } },
    () => window, guests, new CredentialVault(directory))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('credential IPC', () => {
  it.each([DESKTOP_IPC.credentialsList, DESKTOP_IPC.credentialsAdd, DESKTOP_IPC.credentialsRemove, DESKTOP_IPC.credentialsFill])
  ('rejects guests, foreign windows, subframes and missing sender frames for %s', async (channel) => {
    for (const caller of [
      { sender, senderFrame: { url: 'https://example.com' } },
      { sender: {}, senderFrame: sender.mainFrame },
      { sender, senderFrame: { url: `${SCHEME}://app/subframe` } },
      { sender, senderFrame: null },
    ]) await expect(call(channel, caller as IpcMainInvokeEvent)).rejects.toThrow()
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
    expect(guests.getGuest).not.toHaveBeenCalled()
  })

  it.each([null, 42, '', 'file:///tmp/site', 'javascript:alert(1)', 'https://user:pass@example.com', 'x'.repeat(2049)])
  ('rejects invalid list origins (%s)', async (origin) => {
    await expect(call(DESKTOP_IPC.credentialsList, event, origin)).rejects.toThrow()
  })

  it.each([
    [null, 'label', 'user', 'pw'], ['https://example.com', '', 'user', 'pw'],
    ['https://example.com', 'x'.repeat(257), 'user', 'pw'], ['https://example.com', 'label', 1, 'pw'],
    ['https://example.com', 'label', 'x'.repeat(1025), 'pw'], ['https://example.com', 'label', 'user', ''],
    ['https://example.com', 'label', 'user', 'x'.repeat(16385)], ['https://example.com', 'label', 'user', 'pw', 1],
    ['https://example.com', 'label', 'user', 'pw', 'x'.repeat(4097)],
    ['https://example.com', 'label', 'user', 'pw', 'otpauth://totp/a?secret=ABC&digits=NaN'],
  ])('rejects invalid add fields %#', async (...args) => {
    await expect(call(DESKTOP_IPC.credentialsAdd, event, ...args)).rejects.toThrow()
    expect(await call(DESKTOP_IPC.credentialsList, event)).toEqual([])
  })

  it.each([null, {}, { lease, credentialId: lease, fields: [] }, { lease: 1, credentialId: lease, fields: ['password'] },
    { lease, credentialId: 'x'.repeat(100), fields: ['password'] }, { lease, credentialId: lease, fields: ['other'] },
    { lease, credentialId: lease, fields: ['password', 'password'] }, { lease, credentialId: lease, fields: new Array(4).fill('password') }])
  ('rejects invalid fill request %#', async (request) => {
    await expect(call(DESKTOP_IPC.credentialsFill, event, request)).rejects.toThrow()
    expect(guests.getGuest).not.toHaveBeenCalled()
  })

  it.each([null, 1, '', 'x'.repeat(100)])('rejects invalid remove IDs %#', async (id) => {
    await expect(call(DESKTOP_IPC.credentialsRemove, event, id)).rejects.toThrow()
  })

  it('adds, filters, fills using the caller lease and removes without returning secrets', async () => {
    const id = await call(DESKTOP_IPC.credentialsAdd, event, 'https://example.com/path', 'Seller', 'alice', 'fixture-password')
    expect(await call(DESKTOP_IPC.credentialsList, event, 'https://example.com')).toEqual([
      { id, origin: 'https://example.com', label: 'Seller', username: 'alice', hasTotp: false },
    ])
    expect(await call(DESKTOP_IPC.credentialsList, event, 'https://other.example')).toEqual([])
    expect(await call(DESKTOP_IPC.credentialsFill, event, { lease, credentialId: id, fields: ['username', 'password'] }))
      .toEqual({ filled: ['username', 'password'], notFound: [] })
    expect(guests.getGuest).toHaveBeenCalledWith(sender, lease)
    await call(DESKTOP_IPC.credentialsRemove, event, id)
    expect(await call(DESKTOP_IPC.credentialsList, event)).toEqual([])
  })

  it('rejects unavailable leases before prompting', async () => {
    const lookup = { getGuest: vi.fn(() => undefined) }
    registerCredentialHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } },
      () => window, lookup, new CredentialVault(directory))
    await expect(call(DESKTOP_IPC.credentialsFill, event, { lease, credentialId: lease, fields: ['password'] }))
      .rejects.toThrow('Guest not available')
    expect(dialog.showMessageBox).not.toHaveBeenCalled()
  })
})
