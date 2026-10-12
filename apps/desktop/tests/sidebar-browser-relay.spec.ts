import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, connect } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws'
import type { BrowserWindow, WebContents } from 'electron'
import { DesktopBrowserGuests } from '../src/browser-guests.ts'
import { SidebarBrowserRelay, listenSidebarBrowserRelay } from '../src/sidebar-browser-relay.ts'

const storage = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }))
vi.mock('electron', () => ({
  app: { isPackaged: true },
  session: {
    fromPartition: vi.fn((name: string) => ({
      storagePath: `/partitions/${name.slice('persist:'.length)}`,
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
      closeAllConnections: vi.fn(async () => {}),
      clearStorageData: vi.fn(async () => { await storage.gate }),
      clearCache: vi.fn(async () => {}),
      clearAuthCache: vi.fn(async () => {}),
    })),
  },
}))

const LOST_TAB = 'sidebar browser: the Sidebar tab was switched, hidden, or cleared'

interface FakeDebugger extends EventEmitter {
  readonly attach: ReturnType<typeof vi.fn>
  readonly detach: ReturnType<typeof vi.fn>
  readonly isAttached: () => boolean
  readonly sendCommand: Mock<(method: string, params?: object, sessionId?: string) => Promise<unknown>>
}

type FakeGuest = WebContents & EventEmitter & { readonly debugger: FakeDebugger }

/**
 * A guest with the debugger surface the relay drives. `close()` does not destroy it, so a
 * pending site clear stays pending and only the clearing mark separates the tab from the relay.
 * @param page - mutable page URL the guest reports.
 */
function fakeGuest(page: { url: string }): FakeGuest {
  let attached = false
  const debuggerEmitter: FakeDebugger = Object.assign(new EventEmitter(), {
    attach: vi.fn(() => { attached = true }),
    detach: vi.fn(() => { attached = false }),
    isAttached: () => attached,
    sendCommand: vi.fn(async (method: string): Promise<unknown> => method === 'Target.getTargetInfo'
      ? { targetInfo: { targetId: 'T1', type: 'webview', url: page.url } }
      : { method }),
  })
  const methods: Pick<WebContents, 'getURL' | 'getTitle' | 'isDestroyed' | 'close' | 'setWindowOpenHandler'> = {
    getURL: () => page.url,
    getTitle: () => 'Site',
    isDestroyed: () => false,
    close: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }
  return Object.assign(new EventEmitter(), methods, { debugger: debuggerEmitter }) as FakeGuest
}

interface Fixture {
  readonly guests: DesktopBrowserGuests
  readonly owner: WebContents & EventEmitter
  readonly first: { lease: string; guest: FakeGuest }
  readonly second: { lease: string; guest: FakeGuest }
  readonly confirmVisible: ReturnType<typeof vi.fn>
  readonly relay: SidebarBrowserRelay
}

async function fixture(): Promise<Fixture> {
  const guests = new DesktopBrowserGuests(() => undefined, '/partitions')
  const owner = new EventEmitter() as WebContents & EventEmitter
  guests.bind({ webContents: owner } as BrowserWindow, () => () => {})
  const attach = async (site: string): Promise<{ lease: string; guest: FakeGuest }> => {
    const reservation = await guests.acquire(owner, site)
    owner.emit('will-attach-webview', { preventDefault: vi.fn() }, {}, { src: `about:blank#${reservation.lease}`, partition: reservation.partition })
    const page = { url: `about:blank#${reservation.lease}` }
    const guest = fakeGuest(page)
    owner.emit('did-attach-webview', {}, guest)
    guest.emit('dom-ready')
    page.url = site
    return { lease: reservation.lease, guest }
  }
  const first = await attach('https://site.example/')
  const second = await attach('https://other.example/')
  guests.markActive(owner, first.lease)
  const window = { webContents: owner, isDestroyed: () => false } as BrowserWindow
  const confirmVisible = vi.fn(async () => true)
  const relay = new SidebarBrowserRelay({ primary: () => window, guests, confirmVisible })
  return { guests, owner, first, second, confirmVisible, relay }
}

