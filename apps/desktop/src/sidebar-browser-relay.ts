/**
 * Extension side of Playwright MCP's relay for the visible Sidebar browser tab, answered with
 * `webContents.debugger`; this release forwards read, screenshot, and navigation commands only.
 */
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow, WebContents } from 'electron'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import type { DesktopBrowserGuests } from './browser-guests.ts'

/** Inputs the relay draws from the shell; the same owners `createCredentialRequestHandler` uses. */
export interface SidebarBrowserRelaySource {
  /** Current application window; undefined before creation and after teardown. */
  readonly primary: () => BrowserWindow | undefined
  /** Active-tab owner; a partition with a pending clear has no active lease. */
  readonly guests: Pick<DesktopBrowserGuests, 'getActiveGuest' | 'getActiveLease'>
  /** Ask the renderer whether the tracked tab is still visible. */
  readonly confirmVisible: (owner: WebContents, lease: DesktopBrowserLeaseId) => Promise<boolean>
}

/**
 * CDP methods forwarded to the guest: what Playwright needs to attach, read the page, take
 * screenshots, and navigate. Every other method, including all of `Input.*`, is refused.
 */
export const SIDEBAR_BROWSER_COMMANDS: ReadonlySet<string> = new Set([
  'Target.setAutoAttach', 'Target.getTargetInfo', 'Network.enable', 'Log.enable',
  'Page.enable', 'Page.getFrameTree', 'Page.setLifecycleEventsEnabled', 'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument', 'Page.createIsolatedWorld', 'Page.setInterceptFileChooserDialog',
  'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.getNavigationHistory', 'Page.stopLoading',
  'Page.navigate', 'Page.navigateToHistoryEntry', 'Page.reload',
  'Runtime.enable', 'Runtime.runIfWaitingForDebugger', 'Runtime.evaluate', 'Runtime.callFunctionOn',
  'Runtime.getProperties', 'Runtime.releaseObject', 'Runtime.releaseObjectGroup', 'Runtime.addBinding',
  'DOM.describeNode', 'DOM.resolveNode', 'DOM.getBoxModel', 'DOM.getContentQuads', 'DOM.getFrameOwner',
  'DOM.scrollIntoViewIfNeeded',
])

/** Forwarded methods that change the page; each first re-confirms visibility with the renderer. */
export const SIDEBAR_BROWSER_NAVIGATION_COMMANDS: ReadonlySet<string> = new Set(['Page.navigate', 'Page.navigateToHistoryEntry', 'Page.reload'])

/** Extension tab id of the one tab the relay exposes. */
const TAB_ID = 1

/** Reason sent when the tracked tab stops being the visible active tab. */
const LOST_TAB = 'sidebar browser: the Sidebar tab was switched, hidden, or cleared'

/** The tracked tab stopped being the visible active tab; the relay answers, then disconnects. */
class LostTabError extends Error {
  constructor() {
    super(LOST_TAB)
  }
}

/** Connection result reported back to the stand-in executable. */
export type SidebarBrowserConnectResult = { readonly ok: true } | { readonly error: string }

interface RelayMessage {
  readonly id: number
  readonly method: string
  readonly params: readonly unknown[]
}

function relayMessage(data: unknown): RelayMessage | undefined {
  let message: unknown
  try {
    message = JSON.parse(String(data))
  } catch (_error) {
    // A malformed relay frame is answered by nothing; the relay times out its own command.
    return undefined
  }
  if (typeof message !== 'object' || message === null || !('id' in message) || typeof message.id !== 'number'
    || !('method' in message) || typeof message.method !== 'string') return undefined
  const params: readonly unknown[] = 'params' in message && Array.isArray(message.params) ? message.params : []
  return { id: message.id, method: message.method, params }
}

/**
 * @param value - URL the stand-in received as `mcpRelayUrl`.
 * @returns whether it is the loopback extension endpoint of a Playwright MCP relay.
 */
export function isRelayUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'ws:' && ['[::1]', '127.0.0.1', 'localhost'].includes(url.hostname)
    && url.username === '' && url.password === '' && url.search === ''
    && /^\/extension\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(url.pathname)
}

/** At most one relay connection drives the Sidebar at a time; a newer connection replaces the older. */
export class SidebarBrowserRelay {
  private current: (() => void) | undefined
  private disposed = false
  private readonly opening = new Set<WebSocket>()

  /** @param source - window, active-tab, and visibility owners. */
  constructor(private readonly source: SidebarBrowserRelaySource) {}

