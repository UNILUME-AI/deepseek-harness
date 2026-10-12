// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebSource } from 'electron'
import { CredentialVault } from '../src/credential-vault.ts'
import { CredentialFiller } from '../src/credential-fill.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const electronMock = vi.hoisted(() => ({
  dialog: { showMessageBox: vi.fn() },
  systemPreferences: { canPromptTouchID: vi.fn(), promptTouchID: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: (value: string) => Buffer.from(value),
    decryptString: vi.fn((value: Buffer) => value.toString()) },
}))
vi.mock('electron', () => electronMock)
const { dialog, safeStorage, systemPreferences } = electronMock

let directory: string
let vault: CredentialVault
const mainWindow = {} as BrowserWindow
const guest = { getURL: vi.fn(), executeJavaScriptInIsolatedWorld: vi.fn() }

beforeEach(async () => {
  vi.resetAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'keychain-fill-'))
  vault = new CredentialVault(directory)
  window.history.replaceState({}, '', '/login')
  guest.getURL.mockReturnValue(window.location.href)
  vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false })
  vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(false)
  vi.mocked(safeStorage.decryptString).mockImplementation(value => value.toString())
  guest.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world: number, scripts: WebSource[]) => {
    // Execute the exact emitted JavaScript against DOM fixtures, without testing a second field-finder implementation.
    const result: unknown = window.eval(scripts[0]?.code ?? '')
    return result
  })
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    const rects = this.hidden ? [] : [new DOMRect(0, 0, 100, 24)]
    return Object.assign(rects, { item: (index: number) => rects[index] ?? null })
  })
})
afterEach(async () => { vi.restoreAllMocks(); document.body.innerHTML = ''; await rm(directory, { recursive: true, force: true }) })

async function fill(password = 'fixture-password', username = 'seller@example.com') {
  const credentialId = await vault.add(window.location.origin, '卖家账号', username, password)
  return new CredentialFiller(vault).fill(guest, { credentialId, fields: ['username', 'password'] }, mainWindow)
}

function input(id: string): HTMLInputElement { return document.getElementById(id) as HTMLInputElement }

describe('credential fill security', () => {
  it('fills the stored username before the first visible password and fires events without submitting', async () => {
    document.body.innerHTML = '<form><input id="decoy"><input id="user" type="email"><input type="password" hidden>'
      + '<input id="password" type="password"><input id="after"></form>'
    const changed = vi.fn(); const submitted = vi.fn()
    document.addEventListener('input', changed, { once: true })
    document.querySelector('form')?.addEventListener('submit', submitted)
    const result = await fill()
    expect(input('user').value).toBe('seller@example.com')
    expect(input('password').value).toBe('fixture-password')
    expect(input('after').value).toBe('')
    expect(input('decoy').value).toBe('')
    expect(changed).toHaveBeenCalledOnce()
    expect(submitted).not.toHaveBeenCalled()
    expect(result).toEqual({ filled: ['username', 'password'], notFound: [] })
    for (const [world] of guest.executeJavaScriptInIsolatedWorld.mock.calls) {
      expect(world).toBe(1001); expect(world).not.toBe(0); expect(world).not.toBe(999)
    }
  })

  it.each(['quotes"and\\slashes', 'line1\nline2\r\nline3', 'separator\u2028paragraph\u2029', '");globalThis.injected=true;//'])
  ('safely encodes a password containing special characters: %j', async (password) => {
    document.body.innerHTML = '<form><input autocomplete="username" id="user"><input id="password" type="password"></form>'
    const result = await fill(password)
    // HTML input values strip CR/LF even when assigned verbatim by JavaScript.
    expect(input('password').value).toBe(password.replace(/[\r\n]/g, ''))
    expect(Reflect.get(window, 'injected')).toBeUndefined()
    expect(result).toEqual({ filled: ['username', 'password'], notFound: [] })
    expect(JSON.stringify(result)).not.toContain(password)
  })

  it('finds autocomplete username without a password field and prefers one-time-code over name heuristics', async () => {
    document.body.innerHTML = '<input id="user" autocomplete="username"><input id="code"><input id="otp" autocomplete="one-time-code">'
    const credentialId = await vault.add(window.location.origin, 'Site', 'actual-seller', 'pw', 'JBSWY3DPEHPK3PXP')
    const result = await new CredentialFiller(vault).fill(guest, { credentialId, fields: ['username', 'password', 'totp'] }, mainWindow)
    expect(input('user').value).toBe('actual-seller')
    expect(input('otp').value).toMatch(/^\d{6}$/)
    expect(input('code').value).toBe('')
    expect(result).toEqual({ filled: ['username', 'totp'], notFound: ['password'] })
  })

  it.each(['otp', 'code', 'totp', '验证码', '校验码'])('finds a visible %s hint and ignores hidden OTP inputs', async (hint) => {
    document.body.innerHTML = `<input hidden autocomplete="one-time-code"><input id="target" placeholder="${hint}">`
    const credentialId = await vault.add(window.location.origin, 'Site', 'user', 'pw', 'JBSWY3DPEHPK3PXP')
    const result = await new CredentialFiller(vault).fill(guest, { credentialId, fields: ['totp'] }, mainWindow)
    expect(input('target').value).toMatch(/^\d{6}$/)
    expect(result).toEqual({ filled: ['totp'], notFound: [] })
  })

  it('rejects a changed origin after approval before decrypting', async () => {
    guest.getURL.mockReturnValueOnce(window.location.href).mockReturnValue('https://changed.example/')
    await expect(fill()).rejects.toThrow('Origin mismatch')
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('checks origin inside the injected script as well', async () => {
    guest.getURL.mockReturnValue('https://expected.example/login')
    document.body.innerHTML = '<input type="password" id="password">'
    const credentialId = await vault.add('https://expected.example', 'Site', 'user', 'pw')
    expect(await new CredentialFiller(vault).fill(guest, { credentialId, fields: ['password'] }, mainWindow))
      .toEqual({ filled: [], notFound: ['password'] })
    expect(input('password').value).toBe('')
  })

  it('denial never decrypts, injects or prompts for Touch ID', async () => {
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false })
    await expect(fill()).rejects.toThrow('not approved')
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
    expect(systemPreferences.promptTouchID).not.toHaveBeenCalled()
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('requires Touch ID after the Chinese approval dialog on supported Macs', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    vi.mocked(systemPreferences.canPromptTouchID).mockReturnValue(true)
    vi.mocked(systemPreferences.promptTouchID).mockRejectedValue(new Error('cancelled'))
    await expect(fill()).rejects.toThrow('触控 ID')
    expect(dialog.showMessageBox).toHaveBeenCalledWith(mainWindow, expect.objectContaining({ title: '批准填入凭据', defaultId: 1 }))
    expect(systemPreferences.promptTouchID).toHaveBeenCalledWith(expect.stringContaining('批准'))
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled()
  })

  it('discards guest errors that might include secrets', async () => {
    guest.executeJavaScriptInIsolatedWorld.mockRejectedValue(new Error('fixture-password'))
    const log = vi.spyOn(console, 'error')
    await expect(fill()).rejects.toThrow('凭据填写失败')
    expect(log).not.toHaveBeenCalled()
  })
})