/** Playwright MCP's relay as the extension sees it: one WebSocket endpoint whose path carries the uuid. */
async function fakeRelay(): Promise<{
  url: string
  extension: Promise<ServerSocket>
  messages: unknown[]
  call: (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: string }>
  closed: Promise<string>
  close: () => Promise<void>
}> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => { server.once('listening', resolve) })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('relay address')
  const messages: unknown[] = []
  const pending = new Map<number, (reply: { result?: unknown; error?: string }) => void>()
  let resolveClosed!: (reason: string) => void
  const closed = new Promise<string>((resolve) => { resolveClosed = resolve })
  const extension = new Promise<ServerSocket>((resolve) => {
    server.once('connection', (socket) => {
      socket.on('message', (data) => {
        if (!Buffer.isBuffer(data)) throw new Error('expected a Buffer WebSocket frame')
        const message = JSON.parse(data.toString('utf8')) as { id?: number; result?: unknown; error?: string }
        messages.push(message)
        if (message.id !== undefined) pending.get(message.id)?.(message)
      })
      socket.on('close', (_code, reason) => { resolveClosed(String(reason)) })
      resolve(socket)
    })
  })
  let nextId = 1
  return {
    url: `ws://127.0.0.1:${String(address.port)}/extension/${randomUUID()}`,
    extension,
    messages,
    async call(method, params) {
      const socket = await extension
      const id = nextId++
      return await new Promise((resolve) => {
        pending.set(id, resolve)
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    closed,
    close: () => new Promise<void>((resolve) => {
      for (const client of server.clients) client.terminate()
      server.close(() => { resolve() })
    }),
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  storage.gate = undefined
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function connected(): Promise<Fixture & { relayServer: Awaited<ReturnType<typeof fakeRelay>> }> {
  const setup = await fixture()
  const relayServer = await fakeRelay()
  cleanups.push(relayServer.close)
  expect(await setup.relay.connect(relayServer.url)).toEqual({ ok: true })
  expect(await relayServer.call('chrome.debugger.attach', [{ tabId: 1 }, '1.3'])).toEqual({ id: 1 })
  return { ...setup, relayServer }
}

describe('Sidebar browser relay connection', () => {
  it('closes with LOST_TAB without touching a destroyed guest', async () => {
    const { relayServer, first, relay } = await connected()
    const debuggerInstance = first.guest.debugger
    vi.spyOn(first.guest, 'isDestroyed').mockReturnValue(true)
    Object.defineProperty(first.guest, 'debugger', { get() { throw new TypeError('Object has been destroyed') } })
    const off = vi.spyOn(first.guest, 'off').mockImplementation(() => { throw new TypeError('Object has been destroyed') })
    expect(() => { first.guest.emit('destroyed') }).not.toThrow()
    expect(await relayServer.closed).toBe(LOST_TAB)
    expect(off).not.toHaveBeenCalled()
    expect(debuggerInstance.detach).not.toHaveBeenCalled()
    expect(() => { relay.dispose() }).not.toThrow()
  })
  it('connects the visible active tab and announces only that tab', async () => {
    const { relayServer, first, confirmVisible, owner } = await connected()
    expect(confirmVisible).toHaveBeenCalledWith(owner, first.lease)
    expect(relayServer.messages.slice(0, 2)).toEqual([
      { method: 'chrome.tabs.onCreated', params: [{ id: 1, url: 'https://site.example/', title: 'Site', active: true }] },
      { method: 'extension.initialized', params: [] },
    ])
    expect(first.guest.debugger.attach).toHaveBeenCalledWith('1.3')
  })

  it('refuses a connection without a visible active tab or with a non-relay URL', async () => {
    const setup = await fixture()
    const relayServer = await fakeRelay()
    cleanups.push(relayServer.close)
    expect(await setup.relay.connect('ws://203.0.113.1:1/extension/x')).toEqual({ error: 'sidebar browser: invalid relay URL' })
    setup.confirmVisible.mockResolvedValueOnce(false)
    expect(await setup.relay.connect(relayServer.url)).toEqual({ error: 'sidebar browser: no visible Sidebar tab' })
    setup.guests.markInactive(setup.owner, setup.first.lease)
    expect(await setup.relay.connect(relayServer.url)).toEqual({ error: 'sidebar browser: no visible Sidebar tab' })
  })

  it('reports the webview guest as a page target on the root session only', async () => {
    const { relayServer } = await connected()
    expect(await relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Target.getTargetInfo']))
      .toMatchObject({ result: { targetInfo: { targetId: 'T1', type: 'page' } } })
    expect(await relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1, sessionId: 'child' }, 'Target.getTargetInfo']))
      .toMatchObject({ result: { targetInfo: { type: 'webview' } } })
  })

  it('refuses every Input command without forwarding it, and forwards read commands', async () => {
    const { relayServer, first } = await connected()
    for (const method of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.imeSetComposition', 'Input.dispatchTouchEvent']) {
      expect(await relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1 }, method, {}]))
        .toMatchObject({ error: `sidebar browser: ${method} is refused; the Sidebar browser is read-only` })
    }
    expect(await relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Page.captureScreenshot', {}]))
      .toMatchObject({ result: { method: 'Page.captureScreenshot' } })
    expect(first.guest.debugger.sendCommand.mock.calls.map((call): unknown => call[0])).toEqual(['Page.captureScreenshot'])
    expect(first.guest.debugger.detach).not.toHaveBeenCalled()
  })

  it('forwards a response before the events Electron emitted after it', async () => {
    const { relayServer, first } = await connected()
    first.guest.debugger.sendCommand.mockImplementationOnce(() => {
      const response = Promise.resolve({ frameTree: {} })
      // Electron emits the next event before the response's promise callbacks run.
      queueMicrotask(() => { first.guest.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1 } }, '') })
      return response
    })
    await relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Page.getFrameTree', {}])
    await vi.waitFor(() => { expect(relayServer.messages).toHaveLength(5) })
    expect(relayServer.messages.slice(3)).toEqual([
      { id: 2, result: { frameTree: {} } },
      { method: 'chrome.debugger.onEvent', params: [{ tabId: 1, sessionId: '' }, 'Runtime.executionContextCreated', { context: { id: 1 } }] },
    ])
  })

  it('refuses to open or close tabs', async () => {
    const { relayServer } = await connected()
    for (const method of ['chrome.tabs.create', 'chrome.tabs.remove']) {
      expect(await relayServer.call(method, [{ url: 'https://site.example/new' }]))
        .toMatchObject({ error: 'sidebar browser: opening or closing tabs is refused; only the current Sidebar tab is available' })
    }
  })

  it.each([
    ['the user switches to another tab', (setup: Fixture) => { setup.guests.markActive(setup.owner, setup.second.lease) }],
    ['the user collapses the Sidebar', (setup: Fixture) => { setup.guests.markInactive(setup.owner, setup.first.lease) }],
    ['the site is being cleared', (setup: Fixture) => {
      storage.gate = new Promise<void>(() => {})
      void setup.guests.clearSite(setup.owner, setup.first.lease)
      // The fake guest survives close(): only the pending clear separates it from the relay.
      expect(setup.guests.getActiveLease(setup.owner)).toBeUndefined()
    }],
  ])('fails the next command and detaches the debugger when %s', async (_name, change) => {
    const setup = await connected()
    change(setup)
    expect(await setup.relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Runtime.evaluate', { expression: '1' }]))
      .toMatchObject({ error: LOST_TAB })
    expect(setup.first.guest.debugger.sendCommand).not.toHaveBeenCalled()
    expect(setup.first.guest.debugger.detach).toHaveBeenCalled()
    expect(await setup.relayServer.closed).toBe(LOST_TAB)
  })

  it('reconfirms visibility before navigation but not before reads', async () => {
    const setup = await connected()
    setup.confirmVisible.mockClear()
    await setup.relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Page.captureScreenshot', {}])
    expect(setup.confirmVisible).not.toHaveBeenCalled()
    expect(await setup.relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Page.navigate', { url: 'https://site.example/b' }]))
      .toMatchObject({ result: { method: 'Page.navigate' } })
    expect(setup.confirmVisible).toHaveBeenCalledTimes(1)
    setup.confirmVisible.mockResolvedValueOnce(false)
    expect(await setup.relayServer.call('chrome.debugger.sendCommand', [{ tabId: 1 }, 'Page.navigateToHistoryEntry', { entryId: 1 }]))
      .toMatchObject({ error: LOST_TAB })
    expect(setup.first.guest.debugger.sendCommand.mock.calls.map((call): unknown => call[0])).toEqual(['Page.captureScreenshot', 'Page.navigate'])
    expect(setup.first.guest.debugger.detach).toHaveBeenCalled()
  })
})

