import { EventEmitter } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserWindow, WebContents } from 'electron'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { afterEach, expect, it, vi } from 'vitest'
import { SidebarBrowserRelay, listenSidebarBrowserRelay } from '../src/sidebar-browser-relay.ts'

const transport = vi.hoisted(() => ({
  accept: undefined as ((socket: EventEmitter) => void) | undefined,
  finishClose: undefined as (() => void) | undefined,
  close: vi.fn(),
}))
vi.mock('node:net', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    createServer(accept: (socket: EventEmitter) => void) {
      transport.accept = accept
      return Object.assign(new EventEmitter(), {
        listen(_path: string, ready: () => void) { ready() },
        close(done: () => void) { transport.close(); transport.finishClose = done },
      })
    },
  }
})
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  chmod: vi.fn(async () => {}),
}))

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CONNECTING = 0
  static readonly instances: FakeWebSocket[] = []
  readyState = 1
  onopen: (() => void) | undefined
  onclose: (() => void) | undefined
  onerror: (() => void) | undefined
  onmessage: ((event: { data: string }) => void) | undefined
  readonly sent: object[] = []
  readonly close = vi.fn((_code: number, _reason: string) => { this.readyState = 3; this.onclose?.() })
  constructor() { FakeWebSocket.instances.push(this); queueMicrotask(() => { this.onopen?.() }) }
  send(message: string): void { this.sent.push(JSON.parse(message) as object) }
}

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  FakeWebSocket.instances.length = 0
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function fixture() {
  vi.stubGlobal('WebSocket', FakeWebSocket)
  let destroyed = false
  const debug = Object.assign(new EventEmitter(), { attach: vi.fn(), detach: vi.fn(), isAttached: () => true })
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => destroyed, getURL: () => 'https://site.example/', getTitle: () => 'Site',
  })
  Object.defineProperty(guest, 'debugger', { get() {
    if (destroyed) throw new TypeError('Object has been destroyed')
    return debug
  } })
  const off = vi.spyOn(guest, 'off').mockImplementation((...args) => {
    if (destroyed) throw new TypeError('Object has been destroyed')
    EventEmitter.prototype.off.apply(guest, args)
    return guest
  })
  const owner = new EventEmitter() as WebContents
  const window = { isDestroyed: () => false, webContents: owner } as BrowserWindow
  const relay = new SidebarBrowserRelay({
    primary: () => window,
    guests: { getActiveGuest: () => guest as WebContents, getActiveLease: () => 'lease' as DesktopBrowserLeaseId },
    confirmVisible: async () => true,
  })
  return { relay, debug, off, destroy() { destroyed = true; guest.emit('destroyed') } }
}

const url = 'ws://127.0.0.1:1/extension/00000000-0000-0000-0000-000000000000'

it('stops a connected relay with LOST_TAB without accessing destroyed Electron objects', async () => {
  const setup = fixture()
  expect(await setup.relay.connect(url)).toEqual({ ok: true })
  setup.off.mockClear()
  expect(() => { setup.destroy() }).not.toThrow()
  expect(FakeWebSocket.instances[0]!.close).toHaveBeenCalledWith(1000, 'sidebar browser: the Sidebar tab was switched, hidden, or cleared')
  expect(setup.off).not.toHaveBeenCalled()
  expect(setup.debug.detach).not.toHaveBeenCalled()
  expect(() => { setup.relay.dispose() }).not.toThrow()
})

it('authenticates the stand-in request before connecting and waits for server closure before removing its directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidebar-lifecycle-'))
  directories.push(directory)
  const setup = fixture()
  const connect = vi.spyOn(setup.relay, 'connect')
  const listener = await listenSidebarBrowserRelay(setup.relay, directory)
  const sockets: Array<ReturnType<typeof request>> = []
  function request(token?: string) {
    const socket = Object.assign(new EventEmitter(), {
      destroyed: false, setEncoding: vi.fn(), end: vi.fn(),
      destroy: vi.fn(() => { socket.destroyed = true; socket.emit('close') }),
    })
    transport.accept!(socket)
    socket.emit('data', `${JSON.stringify({ relayUrl: url, token })}\n`)
    return socket
  }
  try {
    for (const token of [undefined, 'invalid', '0'.repeat(64)]) {
      const socket = request(token)
      sockets.push(socket)
      await vi.waitFor(() => { expect(socket.end).toHaveBeenCalledWith(`${JSON.stringify({ error: 'sidebar browser: authentication refused' })}\n`) })
    }
    expect(connect).not.toHaveBeenCalled()
    const accepted = request(listener.socketToken)
    sockets.push(accepted)
    await vi.waitFor(() => { expect(accepted.end).toHaveBeenCalledWith('{"ok":true}\n') })
    expect(connect).toHaveBeenCalledOnce()
  } finally {
    const closing = listener.close()
    expect(listener.close()).toBe(closing)
    expect(transport.close).toHaveBeenCalledOnce()
    for (const socket of sockets) expect(socket.destroy).toHaveBeenCalledOnce()
    await expect(stat(dirname(listener.socketPath))).resolves.toBeDefined()
    transport.finishClose!()
    await closing
    await expect(stat(dirname(listener.socketPath))).rejects.toThrow()
  }
})
