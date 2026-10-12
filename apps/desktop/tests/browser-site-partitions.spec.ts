import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, Session, WebContents } from 'electron'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DESKTOP_IPC, SCHEME } from '../src/ipc.ts'

type StubSession = Record<keyof Pick<Session, 'clearStorageData' | 'clearCache' | 'clearAuthCache' | 'closeAllConnections'>, ReturnType<typeof vi.fn>> & {
  storagePath: string
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setDevicePermissionHandler: ReturnType<typeof vi.fn>
  setDisplayMediaRequestHandler: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> }
}

const sessions = new Map<string, StubSession>()
const paths = vi.hoisted(() => ({ partitions: '', storagePath: (_name: string): string => '' }))
const electronMock = vi.hoisted(() => ({
  app: { isPackaged: true },
  session: {
    fromPartition: (name: string): object => {
      const existing = sessions.get(name)
      if (existing !== undefined) return existing
      const created = {
        // Electron keeps `persist:<name>` under `<sessionData>/Partitions/<name>`.
        storagePath: paths.storagePath(name),
        setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
        setDisplayMediaRequestHandler: vi.fn(), on: vi.fn(), webRequest: { onBeforeRequest: vi.fn() },
        closeAllConnections: vi.fn(async () => {}), clearStorageData: vi.fn(async () => {}),
        clearCache: vi.fn(async () => {}), clearAuthCache: vi.fn(async () => {}),
      }
      sessions.set(name, created)
      return created
    },
  },
}))
vi.mock('electron', () => electronMock)

const { DesktopBrowserGuests, sidebarPartitionName } = await import('../src/browser-guests.ts')
const { registerBrowserHandlers } = await import('../src/browser-ipc.ts')

