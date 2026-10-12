/** Validation for credential IPC and on-disk metadata; errors never include submitted values. */
import type { CredentialId, FillFieldType } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

/** @param value - untrusted text. @param max - length limit. @param empty - whether empty is allowed. @returns bounded text. */
export function credentialText(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && value.length === 0)) {
    throw new Error('Invalid credential text')
  }
  return value
}

/** @param value - site URL received from IPC or disk. @returns normalized HTTP(S) origin, rejecting URL credentials. */
export function credentialOrigin(value: unknown): string {
  const text = credentialText(value, 2048)
  let url: URL
  try { url = new URL(text) } catch (_error) { throw new Error('Invalid credential origin') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid credential origin')
  return url.origin
}

/** @param value - untrusted identifier. @returns validated UUID. */
export function credentialId(value: unknown): CredentialId {
  if (typeof value !== 'string' || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) {
    throw new Error('Invalid credential ID')
  }
  return value as CredentialId
}

/** @param value - untrusted selection. @returns nonempty, unique selection of at most three fields. */
export function credentialFields(value: unknown): FillFieldType[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) throw new Error('Invalid credential fields')
  const fields: FillFieldType[] = []
  const selected: unknown[] = value
  for (const field of selected) {
    if (field !== 'username' && field !== 'password' && field !== 'totp') throw new Error('Invalid credential field')
    if (fields.includes(field)) throw new Error('Duplicate credential field')
    fields.push(field)
  }
  return fields
}
