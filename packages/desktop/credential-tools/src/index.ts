/**
 * Desktop-only plugin bridging the model to the Electron credential vault:
 * `credentials_list` returns site-matched entry metadata, `credentials_fill`
 * requests an approval-gated, isolated-world fill. The plugin runs in the
 * desktop Host child process and reaches the shell over Node IPC; vault
 * access, approval, and filling all stay in the main process, so no secret is
 * ever present in this process. Loaded only by the Desktop profile (the
 * web-app bundle row disables it elsewhere), never by the Web composition.
 * @module @deepseek-ai/dsh-desktop-credential-tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { DesktopCredentialBridge, processBridgePort } from './bridge.ts'
import { createCredentialTools } from './tools.ts'

export { DesktopCredentialBridge, processBridgePort, type CredentialBridgePort, type ProcessLike } from './bridge.ts'
export { createCredentialTools, CREDENTIALS_FILL_TOOL, CREDENTIALS_LIST_TOOL, type CredentialToolBridge } from './tools.ts'
export type {
  CredentialEntryMeta,
  CredentialFillField,
  CredentialFillResult,
  CredentialListResult,
  CredentialRequestError,
} from './protocol.ts'

/** Loader identity for the desktop credential tools. */
export const name = 'desktop-credential-tools'
export const inject = ['tools']

/**
 * Register both credential tools against the shell channel of the current
 * desktop Host process. The registration is an effect: plugin disposal
 * unregisters the tools and settles every pending request as `unavailable`.
 * @param ctx - Desktop profile scope carrying the tool registry.
 */
export function apply(ctx: Context): void {
  const bridge = new DesktopCredentialBridge(processBridgePort(process))
  ctx.effect(() => {
    const disposeTools = createCredentialTools(bridge).map(tool => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposeTools) dispose()
      bridge.dispose()
    }
  }, 'desktop-credential-tools: tools')
}
