/**
 * Wire vocabulary of the Desktop credential channel between the Electron shell
 * (main process) and its Host (Node child process). Responses carry categories
 * only: no credential value, page content, or free-form shell diagnostic ever
 * crosses into the Host, so the model-facing tools built on top cannot leak a
 * secret they never receive.
 * @module @deepseek-ai/dsh-desktop-credential-tools/protocol
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/**
 * Opaque credential entry id crossing the Host↔shell channel; structurally a
 * UUID string on the wire, identical to the shell-side `CredentialId` brand.
 */
export type CredentialId = Branded<'CredentialId'>

/**
 * Adopt an entry id string as the opaque wire identity without validating it.
 * @param value - unvalidated id text; the shell checks it against its credential vault entries and answers `not-found` for an unknown id.
 * @returns the same string branded for cross-boundary use.
 */
export function credentialId(value: string): CredentialId {
  return value as CredentialId
}

/** Fields a fill request may name; a subset per call. */
export const CREDENTIAL_FILL_FIELDS = ['username', 'password', 'totp'] as const

/** One fillable credential field. */
export type CredentialFillField = (typeof CREDENTIAL_FILL_FIELDS)[number]

/** Credential metadata the shell may send; secrets are structurally absent. */
export interface CredentialEntryMeta {
  readonly id: CredentialId
  readonly origin: string
  readonly label: string
  readonly username: string
  readonly hasTotp: boolean
}

/**
 * Every failure the shell reports as a bare category. `unavailable` covers a
 * missing or shutting-down Host channel; `no-window` a missing or destroyed
 * main window; `no-active-page` the absence of a recently active Sidebar
 * browser tab; `not-found` an unknown entry id; `origin-mismatch` a page whose
 * site no longer matches the entry; `denied` a refused approval or failed
 * biometric check; `error` any remaining shell-side failure.
 */
export type CredentialRequestError =
  | 'unavailable'
  | 'no-window'
  | 'no-active-page'
  | 'not-found'
  | 'origin-mismatch'
  | 'denied'
  | 'error'

/** Host-initiated list request: metadata for the active page's site. */
export interface CredentialListRequestMessage {
  readonly type: 'credentials-list'
  readonly requestId: number
}

/** Host-initiated fill request: entry reference and field subset, never values. */
export interface CredentialFillRequestMessage {
  readonly type: 'credentials-fill'
  readonly requestId: number
  readonly credentialId: CredentialId
  readonly fields: readonly CredentialFillField[]
}

/** Request envelope crossing from Host to shell. */
export type CredentialRequestMessage = CredentialListRequestMessage | CredentialFillRequestMessage

/** Shell answer to a list request. */
export type CredentialListResponseMessage = {
  readonly type: 'credentials-list'
  readonly requestId: number
  readonly site: string
  readonly entries: readonly CredentialEntryMeta[]
} | {
  readonly type: 'credentials-list'
  readonly requestId: number
  readonly error: CredentialRequestError
}

/** Shell answer to a fill request: per-field outcome or one category. */
export type CredentialFillResponseMessage = {
  readonly type: 'credentials-fill'
  readonly requestId: number
  readonly filled: readonly CredentialFillField[]
  readonly notFound: readonly CredentialFillField[]
} | {
  readonly type: 'credentials-fill'
  readonly requestId: number
  readonly error: CredentialRequestError
}

/** Response envelope crossing from shell to Host. */
export type CredentialResponseMessage = CredentialListResponseMessage | CredentialFillResponseMessage

/** In-process result of {@link DesktopCredentialBridge.list}. */
export type CredentialListResult =
  | { readonly ok: true; readonly site: string; readonly entries: readonly CredentialEntryMeta[] }
  | { readonly ok: false; readonly error: CredentialRequestError }

/** In-process result of {@link DesktopCredentialBridge.fill}. */
export type CredentialFillResult =
  | { readonly ok: true; readonly filled: readonly CredentialFillField[]; readonly notFound: readonly CredentialFillField[] }
  | { readonly ok: false; readonly error: CredentialRequestError }