describe('Sidebar browser relay socket', () => {
  it('listens on an owner-only socket and answers each request with one line', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-test-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const setup = await fixture()
    const listener = await listenSidebarBrowserRelay(setup.relay, directory)
    cleanups.push(() => listener.close())
    expect((await stat(listener.socketPath)).mode & 0o777).toBe(0o600)
    expect((await stat(join(listener.socketPath, '..'))).mode & 0o777).toBe(0o700)
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(listener.socketPath)
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => { data += chunk })
      socket.on('end', () => { resolve(data) })
      socket.on('error', reject)
      socket.write(`${JSON.stringify({ relayUrl: 'ws://127.0.0.1:1/elsewhere', token: listener.socketToken })}\n`)
    })
    expect(reply).toBe(`${JSON.stringify({ error: 'sidebar browser: invalid relay URL' })}\n`)
    await listener.close()
    await expect(stat(listener.socketPath)).rejects.toThrow()
  })

  it('rejects missing and wrong tokens before connecting, and accepts the shell token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-test-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const setup = await fixture()
    const listener = await listenSidebarBrowserRelay(setup.relay, directory)
    cleanups.push(() => listener.close())
    const relayServer = await fakeRelay()
    cleanups.push(relayServer.close)
    const connectRelay = vi.spyOn(setup.relay, 'connect')
    const request = async (token?: string): Promise<string> => await new Promise((resolve, reject) => {
      const socket = connect(listener.socketPath)
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => { data += chunk })
      socket.on('end', () => { resolve(data) })
      socket.on('error', reject)
      socket.write(`${JSON.stringify({ relayUrl: relayServer.url, token })}\n`)
    })
    for (const token of [undefined, 'invalid', '0'.repeat(64)]) {
      expect(JSON.parse(await request(token))).toEqual({ error: 'sidebar browser: authentication refused' })
    }
    expect(connectRelay).not.toHaveBeenCalled()
    expect(JSON.parse(await request(listener.socketToken))).toEqual({ ok: true })
    expect(connectRelay).toHaveBeenCalledOnce()
  })

  it('destroys accepted sockets and waits for directory removal with one shared close promise', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-test-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const setup = await fixture()
    const listener = await listenSidebarBrowserRelay(setup.relay, directory)
    cleanups.push(() => listener.close())
    const socket = connect(listener.socketPath)
    socket.on('error', () => {})
    await new Promise<void>((resolve) => { socket.once('connect', resolve) })
    const disconnected = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
    socket.write('{')
    const closing = listener.close()
    expect(listener.close()).toBe(closing)
    await closing
    await disconnected
    await expect(stat(join(listener.socketPath, '..'))).rejects.toThrow()
    await expect(setup.relay.connect('ws://127.0.0.1:1/extension/00000000-0000-0000-0000-000000000000'))
      .resolves.toEqual({ error: 'sidebar browser: no visible Sidebar tab' })
  })
})

