/** Pre-fill confirmation channel asking the renderer whether the tracked tab is still visible. */
import type { WebContents } from 'electron'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { DESKTOP_IPC } from './ipc.ts'

/** Main-process event registry face the confirmation channel subscribes with; `ipcMain` satisfies it. */
export interface VisibilityAnswerListener {
  /** @param channel - event channel name. @param listener - inbound answer consumer. */
  on(channel: string, listener: (event: { readonly sender: WebContents; readonly senderFrame: unknown }, answer: unknown) => void): unknown
}

/** A renderer that does not answer within this window counts as invisible; the fill is refused. */
export const VISIBILITY_CONFIRM_TIMEOUT_MS = 1_000

/**
 * Correlated main-to-renderer visibility queries. The renderer mirrors the leases
 * it last reported visible, so an unanswered, malformed, or foreign answer always
 * resolves `false` — an invisible tab can never pass as a fill target.
 */
export class RendererVisibility {
  private nextId = 1
  private readonly pending = new Map<number, {
    readonly owner: WebContents
    readonly timer: ReturnType<typeof setTimeout>
    readonly resolve: (visible: boolean) => void
  }>()

  /** @param ipc - main-process event registry owning the answer channel. */
  constructor(ipc: VisibilityAnswerListener) {
    ipc.on(DESKTOP_IPC.browserVisibilityAnswer, (event, answer: unknown) => {
      if (typeof answer !== 'object' || answer === null || !('requestId' in answer)
        || typeof answer.requestId !== 'number' || !Number.isSafeInteger(answer.requestId)
        || !('visible' in answer) || typeof answer.visible !== 'boolean') return
      const request = this.pending.get(answer.requestId)
      // Only the window the query went out to may answer it.
      if (request === undefined || event.sender !== request.owner || event.senderFrame === null
        || event.senderFrame !== request.owner.mainFrame) return
      this.pending.delete(answer.requestId)
      clearTimeout(request.timer)
      request.resolve(answer.visible)
    })
  }

  /**
   * Ask one window's renderer whether the lease it reported active is still visible.
   * @param owner - primary application WebContents the query is scoped to.
   * @param lease - tracked active lease.
   * @returns the renderer's answer, or false when the channel, window, or answer is gone.
   */
  confirm(owner: WebContents, lease: DesktopBrowserLeaseId): Promise<boolean> {
    if (owner.isDestroyed()) return Promise.resolve(false)
    const requestId = this.nextId++
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        resolve(false)
      }, VISIBILITY_CONFIRM_TIMEOUT_MS)
      timer.unref()
      this.pending.set(requestId, { owner, timer, resolve })
      try {
        owner.send(DESKTOP_IPC.browserVisibilityQuery, { requestId, lease })
      } catch (_error) {
        // A destroyed or tearing-down WebContents rejects the send; treat as invisible.
        this.pending.delete(requestId)
        clearTimeout(timer)
        resolve(false)
      }
    })
  }

  /** Settle every outstanding query as invisible; the confirmation channel is single-lifetime. */
  dispose(): void {
    for (const [, request] of this.pending) {
      clearTimeout(request.timer)
      request.resolve(false)
    }
    this.pending.clear()
  }
}
