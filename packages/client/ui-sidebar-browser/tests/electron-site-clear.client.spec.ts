// @vitest-environment jsdom
/** Clearing one site partition must restore every tab whose guest it closed, and only those. */
import { afterEach, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '../src/types.ts'
import { createBrowserControllers, type BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { createBrowserStore } from '../src/client/browser/store.ts'
import type { BrowserPageFactory } from '../src/client/browser/BrowserPage.ts'
import { createElectronPage } from '../src/client/electron/pages.ts'
import { ElectronWebviewPresentation, type WebviewElement } from '../src/client/electron/ElectronWebviewPresentation.ts'

const APPLICATION_ORIGIN = 'https://app.example'
const SHARED_A = 'https://shared.example/one'
const SHARED_B = 'https://shared.example/two'
const SOLO = 'https://solo.example/one'
const TAB_A = 'tab-a' as TabId
const TAB_B = 'tab-b' as TabId
const TAB_C = 'tab-c' as TabId

interface PreparedGuest {
  readonly element: WebviewElement
  readonly state: { url: string; title: string; loading: boolean; back: boolean; forward: boolean }
  readonly emit: (type: string, fields?: object) => void
  readonly loadURL: ReturnType<typeof vi.fn>
}

function prepareGuest(element: WebviewElement): PreparedGuest {
  const state = { url: 'about:blank', title: '', loading: true, back: false, forward: false }
  const methods = {
    loadURL: vi.fn(async (_url: string) => {}), getURL: vi.fn(() => state.url), getTitle: vi.fn(() => state.title),
    canGoBack: () => state.back, canGoForward: () => state.forward, clearHistory: vi.fn(),
    goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn(), isLoading: () => state.loading,
  }
  Object.assign(element, methods)
  const emit = (type: string, fields: object = {}): void => { element.dispatchEvent(Object.assign(new Event(type), fields)) }
  return { element, state, emit, ...methods }
}

/** Three Electron tabs over one bridge; the bridge closes every guest of a cleared partition like main does. */
function harness() {
  let sequence = 0
  const leasePartitions = new Map<string, string>()
  const guestsByLease = new Map<string, PreparedGuest>()
  const guestByElement = new WeakMap<HTMLElement, PreparedGuest>()
  const hosts = new Map<TabId, { readonly host: HTMLElement; readonly lifetime: AbortController }>()
  const bridge = {
    acquire: vi.fn(async (site: string) => {
      const lease = `lease-${++sequence}` as DesktopBrowserLeaseId
      const partition = `persist:${site}`
      leasePartitions.set(lease, partition)
      return { lease, partition }
    }),
    release: vi.fn(async (_lease: DesktopBrowserLeaseId) => {}),
    reportActive: vi.fn((_lease: DesktopBrowserLeaseId) => {}),
    reportInactive: vi.fn((_lease: DesktopBrowserLeaseId) => {}),
    clearSite: vi.fn(async (lease: DesktopBrowserLeaseId) => {
      const partition = leasePartitions.get(lease)
      for (const [id, guest] of guestsByLease) {
        if (leasePartitions.get(id) === partition) guest.emit('destroyed')
      }
    }),
    clearAllSites: vi.fn(async () => {}),
    onOpenRequested: vi.fn((_lease: DesktopBrowserLeaseId, _listener: (url: string) => void) => () => {}),
  } satisfies DesktopBrowserBridge
  const createPage: BrowserPageFactory = (options) => {
    const page = createElectronPage(options, bridge)
    if (!(page.presentation instanceof ElectronWebviewPresentation)) throw new Error('expected the Electron presentation')
    const presentation = page.presentation
    const create = presentation.createElement.bind(presentation)
    vi.spyOn(presentation, 'createElement').mockImplementation((reservation) => {
      const guest = prepareGuest(create(reservation))
      guestsByLease.set(reservation.lease, guest)
      guestByElement.set(guest.element, guest)
      return guest.element
    })
    return page
  }
  const store = createBrowserStore().create('electron-site-clear')
  const injected: BrowserInjected = createBrowserControllers(store.actions, createPage, () => true, () => bridge.clearAllSites())
  return {
    bridge, injected,
    host: (tab: TabId): HTMLElement => hosts.get(tab)!.host,
    frameState: (tab: TabId) => injected.keyedHooks.browserState(tab)!.getSnapshot().frame,
    open(tab: TabId, url: string) {
      const host = document.createElement('div')
      host.id = `host-${tab}`
      document.body.append(host)
      const lifetime = new AbortController()
      hosts.set(tab, { host, lifetime })
      injected.mount({ tabId: tab, signal: lifetime.signal, viewportId: host.id, applicationOrigin: APPLICATION_ORIGIN,
        initial: undefined, initialUrl: url, openTab: vi.fn() })
    },
    /** Drive the tab's current guest through its bootstrap load of `url`; `previous` waits for a replacement guest. */
    async settle(tab: TabId, url: string, previous?: WebviewElement): Promise<PreparedGuest> {
      const element = await vi.waitFor(() => {
        const current = hosts.get(tab)!.host.firstElementChild as WebviewElement | null
        if (current === null) throw new Error(`tab ${tab} has no live guest`)
        if (current === previous) throw new Error(`tab ${tab} still holds the replaced guest`)
        return current
      })
      const guest = guestByElement.get(element)
      if (guest === undefined) throw new Error(`tab ${tab} guest is not prepared`)
      guest.emit('dom-ready')
      guest.state.url = url
      guest.emit('did-navigate')
      return guest
    },
    async dispose() {
      await injected.dispose()
      for (const { host, lifetime } of hosts.values()) { lifetime.abort(); host.remove() }
      hosts.clear()
    },
  }
}

const harnesses: ReturnType<typeof harness>[] = []
function fixture() {
  const h = harness()
  harnesses.push(h)
  return h
}
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose()
  vi.restoreAllMocks()
})