const sender = { mainFrame: { url: `${SCHEME}://app/index.html` } } as WebContents
const event = { sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent
const window = { webContents: sender, isDestroyed: () => false } as BrowserWindow
const handlers = new Map<string, Parameters<IpcMain['handle']>[1]>()

async function call(channel: string, caller: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error('Handler missing')
  return handler(caller, ...args)
}

let directory: string
let guests: InstanceType<typeof DesktopBrowserGuests>

beforeEach(async () => {
  vi.clearAllMocks(); handlers.clear(); sessions.clear()
  directory = await mkdtemp(join(tmpdir(), 'sidebar-partitions-'))
  paths.partitions = join(directory, 'Partitions')
  paths.storagePath = name => join(paths.partitions, name.slice('persist:'.length))
  guests = new DesktopBrowserGuests(() => undefined, paths.partitions)
  registerBrowserHandlers({ handle: (channel, handler) => { handlers.set(channel, handler) } }, () => window, guests)
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

function expectCleared(partition: StubSession): void {
  expect(partition.closeAllConnections).toHaveBeenCalledOnce()
  // No storage filter: cookies, localStorage, IndexedDB and every other kind are erased.
  expect(partition.clearStorageData).toHaveBeenCalledExactlyOnceWith()
  expect(partition.clearCache).toHaveBeenCalledOnce()
  expect(partition.clearAuthCache).toHaveBeenCalledOnce()
}

function expectUntouched(partition: StubSession): void {
  expect(partition.closeAllConnections).not.toHaveBeenCalled()
  expect(partition.clearStorageData).not.toHaveBeenCalled()
  expect(partition.clearCache).not.toHaveBeenCalled()
  expect(partition.clearAuthCache).not.toHaveBeenCalled()
}

describe('sidebar site partitions', () => {
  it('derives one persistent hashed partition per origin without plaintext site identity', async () => {
    const first = await guests.acquire(sender, 'https://shop.example.com/login?next=/cart')
    expect(first.partition).toMatch(/^persist:dsh-sidebar-browser-[\da-f]{64}$/)
    expect(first.partition).not.toContain('shop.example.com')
    expect(first.partition).toBe(sidebarPartitionName('https://shop.example.com'))
    const again = await guests.acquire(sender, 'https://shop.example.com/other')
    expect(again.partition).toBe(first.partition)
    expect(again.lease).not.toBe(first.lease)
    const other = await guests.acquire(sender, 'http://shop.example.com/')
    const sibling = await guests.acquire(sender, 'https://sibling.example.com/')
    expect(new Set([first.partition, other.partition, sibling.partition]).size).toBe(3)
  })

  it.each([null, 42, '', 'file:///tmp/site', 'javascript:alert(1)', 'https://user:pass@example.com/', 'x'.repeat(4097)])
  ('rejects invalid acquire site URLs (%s)', async (siteUrl) => {
    await expect(guests.acquire(sender, siteUrl)).rejects.toThrow()
    expect(sessions.size).toBe(0)
  })

  it('clears only the partition of the given lease and closes its guests', async () => {
    const target = await guests.acquire(sender, 'https://target.example/')
    const sameSite = await guests.acquire(sender, 'https://target.example/other')
    const bystander = await guests.acquire(sender, 'https://other.example/')
    await guests.clearSite(sender, target.lease)
    expectCleared(sessions.get(target.partition)!)
    expectUntouched(sessions.get(bystander.partition)!)
    for (const lease of [target.lease, sameSite.lease]) {
      await expect(guests.clearSite(sender, lease)).rejects.toThrow('unknown guest lease')
    }
    expect(guests.getGuest(sender, bystander.lease)).toBeUndefined()
    await expect(guests.clearSite(sender, bystander.lease)).resolves.toBeUndefined()
    expect((await guests.acquire(sender, 'https://target.example/')).partition).toBe(target.partition)
  })

  it('refuses to clear by anything but a live lease of the calling window', async () => {
    const reservation = await guests.acquire(sender, 'https://owned.example/')
    const foreign = {} as WebContents
    await expect(guests.clearSite(foreign, reservation.lease)).rejects.toThrow('another window')
    await expect(guests.clearSite(sender, 'https://owned.example/')).rejects.toThrow('unknown guest lease')
    await expect(guests.clearSite(sender, 42)).rejects.toThrow('invalid guest lease')
    expectUntouched(sessions.get(reservation.partition)!)
  })

  it('clears sidebar partitions left on disk by earlier runs and those used in this run, nothing else', async () => {
    const earlier = sidebarPartitionName('https://earlier.example')
    await mkdir(join(paths.partitions, earlier.slice('persist:'.length)), { recursive: true })
    for (const unrelated of ['dsh-platform-0123', 'dsh-sidebar-browser-not-a-hash']) {
      await mkdir(join(paths.partitions, unrelated), { recursive: true })
    }
    const restarted = new DesktopBrowserGuests(() => undefined, paths.partitions)
    const current = await restarted.acquire(sender, 'https://current.example/')
    await restarted.clearAllSites(sender)
    expect([...sessions.keys()].sort()).toEqual([earlier, current.partition].sort())
    for (const partition of sessions.values()) expectCleared(partition)
    await expect(restarted.clearSite(sender, current.lease)).rejects.toThrow('unknown guest lease')
  })

  it('clears nothing when no partition directory exists yet', async () => {
    await expect(guests.clearAllSites(sender)).resolves.toBeUndefined()
    expect(sessions.size).toBe(0)
  })

  it('fails loudly when Electron stores the partition somewhere clearing does not expect', async () => {
    const reservation = await guests.acquire(sender, 'https://moved.example/')
    sessions.get(reservation.partition)!.storagePath = join(directory, 'elsewhere')
    await expect(guests.clearSite(sender, reservation.lease)).rejects.toThrow('not stored where clearing expects it')
    expect(sessions.get(reservation.partition)!.clearStorageData).not.toHaveBeenCalled()
  })

  it('orders an acquire behind a running clear of the same partition', async () => {
    const reservation = await guests.acquire(sender, 'https://ordered.example/')
    const partition = sessions.get(reservation.partition)!
    const gate = Promise.withResolvers<undefined>()
    partition.clearStorageData.mockReturnValueOnce(gate.promise)
    const clearing = guests.clearSite(sender, reservation.lease)
    let acquired = false
    const next = guests.acquire(sender, 'https://ordered.example/').then((value) => { acquired = true; return value })
    const unrelated = await guests.acquire(sender, 'https://unrelated.example/')
    expect(unrelated.partition).not.toBe(reservation.partition)
    await vi.waitFor(() => { expect(partition.clearStorageData).toHaveBeenCalledOnce() })
    expect(acquired).toBe(false)
    gate.resolve(undefined)
    await clearing
    const later = await next
    // The lease acquired after the clear survives it.
    await expect(guests.clearSite(sender, later.lease)).resolves.toBeUndefined()
  })

  it('propagates storage cleanup failures after closing the guests', async () => {
    const reservation = await guests.acquire(sender, 'https://failing.example/')
    sessions.get(reservation.partition)!.clearStorageData.mockRejectedValueOnce(new Error('disk'))
    await expect(guests.clearSite(sender, reservation.lease)).rejects.toThrow('Sidebar browser storage cleanup failed')
    expect(guests.getGuest(sender, reservation.lease)).toBeUndefined()
    const retry = await guests.acquire(sender, 'https://failing.example/')
    await expect(guests.clearSite(sender, retry.lease)).resolves.toBeUndefined()
  })

  it.each([
    DESKTOP_IPC.browserAcquire, DESKTOP_IPC.browserRelease, DESKTOP_IPC.browserClearSite, DESKTOP_IPC.browserClearAllSites,
  ])('rejects guests, foreign windows, subframes and missing sender frames for %s', async (channel) => {
    const reservation = await guests.acquire(sender, 'https://example.com/')
    for (const caller of [
      { sender, senderFrame: { url: 'https://example.com' } },
      { sender: {}, senderFrame: sender.mainFrame },
      { sender, senderFrame: { url: `${SCHEME}://app/subframe` } },
      { sender, senderFrame: null },
    ]) {
      const argument = channel === DESKTOP_IPC.browserAcquire ? 'https://example.com/' : reservation.lease
      await expect(call(channel, caller as IpcMainInvokeEvent, argument)).rejects.toThrow()
    }
    expectUntouched(sessions.get(reservation.partition)!)
    expect(sessions.size).toBe(1)
  })

  it('serves the primary window over IPC with validated site URLs and leases', async () => {
    const reservation = await call(DESKTOP_IPC.browserAcquire, event, 'https://served.example/') as
      Awaited<ReturnType<InstanceType<typeof DesktopBrowserGuests>['acquire']>>
    expect(reservation.partition).toMatch(/^persist:dsh-sidebar-browser-[\da-f]{64}$/)
    await expect(call(DESKTOP_IPC.browserAcquire, event, 'gopher://served.example/')).rejects.toThrow()
    await expect(call(DESKTOP_IPC.browserClearSite, event, 42)).rejects.toThrow()
    await expect(call(DESKTOP_IPC.browserRelease, event, 42)).rejects.toThrow()
    await call(DESKTOP_IPC.browserClearSite, event, reservation.lease)
    expectCleared(sessions.get(reservation.partition)!)
    await call(DESKTOP_IPC.browserClearAllSites, event)
  })

  it('configures a partition session once per origin and keeps guest denial policies on it', async () => {
    await guests.acquire(sender, 'https://configured.example/a')
    await guests.acquire(sender, 'https://configured.example/b')
    const partition = sessions.get(sidebarPartitionName('https://configured.example'))!
    expect(partition.setPermissionRequestHandler).toHaveBeenCalledOnce()
    expect(partition.setPermissionCheckHandler).toHaveBeenCalledOnce()
    expect(partition.setDevicePermissionHandler).toHaveBeenCalledOnce()
    expect(partition.setDisplayMediaRequestHandler).toHaveBeenCalledOnce()
    expect(partition.on).toHaveBeenCalledWith('will-download', expect.any(Function))
    expect(partition.webRequest.onBeforeRequest).toHaveBeenCalledOnce()
  })
})