describe('Sidebar browser stand-in executable', () => {
  const executable = fileURLToPath(new URL('../resources/sidebar-browser-connect', import.meta.url))

  async function runStandIn(socketPath: string, timeoutMs: number, socketToken = '0'.repeat(64)): Promise<{ code: number | null; reason: string }> {
    const relayServer = await fakeRelay()
    cleanups.push(relayServer.close)
    const page = new URL('chrome-extension://extension-id/connect.html')
    page.searchParams.set('mcpRelayUrl', relayServer.url)
    const child = spawn(executable, [page.href], {
      env: {
        PATH: process.env.PATH ?? '',
        DSH_SIDEBAR_BROWSER_NODE: process.execPath,
        DSH_SIDEBAR_BROWSER_SOCKET: socketPath,
        DSH_SIDEBAR_BROWSER_TOKEN: socketToken,
        DSH_SIDEBAR_BROWSER_CONNECT_TIMEOUT_MS: String(timeoutMs),
      },
      stdio: 'ignore',
    })
    const code = await new Promise<number | null>((resolve) => { child.once('exit', resolve) })
    return { code, reason: await relayServer.closed }
  }

  it('fails the relay wait with the reason when the shell does not answer before the deadline', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-test-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const socketPath = join(directory, 'silent.sock')
    const silent = createServer((socket) => { socket.resume() })
    await new Promise<void>((resolve) => { silent.listen(socketPath, resolve) })
    cleanups.push(() => new Promise<void>((resolve) => { silent.close(() => { resolve() }) }))
    const started = Date.now()
    expect(await runStandIn(socketPath, 300)).toEqual({ code: 1, reason: 'sidebar browser: the desktop shell did not accept the connection in time' })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('fails the relay wait with the shell refusal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-relay-test-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const setup = await fixture()
    setup.guests.markInactive(setup.owner, setup.first.lease)
    const listener = await listenSidebarBrowserRelay(setup.relay, directory)
    cleanups.push(() => listener.close())
    expect(await runStandIn(listener.socketPath, 5_000, listener.socketToken)).toEqual({ code: 1, reason: 'sidebar browser: no visible Sidebar tab' })
  })
})