it('clears one site partition and restores every tab it closed, leaving other partitions untouched', async () => {
  const h = fixture()
  h.open(TAB_A, SHARED_A)
  h.open(TAB_B, SHARED_B)
  h.open(TAB_C, SOLO)
  const firstA = await h.settle(TAB_A, SHARED_A)
  const firstB = await h.settle(TAB_B, SHARED_B)
  const firstC = await h.settle(TAB_C, SOLO)
  expect(h.bridge.acquire.mock.calls.map(call => call[0])).toEqual(
    ['https://shared.example', 'https://shared.example', 'https://solo.example'])
  expect(firstA.loadURL).toHaveBeenCalledExactlyOnceWith(SHARED_A)
  expect(firstB.loadURL).toHaveBeenCalledExactlyOnceWith(SHARED_B)
  expect(firstC.loadURL).toHaveBeenCalledExactlyOnceWith(SOLO)

  await h.injected.clearSite!(TAB_A)

  // Clearing closed both guests of the shared partition; each tab reloads its own page in a fresh guest.
  const secondA = await h.settle(TAB_A, SHARED_A, firstA.element)
  const secondB = await h.settle(TAB_B, SHARED_B, firstB.element)
  expect(secondA.loadURL).toHaveBeenCalledExactlyOnceWith(SHARED_A)
  expect(secondB.loadURL).toHaveBeenCalledExactlyOnceWith(SHARED_B)
  expect(h.frameState(TAB_A).error).toBeUndefined()
  expect(h.frameState(TAB_B).error).toBeUndefined()
  expect(h.bridge.release).toHaveBeenCalledWith('lease-1' as DesktopBrowserLeaseId)
  expect(h.bridge.release).toHaveBeenCalledWith('lease-2' as DesktopBrowserLeaseId)

  // The tab in the other partition kept its guest, its page and its session.
  expect(h.host(TAB_C).firstElementChild).toBe(firstC.element)
  expect(firstC.loadURL).toHaveBeenCalledExactlyOnceWith(SOLO)
  expect(h.frameState(TAB_C).error).toBeUndefined()
  expect(h.bridge.acquire.mock.calls.map(call => call[0])).toEqual(
    ['https://shared.example', 'https://shared.example', 'https://solo.example', 'https://shared.example', 'https://shared.example'])
})
