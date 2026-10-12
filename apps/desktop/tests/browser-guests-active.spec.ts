import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import { DesktopBrowserGuests } from '../src/browser-guests.ts'

const electronMock = vi.hoisted(() => ({
  app: { isPackaged: true },
  session: {
    fromPartition: vi.fn(() => ({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
    })),
  },
}))
vi.mock('electron', () => electronMock)

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
    const guests = new DesktopBrowserGuests(() => undefined)
    const owner = new EventEmitter() as WebContents & EventEmitter
    const first = guests.acquire(owner, 'workspace')
    const second = guests.acquire(owner, 'workspace')
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

  it('ignores reports for foreign owners, unknown leases, and non-strings', () => {
    const guests = new DesktopBrowserGuests(() => undefined)
    const owner = new EventEmitter() as WebContents & EventEmitter
    const other = new EventEmitter() as WebContents & EventEmitter
    const reservation = guests.acquire(owner, 'workspace')
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
    const guests = new DesktopBrowserGuests(() => undefined)
    const owner = new EventEmitter() as WebContents & EventEmitter
    const reservation = guests.acquire(owner, 'workspace')
    bindGuests(guests, owner)
    const guest = attach(owner, reservation)
    guests.markActive(owner, reservation.lease)
    expect(guests.getActiveGuest(owner)).toBe(guest)
    guest.emit('destroyed')
    expect(guests.getActiveGuest(owner)).toBeUndefined()
  })

  it('clears the active marker when the renderer reports the tab hidden', async () => {
    const guests = new DesktopBrowserGuests(() => undefined)
    const owner = new EventEmitter() as WebContents & EventEmitter
    const other = new EventEmitter() as WebContents & EventEmitter
    const reservation = guests.acquire(owner, 'workspace')
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
})
