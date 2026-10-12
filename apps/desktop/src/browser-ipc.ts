/** Sidebar browser IPC accepts only the application's primary document, validated site URLs and leases. */
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import type { DesktopBrowserGuests } from './browser-guests.ts'
import { DESKTOP_IPC, assertPrimarySender } from './ipc.ts'

/**
 * @param ipc - main-process handler registry. @param primary - current application window.
 * @param guests - lease owner, site partitions and clearing.
 */
export function registerBrowserHandlers(ipc: Pick<IpcMain, 'handle'>, primary: () => BrowserWindow | undefined,
  guests: DesktopBrowserGuests): void {
  const authorize = (event: IpcMainInvokeEvent): BrowserWindow => assertPrimarySender(event, primary)
  ipc.handle(DESKTOP_IPC.browserAcquire, async (event, siteUrl: unknown) => {
    authorize(event)
    return guests.acquire(event.sender, siteUrl)
  })
  ipc.handle(DESKTOP_IPC.browserRelease, async (event, lease: unknown) => {
    authorize(event)
    return guests.release(event.sender, lease)
  })
  ipc.handle(DESKTOP_IPC.browserClearSite, async (event, lease: unknown) => {
    authorize(event)
    return guests.clearSite(event.sender, lease)
  })
  ipc.handle(DESKTOP_IPC.browserClearAllSites, async (event) => {
    authorize(event)
    return guests.clearAllSites(event.sender)
  })
}