  /**
   * Take the visible active Sidebar tab and connect it to the relay as the extension.
   * @param relayUrl - loopback relay endpoint; its path is the relay's credential and is never logged.
   * @returns `ok` after the extension handshake, or the refusal reason.
   */
  async connect(relayUrl: string): Promise<SidebarBrowserConnectResult> {
    if (!isRelayUrl(relayUrl)) return { error: 'sidebar browser: invalid relay URL' }
    const window = this.source.primary()
    if (window === undefined || window.isDestroyed()) return { error: 'sidebar browser: no application window' }
    const owner = window.webContents
    const guest = this.source.guests.getActiveGuest(owner)
    const lease = this.source.guests.getActiveLease(owner)
    if (guest === undefined || lease === undefined) return { error: 'sidebar browser: no visible Sidebar tab' }
    const active = (): boolean => !this.disposed && !window.isDestroyed() && !guest.isDestroyed()
      && this.source.guests.getActiveLease(owner) === lease
    // The renderer confirmation is asynchronous: re-check the lease once it settles.
    const visible = async (): Promise<boolean> => active() && await this.source.confirmVisible(owner, lease) && active()
    if (!await visible()) return { error: 'sidebar browser: no visible Sidebar tab' }

    const relay = new WebSocket(relayUrl)
    this.opening.add(relay)
    const opened = await new Promise<boolean>((resolve) => {
      relay.onopen = () => { resolve(true) }
      relay.onerror = () => { resolve(false) }
      relay.onclose = () => { resolve(false) }
    })
    this.opening.delete(relay)
    if (!opened) return { error: 'sidebar browser: relay unreachable' }
    if (!active()) {
      relay.close(1000, LOST_TAB)
      return { error: LOST_TAB }
    }
    this.current?.()

    const send = (message: object): void => { if (relay.readyState === WebSocket.OPEN) relay.send(JSON.stringify(message)) }
    // Electron settles a command's promise in a microtask but emits the events that followed its
    // response synchronously, so forwarding events at once can overtake that response. Playwright
    // then drops execution contexts of frames it has not seen yet. A macrotask keeps responses first.
    const onMessage = (_event: unknown, method: string, params: unknown, sessionId?: string): void => {
      setImmediate(() => { send({ method: 'chrome.debugger.onEvent', params: [{ tabId: TAB_ID, sessionId }, method, params] }) })
    }
    let stopped = false
    const stop = (reason: string): void => {
      if (stopped) return
      stopped = true
      if (this.current === close) this.current = undefined
      if (!guest.isDestroyed()) {
        guest.debugger.off('message', onMessage)
        guest.debugger.off('detach', onDetach)
        guest.off('destroyed', onDestroyed)
        if (guest.debugger.isAttached()) guest.debugger.detach()
      }
      if (relay.readyState === WebSocket.OPEN || relay.readyState === WebSocket.CONNECTING) relay.close(1000, reason)
    }
    const close = (): void => { stop('sidebar browser: replaced by a newer connection') }
    const onDetach = (_event: unknown, reason: string): void => {
      setImmediate(() => {
        send({ method: 'chrome.debugger.onDetach', params: [{ tabId: TAB_ID }, reason] })
        stop('sidebar browser: debugger detached')
      })
    }
    const onDestroyed = (): void => { stop(LOST_TAB) }
    this.current = close
    guest.once('destroyed', onDestroyed)
    relay.onclose = () => { stop('relay closed') }
    relay.onerror = () => { stop('relay error') }

    const handle = async (method: string, params: readonly unknown[]): Promise<unknown> => {
      switch (method) {
        case 'chrome.debugger.attach':
          guest.debugger.attach(typeof params[1] === 'string' ? params[1] : '1.3')
          guest.debugger.on('message', onMessage)
          guest.debugger.on('detach', onDetach)
          return undefined
        case 'chrome.debugger.detach':
          stop('sidebar browser: detached by the relay')
          return undefined
        case 'chrome.debugger.sendCommand': {
          const [target, command, commandParams] = params
          const sessionId = typeof target === 'object' && target !== null && 'sessionId' in target
            && typeof target.sessionId === 'string' ? target.sessionId : undefined
          if (typeof command !== 'string' || !SIDEBAR_BROWSER_COMMANDS.has(command)) {
            throw new Error(`sidebar browser: ${String(command)} is refused; the Sidebar browser is read-only`)
          }
          if (SIDEBAR_BROWSER_NAVIGATION_COMMANDS.has(command) && !await visible()) throw new LostTabError()
          const result: unknown = await guest.debugger.sendCommand(command, commandParams ?? {}, sessionId)
          // Electron reports a <webview> guest as target type "webview"; Playwright only adopts "page" targets.
          if (command === 'Target.getTargetInfo' && sessionId === undefined && typeof result === 'object' && result !== null
            && 'targetInfo' in result && typeof result.targetInfo === 'object' && result.targetInfo !== null
            && 'type' in result.targetInfo && result.targetInfo.type === 'webview') {
            return { ...result, targetInfo: { ...result.targetInfo, type: 'page' } }
          }
          return result
        }
        case 'chrome.tabs.create':
        case 'chrome.tabs.remove':
          throw new Error('sidebar browser: opening or closing tabs is refused; only the current Sidebar tab is available')
        default:
          throw new Error(`sidebar browser: ${method} is not supported`)
      }
    }
    relay.onmessage = (event) => {
      const message = relayMessage(event.data)
      if (message === undefined) return
      // Synchronous ownership check before any command reaches the guest.
      if (!active()) {
        send({ id: message.id, error: LOST_TAB })
        stop(LOST_TAB)
        return
      }
      void handle(message.method, message.params).then(
        (result) => { send({ id: message.id, result }) },
        (error: unknown) => {
          send({ id: message.id, error: error instanceof Error ? error.message : String(error) })
          if (error instanceof LostTabError) stop(LOST_TAB)
        },
      )
    }
    send({ method: 'chrome.tabs.onCreated', params: [{ id: TAB_ID, url: guest.getURL(), title: guest.getTitle(), active: true }] })
    send({ method: 'extension.initialized', params: [] })
    return { ok: true }
  }

