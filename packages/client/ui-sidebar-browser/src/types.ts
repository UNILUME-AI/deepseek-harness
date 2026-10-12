/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, site-scoped persistent storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Main-issued credential identity. */
export type CredentialId = Branded<'CredentialId'>

/** Credential metadata exposed to UI. */
export interface CredentialEntry {
  readonly id: CredentialId
  readonly origin: string
  readonly label: string
  readonly username: string
  readonly hasTotp: boolean
}

/** Credential fill request scoped to guest and approved fields. */
export type FillFieldType = 'username' | 'password' | 'totp'

/** User-selected fields for a main-owned browser lease. */
export interface CredentialFillRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly credentialId: CredentialId
  readonly fields: readonly FillFieldType[]
}

/** Field names only; values never leave the main process via IPC. */
export interface CredentialFillResult {
  readonly filled: FillFieldType[]
  readonly notFound: FillFieldType[]
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /**
   * @param siteUrl - HTTP(S) navigation target whose normalized origin scopes the persistent storage partition.
   * @returns one approved guest reservation.
   */
  acquire(siteUrl: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - the guest the renderer just made the active browser tab. */
  reportActive(lease: DesktopBrowserLeaseId): void
  /** @param lease - a previously reported guest whose tab is no longer visible. */
  reportInactive(lease: DesktopBrowserLeaseId): void
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
  /**
   * @param lease - live reservation whose partition is erased; every guest in that partition is closed first.
   * @returns after storage cleanup.
   */
  clearSite(lease: DesktopBrowserLeaseId): Promise<void>
  /** @returns after the stored data of every sidebar site partition is erased and their guests are closed. */
  clearAllSites(): Promise<void>
}

/** Desktop-only credential operations, unavailable to guest pages and the Web iframe. */
export interface DesktopCredentialsBridge {
  /** @param origin - optional HTTP(S) filter. @returns metadata without decrypting secrets. */
  list(origin?: string): Promise<CredentialEntry[]>
  /**
   * @param origin - HTTP(S) site. @param label - display name. @param username - login name.
   * @param password - encrypted once received. @param totpSecret - optional base32 or otpauth value.
   * @returns saved entry ID; rejects when system encryption is unavailable.
   */
  add(origin: string, label: string, username: string, password: string, totpSecret?: string): Promise<CredentialId>
  /** @param id - entry to delete. @returns after persistence. */
  remove(id: CredentialId): Promise<void>
  /** @param request - lease, entry and fields. @returns field names after native approval; never submits the form. */
  fill(request: CredentialFillRequest): Promise<CredentialFillResult>
}

/** UI operations bound to a live browser provider; the provider supplies its own lease. */
export interface BrowserCredentials extends Omit<DesktopCredentialsBridge, 'fill'> {
  /** @param id - entry to fill. @param fields - user selection. @returns names filled or not found. */
  fill(id: CredentialId, fields: readonly FillFieldType[]): Promise<CredentialFillResult>
  /** Mark this page's guest as the main window's active browser tab; no-ops until its lease exists. */
  reportActive(): void
  /** Withdraw the active report while this page's tab is hidden; no-ops until its lease exists. */
  reportInactive(): void
}
