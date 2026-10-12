import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { DesktopBrowserGuests } from '../src/browser-guests.ts'

// Clearing checks that Electron keeps `persist:<name>` under `<partitions>/<name>`.
const PARTITIONS = '/partitions'
const storage = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }))
const electronMock = vi.hoisted(() => ({
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
vi.mock('electron', () => electronMock)

function browserGuests(): DesktopBrowserGuests {
  return new DesktopBrowserGuests(() => undefined, PARTITIONS)
}

/** A guest as the lease owner sees it: an emitter with the lifecycle surface bind() touches. */
function fakeGuest(url: string): WebContents & EventEmitter {
  const emitter = new EventEmitter()
  const methods: Pick<WebContents, 'getURL' | 'isDestroyed' | 'close' | 'setWindowOpenHandler'> = {
    getURL: () => url,
    isDestroyed: () => false,
    close: vi.fn(() => { emitter.emit('destroyed') }),
    setWindowOpenHandler: vi.fn(),
  }
  return Object.assign(emitter, methods) as WebContents & EventEmitter
}

/** Bind the lease owner once; attach() then drives the real attach sequence per guest. */
function bindGuests(guests: DesktopBrowserGuests, owner: WebContents & EventEmitter): void {
  const window = { webContents: owner } as BrowserWindow
  guests.bind(window, () => () => {})
}

/**
 * Drive the real attach sequence: attach a webview with the bootstrap URL and
 * fire dom-ready so the reservation's lease gains its guest.
 */
function attach(owner: WebContents & EventEmitter,
  reservation: { readonly lease: string; readonly partition: string }): WebContents & EventEmitter {
  const preventDefault = vi.fn()
  owner.emit('will-attach-webview', { preventDefault }, {},
    { src: `about:blank#${reservation.lease}`, partition: reservation.partition })
  expect(preventDefault).not.toHaveBeenCalled()
  const guest = fakeGuest(`about:blank#${reservation.lease}`)
  owner.emit('did-attach-webview', {}, guest)
  guest.emit('dom-ready')
  return guest
}

describe('DesktopBrowserGuests active tab tracking', () => {
  it('resolves the renderer-reported active lease to its live guest', async () => {
    const guests = browserGuests()
    const owner = new EventEmitter() as WebContents & EventEmitter
    const first = await guests.acquire(owner, 'https://site.example/')
    const second = await guests.acquire(owner, 'https://site.example/')
    bindGuests(guests, owner)
    const firstGuest = attach(owner, first)
    const secondGuest = attach(owner, second)

    expect(guests.getActiveGuest(owner)).toBeUndefined()
    guests.markActive(owner, first.lease)
    expect(guests.getActiveGuest(owner)).toBe(firstGuest)
    guests.markActive(owner, second.lease)
    expect(guests.getActiveGuest(owner)).toBe(secondGuest)

    // A guest focus reprioritizes, covering split panes with several visible tabs.
    firstGuest.emit('focus')
    expect(guests.getActiveGuest(owner)).toBe(firstGuest)

    // Releasing the active tab clears the record; the renderer reports the
    // newly visible tab on its own, and filling a hidden tab would be wrong.
    await guests.release(owner, first.lease)
    expect(guests.getActiveGuest(owner)).toBeUndefined()
    await guests.release(owner, second.lease)
    expect(guests.getActiveGuest(owner)).toBeUndefined()
  })

  it('ignores reports for foreign owners, unknown leases, and non-strings', async () => {
    const guests = browserGuests()
    const owner = new EventEmitter() as WebContents & EventEmitter
    const other = new EventEmitter() as WebContents & EventEmitter
    const reservation = await guests.acquire(owner, 'https://site.example/')
    bindGuests(guests, owner)
    const guest = attach(owner, reservation)

    guests.markActive(other, reservation.lease)
    expect(guests.getActiveGuest(owner)).toBeUndefined()
    guests.markActive(owner, '00000000-0000-4000-8000-000000000000')
    expect(guests.getActiveGuest(owner)).toBeUndefined()
    guests.markActive(owner, 42)
    expect(guests.getActiveGuest(owner)).toBeUndefined()

    guests.markActive(owner, reservation.lease)
    expect(guests.getActiveGuest(owner)).toBe(guest)
  })

  it('drops the active marker when its guest is destroyed', async () => {
    const guests = browserGuests()
    const owner = new EventEmitter() as WebContents & EventEmitter
    const reservation = await guests.acquire(owner, 'https://site.example/')
    bindGuests(guests, owner)
    const guest = attach(owner, reservation)
    guests.markActive(owner, reservation.lease)
    expect(guests.getActiveGuest(owner)).toBe(guest)
    guest.emit('destroyed')
    expect(guests.getActiveGuest(owner)).toBeUndefined()
  })

  it('clears the active marker when the renderer reports the tab hidden', async () => {
    const guests = browserGuests()
    const owner = new EventEmitter() as WebContents & EventEmitter
    const other = new EventEmitter() as WebContents & EventEmitter
    const reservation = await guests.acquire(owner, 'https://site.example/')
    bindGuests(guests, owner)
    const guest = attach(owner, reservation)
    guests.markActive(owner, reservation.lease)
    expect(guests.getActiveGuest(owner)).toBe(guest)
    expect(guests.getActiveLease(owner)).toBe(reservation.lease)

    // A hidden or collapsed tab withdraws its activation and stops being the fill target.
    guests.markInactive(owner, reservation.lease)
    expect(guests.getActiveGuest(owner)).toBeUndefined()
    expect(guests.getActiveLease(owner)).toBeUndefined()

    // Becoming visible again restores the tracked target.
    guests.markActive(owner, reservation.lease)
    expect(guests.getActiveGuest(owner)).toBe(guest)

    // A foreign owner cannot clear this window's activation.
    guests.markInactive(other, reservation.lease)
    expect(guests.getActiveGuest(owner)).toBe(guest)

    // An inactive report for a different lease leaves the tracked target alone.
    guests.markInactive(owner, '00000000-0000-4000-8000-0000000000ff')
    expect(guests.getActiveGuest(owner)).toBe(guest)

    // Non-string reports are ignored.
    guests.markInactive(owner, 42)
    expect(guests.getActiveGuest(owner)).toBe(guest)
  })

  it('never resolves a tab closed by clearing its site as the fill target', async () => {
    const guests = browserGuests()
    const owner = new EventEmitter() as WebContents & EventEmitter
    const cleared = await guests.acquire(owner, 'https://cleared.example/login')
    const sameSite = await guests.acquire(owner, 'https://cleared.example/other')
    const bystander = await guests.acquire(owner, 'https://bystander.example/')
    bindGuests(guests, owner)
    const clearedGuest = attach(owner, cleared)
    const sameSiteGuest = attach(owner, sameSite)
    attach(owner, bystander)
    const closed: string[] = []
    clearedGuest.once('destroyed', () => { closed.push('cleared') })
    sameSiteGuest.once('destroyed', () => { closed.push('sameSite') })
    guests.markActive(owner, cleared.lease)
    expect(guests.getActiveGuest(owner)).toBe(clearedGuest)

    const gate = Promise.withResolvers<undefined>()
    storage.gate = gate.promise
    const clearing = guests.clearSite(owner, cleared.lease)
    // While the partition is being cleared, neither reports nor focus can make its tabs the target.
    expect(guests.getActiveLease(owner)).toBeUndefined()
    expect(guests.getActiveGuest(owner)).toBeUndefined()
    guests.markActive(owner, sameSite.lease)
    sameSiteGuest.emit('focus')
    expect(guests.getActiveLease(owner)).toBeUndefined()
    expect(guests.getGuest(owner, sameSite.lease)).toBeUndefined()
    gate.resolve(undefined)
    storage.gate = undefined
    await clearing

    expect(closed.sort()).toEqual(['cleared', 'sameSite'])
    guests.markActive(owner, cleared.lease)
    guests.markActive(owner, sameSite.lease)
    expect(guests.getActiveLease(owner)).toBeUndefined()
    expect(guests.getActiveGuest(owner)).toBeUndefined()
    // Tabs on other sites stay eligible.
    guests.markActive(owner, bystander.lease)
    expect(guests.getActiveLease(owner)).toBe(bystander.lease)
  })
})
