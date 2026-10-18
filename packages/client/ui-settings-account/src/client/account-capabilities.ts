/** Account-provider capabilities with defaults for existing providers. */
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'

/**
 * @param view - latest account state, absent while loading.
 * @returns whether wallet queries and controls are supported; omission preserves wallet support.
 */
export function supportsAccountWallet(view: AccountView | undefined): boolean {
  return view?.capabilities?.wallet !== false
}
