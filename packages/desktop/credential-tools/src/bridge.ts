/**
 * Host-side requestor for the Desktop credential channel: correlates requests
 * over the child-process IPC port, validates every inbound response at this
 * wire boundary, and degrades to the `unavailable` category when the shell
 * channel is gone. Secrets are unrepresentable here by protocol design.
 * @module @deepseek-ai/dsh-desktop-credential-tools/bridge
 */

import type {
  CredentialEntryMeta,
  CredentialFillField,
  CredentialFillResult,
  CredentialId,
  CredentialListResult,
  CredentialRequestError,
  CredentialRequestMessage,
} from './protocol.ts'

/**
 * The child-process IPC face the bridge needs; the production adapter is the
 * desktop Host's own `process`. Tests substitute a fake.
 */
export interface CredentialBridgePort {
  /** Whether the shell channel is currently open. */
  readonly connected: boolean
  /**
   * Transmit one request; throws synchronously when the channel is gone.
   * @param message - validated request envelope.
   */
  send(message: CredentialRequestMessage): void
  /**
   * Subscribe to every inbound IPC message.
   * @param listener - receives unvalidated messages; the bridge validates.
   * @returns unsubscribe callback.
   */
  onMessage(listener: (message: unknown) => void): () => void
  /**
   * Subscribe to channel teardown.
   * @param listener - invoked once the shell disconnects.
   * @returns unsubscribe callback.
   */
  onDisconnect(listener: () => void): () => void
}

/**
 * The Node child-process face {@link processBridgePort} needs; `process` satisfies it directly,
 * and tests implement it without casts.
 */
export interface ProcessLike {
  /** Whether the IPC channel to the parent is open. */
  readonly connected: boolean
  /**
   * Send one message to the parent; absent when the process has no IPC channel.
   * @param message - request envelope.
   * @param callback - completion; a non-null error means the channel failed.
   */
  send?(message: CredentialRequestMessage, callback: (error: Error | null) => void): void
  /** @param type - event name. @param listener - subscriber. */
  on(type: 'message', listener: (message: unknown) => void): void
  /** @param type - event name. @param listener - subscriber. */
  on(type: 'disconnect', listener: () => void): void
  /** @param type - event name. @param listener - subscriber to remove. */
  off(type: 'message', listener: (message: unknown) => void): void
  /** @param type - event name. @param listener - subscriber to remove. */
  off(type: 'disconnect', listener: () => void): void
}

/**
 * Adapt the Host child process to {@link CredentialBridgePort}.
 * @param process_ - the desktop Host's own Node process.
 * @returns the live port.
 */
export function processBridgePort(process_: ProcessLike): CredentialBridgePort {
  return {
    get connected() { return process_.connected },
    send(message) {
      if (!process_.connected || process_.send === undefined) throw new Error('desktop credential bridge: no IPC channel')
      process_.send(message, (error) => { if (error !== null) console.error('desktop credential bridge: send failed', error) })
    },
    onMessage(listener) {
      process_.on('message', listener)
      return () => { process_.off('message', listener) }
    },
    onDisconnect(listener) {
      process_.on('disconnect', listener)
      return () => { process_.off('disconnect', listener) }
    },
  }
}

/**
 * Every wire category with its parse rule; `satisfies` fails to compile when the
 * protocol adds a category this table has not classified, so a new shell failure
 * can never silently degrade to `error` here.
 */
const REQUEST_ERRORS: Record<CredentialRequestError, CredentialRequestError> = {
  unavailable: 'unavailable',
  'no-window': 'no-window',
  'no-active-page': 'no-active-page',
  'not-found': 'not-found',
  'origin-mismatch': 'origin-mismatch',
  denied: 'denied',
  error: 'error',
}

function isEntryMeta(value: unknown): value is CredentialEntryMeta {
  return typeof value === 'object' && value !== null
    && 'id' in value && typeof value.id === 'string'
    && 'origin' in value && typeof value.origin === 'string'
    && 'label' in value && typeof value.label === 'string'
    && 'username' in value && typeof value.username === 'string'
    && 'hasTotp' in value && typeof value.hasTotp === 'boolean'
}

function isField(value: unknown): value is CredentialFillField {
  return value === 'username' || value === 'password' || value === 'totp'
}

interface PendingRequest {
  readonly settle: (result: CredentialListResult | CredentialFillResult) => void
}

