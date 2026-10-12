/** Credential IPC accepts only the application's primary document and validated, bounded inputs. */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserGuests } from './browser-guests.ts'
import type { CredentialVault } from './credential-vault.ts'
import { CredentialFiller } from './credential-fill.ts'
import { credentialFields, credentialId, credentialOrigin, credentialText } from './credential-validation.ts'
import { DESKTOP_IPC, assertDesktopSender } from './ipc.ts'

/**
 * @param ipc - main-process handler registry. @param primary - current application window.
 * @param guests - lease owner. @param vault - main-process storage.
 */
export function registerCredentialHandlers(ipc: Pick<IpcMain, 'handle'>, primary: () => BrowserWindow | undefined,
  guests: Pick<DesktopBrowserGuests, 'getGuest'>, vault: CredentialVault): void {
  const authorize = (event: IpcMainInvokeEvent): BrowserWindow => {
    assertDesktopSender(event, ['app'])
    const window = primary()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) throw new Error('Rejected credential IPC caller')
    return window
  }
  ipc.handle(DESKTOP_IPC.credentialsList, async (event, origin: unknown) => {
    authorize(event)
    const filter = origin === undefined ? undefined : credentialOrigin(origin)
    await vault.load()
    return vault.list(filter)
  })
  ipc.handle(DESKTOP_IPC.credentialsAdd, async (event, origin: unknown, label: unknown,
    username: unknown, password: unknown, totpSecret: unknown) => {
    authorize(event)
    return vault.add(credentialOrigin(origin), credentialText(label, 256), credentialText(username, 1024, true),
      credentialText(password, 16384), totpSecret === undefined ? undefined : credentialText(totpSecret, 4096, true))
  })
  ipc.handle(DESKTOP_IPC.credentialsRemove, async (event, id: unknown) => {
    authorize(event)
    await vault.remove(credentialId(id))
  })
  ipc.handle(DESKTOP_IPC.credentialsFill, async (event, request: unknown) => {
    const window = authorize(event)
    if (typeof request !== 'object' || request === null || !('lease' in request)
      || !('credentialId' in request) || !('fields' in request)) throw new Error('Invalid fill request')
    const lease = credentialId(request.lease)
    const id = credentialId(request.credentialId)
    const fields = credentialFields(request.fields)
    const guest = guests.getGuest(event.sender, lease)
    if (guest === undefined) throw new Error('Guest not available')
    return new CredentialFiller(vault).fill(guest, { credentialId: id, fields }, window)
  })
}
