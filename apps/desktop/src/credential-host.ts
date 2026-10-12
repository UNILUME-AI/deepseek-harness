/** Answers the desktop Host's credential requests against the active Sidebar browser tab; replies carry categories, never values. */
import type { BrowserWindow, WebContents } from 'electron'
import type { CredentialEntry, CredentialId, DesktopBrowserLeaseId, FillFieldType } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { CredentialRequestError } from '@deepseek-ai/dsh-desktop-credential-tools/protocol'
import type { DesktopBrowserGuests } from './browser-guests.ts'
import type { CredentialVault } from './credential-vault.ts'
import { CredentialFillError, CredentialFiller } from './credential-fill.ts'
import { credentialOrigin } from './credential-validation.ts'

/** One validated request from the Host child process. */
export type DesktopCredentialHostRequest =
  | { readonly type: 'credentials-list' }
  | { readonly type: 'credentials-fill'; readonly credentialId: CredentialId; readonly fields: readonly FillFieldType[] }

/**
 * Failure categories safe to forward to the Host and the model; messages and values stay in this
 * process. The single source is the shared protocol module both processes import.
 */
export type CredentialRequestErrorKind = CredentialRequestError

/** Category-only reply envelope; the success arms carry metadata and field names only. */
export type DesktopCredentialHostResponse =
  | { readonly site: string; readonly entries: readonly CredentialEntry[] }
  | { readonly filled: readonly FillFieldType[]; readonly notFound: readonly FillFieldType[] }
  | { readonly error: CredentialRequestErrorKind }

/** Inputs the request handler draws from the shell. */
export interface CredentialRequestHandlerSource {
  /** Current application window; undefined before creation and after teardown. */
  readonly primary: () => BrowserWindow | undefined
  /** Active-tab owner. */
  readonly guests: Pick<DesktopBrowserGuests, 'getActiveGuest' | 'getActiveLease'>
  /**
   * Reconfirm with the renderer that the tracked tab is still visible: once before
   * answering any request, and for a fill again after approval and before every field
   * injection. The renderer's own deactivation report is the first line of defense;
   * this closes races a stale focus event or a hide during approval could reopen.
   */
  readonly confirmVisible: (owner: WebContents, lease: DesktopBrowserLeaseId) => Promise<boolean>
  /** Main-process credential store. */
  readonly vault: CredentialVault
}

/**
 * Build the handler for Host-initiated credential requests. Both operations target the most
 * recently activated Sidebar browser tab of the main window, confirm with the renderer that
 * the tab is still visible, and answer absent window or tab with explicit categories; every
 * fill still passes the approval dialog and biometric check, and after approval and before each
 * field injection re-confirms that the tracked lease is unchanged and still visible.
 * @param source - window, guest, visibility, and vault owners.
 * @returns the request handler; never throws, replies classify every failure.
 */
export function createCredentialRequestHandler(
  source: CredentialRequestHandlerSource,
): (request: DesktopCredentialHostRequest) => Promise<DesktopCredentialHostResponse> {
  return async (request) => {
    const window = source.primary()
    if (window === undefined || window.isDestroyed()) return { error: 'no-window' }
    const guest = source.guests.getActiveGuest(window.webContents)
    if (guest === undefined) return { error: 'no-active-page' }
    const lease = source.guests.getActiveLease(window.webContents)
    if (lease === undefined) return { error: 'no-active-page' }
    const stillActive = (): boolean => !window.isDestroyed()
      && source.guests.getActiveLease(window.webContents) === lease
    // The renderer confirmation is asynchronous: re-check the lease once it settles.
    const visible = async (): Promise<boolean> => stillActive()
      && await source.confirmVisible(window.webContents, lease)
      && stillActive()
    if (!await visible()) return { error: 'no-active-page' }
    try {
      if (request.type === 'credentials-list') {
        let site: string
        try {
          site = credentialOrigin(guest.getURL())
        } catch (_error) {
          // A blank or non-HTTP(S) tab has no site to match credentials against;
          // URL construction failure carries no credential material.
          return { error: 'no-active-page' }
        }
        await source.vault.load()
        return { site, entries: source.vault.list(site) }
      }
      const result = await new CredentialFiller(source.vault).fill(guest, request, window, visible)
      return { filled: result.filled, notFound: result.notFound }
    } catch (error) {
      if (error instanceof CredentialFillError) return { error: error.kind }
      return { error: 'error' }
    }
  }
}