/** A request without its correlation id; the bridge assigns ids. */
type PendingRequestMessage =
  | { readonly type: 'credentials-list' }
  | { readonly type: 'credentials-fill'; readonly credentialId: CredentialId; readonly fields: readonly CredentialFillField[] }

/** Narrow one inbound IPC message to a credential response candidate worth validating. */
function isResponseCandidate(message: unknown):
  message is { readonly type: 'credentials-list' | 'credentials-fill'; readonly requestId: number } & Record<string, unknown> {
  if (typeof message !== 'object' || message === null || !('type' in message) || !('requestId' in message)) return false
  if (message.type !== 'credentials-list' && message.type !== 'credentials-fill') return false
  return typeof message.requestId === 'number' && Number.isSafeInteger(message.requestId)
}

/** One outstanding request per id; responses settle exactly once, late answers dropped. */
export class DesktopCredentialBridge {
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly unsubscribeMessage: () => void
  private readonly unsubscribeDisconnect: () => void
  private disposed = false

  /** @param port - child-process IPC endpoint. */
  constructor(private readonly port: CredentialBridgePort) {
    this.unsubscribeMessage = port.onMessage((message) => { this.onMessage(message) })
    this.unsubscribeDisconnect = port.onDisconnect(() => { this.disconnect() })
  }

  /**
   * List credential metadata for the active page's site.
   * @param signal - cooperative cancellation; abort settles locally while the shell proceeds unaware.
   * @returns site and entry metadata, or one error category.
   */
  list(signal?: AbortSignal): Promise<CredentialListResult> {
    return this.request({ type: 'credentials-list' }, signal) as Promise<CredentialListResult>
  }

  /**
   * Request an approval-gated fill into the active page.
   * @param credentialId - entry id from a prior {@link list}.
   * @param fields - non-empty subset of fillable fields.
   * @param signal - cooperative cancellation; abort settles locally while the shell proceeds unaware.
   * @returns per-field outcome, or one error category.
   */
  fill(credentialId: CredentialId, fields: readonly CredentialFillField[], signal?: AbortSignal): Promise<CredentialFillResult> {
    return this.request({ type: 'credentials-fill', credentialId, fields }, signal) as Promise<CredentialFillResult>
  }

  /** Reject every pending request and stop listening; the bridge is single-lifetime. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeMessage()
    this.unsubscribeDisconnect()
    this.disconnect()
  }

  private disconnect(): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const request of pending) request.settle({ ok: false, error: 'unavailable' })
  }

  private request(message: PendingRequestMessage,
    signal?: AbortSignal): Promise<CredentialListResult | CredentialFillResult> {
    if (this.disposed || !this.port.connected) {
      return Promise.resolve({ ok: false, error: 'unavailable' })
    }
    const requestId = this.nextId++
    return new Promise((resolve) => {
      const pending: PendingRequest = { settle: resolve }
      this.pending.set(requestId, pending)
      const abort = (): void => {
        if (this.pending.delete(requestId)) resolve({ ok: false, error: 'unavailable' })
      }
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.port.send({ ...message, requestId })
      } catch {
        abort()
      }
    })
  }

  private onMessage(message: unknown): void {
    if (!isResponseCandidate(message)) return
    const pending = this.pending.get(message.requestId)
    if (pending === undefined) return
    this.pending.delete(message.requestId)
    pending.settle(this.parse(message))
  }

  private parse(message: { readonly type: 'credentials-list' | 'credentials-fill' } & Record<string, unknown>)
    : CredentialListResult | CredentialFillResult {
    if ('error' in message) {
      if (typeof message.error === 'string' && Object.hasOwn(REQUEST_ERRORS, message.error)) {
        return { ok: false, error: message.error as CredentialRequestError }
      }
      return { ok: false, error: 'error' }
    }
    if (message.type === 'credentials-list') {
      if (typeof message.site === 'string' && Array.isArray(message.entries) && message.entries.every(isEntryMeta)) {
        return { ok: true, site: message.site, entries: message.entries }
      }
      return { ok: false, error: 'error' }
    }
    if (Array.isArray(message.filled) && message.filled.every(isField)
      && Array.isArray(message.notFound) && message.notFound.every(isField)) {
      return { ok: true, filled: message.filled, notFound: message.notFound }
    }
    return { ok: false, error: 'error' }
  }
}