  /** Refuse future connections and stop pending and current connections, detaching the debugger. */
  dispose(): void {
    this.disposed = true
    for (const relay of this.opening) relay.close(1000, 'sidebar browser: listener closed')
    this.current?.()
  }
}

/** Listening relay socket and the environment the Host passes to Playwright MCP. */
export interface SidebarBrowserRelayListener {
  /** Owner-only (0600) Unix socket inside an owner-only (0700) directory. */
  readonly socketPath: string
  /** Random per-launch authentication token; never logged or included in the connection page URL. */
  readonly socketToken: string
  /** Share one close promise: destroy accepted sockets, await server closure, then remove the directory. */
  close(): Promise<void>
}

/** Upper bound of one stand-in request line. */
const MAX_REQUEST_BYTES = 4096

/**
 * Accept relay URLs from the stand-in executable on a Unix socket only the current user can open.
 * @param relay - connection owner answering each request.
 * @param directory - parent of the private socket directory; defaults to the OS temporary directory.
 * @returns the socket path and its disposer.
 */
export async function listenSidebarBrowserRelay(relay: SidebarBrowserRelay, directory = tmpdir()): Promise<SidebarBrowserRelayListener> {
  // mkdtemp creates the directory with mode 0700; the socket itself is narrowed to 0600 below.
  const socketDirectory = await mkdtemp(join(directory, 'dsh-sidebar-'))
  const socketPath = join(socketDirectory, 'relay.sock')
  const tokenBytes = randomBytes(32)
  const socketToken = tokenBytes.toString('hex')
  const sockets = new Set<Socket>()
  let closing: Promise<void> | undefined
  const server = createServer((socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
    let request = ''
    socket.setEncoding('utf8')
    socket.on('error', (_error: Error) => {
      // The stand-in exits after its answer or deadline; a reset carries nothing to report.
    })
    socket.on('data', (chunk: string) => {
      request += chunk
      const end = request.indexOf('\n')
      if (end === -1) {
        if (request.length > MAX_REQUEST_BYTES) socket.destroy()
        return
      }
      socket.removeAllListeners('data')
      let relayUrl: unknown
      let token: unknown
      try {
        const parsed: unknown = JSON.parse(request.slice(0, end))
        relayUrl = typeof parsed === 'object' && parsed !== null && 'relayUrl' in parsed ? parsed.relayUrl : undefined
        token = typeof parsed === 'object' && parsed !== null && 'token' in parsed ? parsed.token : undefined
      } catch (_error) {
        // Answered below as an invalid request.
      }
      const authenticated = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
        && timingSafeEqual(tokenBytes, Buffer.from(token, 'hex'))
      const answer = (closing !== undefined || !authenticated
        ? Promise.resolve<SidebarBrowserConnectResult>({ error: 'sidebar browser: authentication refused' })
        : typeof relayUrl === 'string' ? relay.connect(relayUrl) : Promise.resolve<SidebarBrowserConnectResult>({ error: 'sidebar browser: invalid request' }))
        .catch((): SidebarBrowserConnectResult => ({ error: 'sidebar browser: connection failed' }))
      void answer.then((result) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`)
      })
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    await chmod(socketPath, 0o600)
  } catch (error) {
    relay.dispose()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await rm(socketDirectory, { recursive: true, force: true })
    throw error
  }
  return {
    socketPath,
    socketToken,
    close() {
      closing ??= (async () => {
        relay.dispose()
        const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
        for (const socket of sockets) socket.destroy()
        await closed
        await rm(socketDirectory, { recursive: true, force: true })
      })()
      return closing
    },
  }
}
