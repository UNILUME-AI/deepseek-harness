// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopBrowserReservation } from '../src/types.ts'
import { electronFixture } from './electron-harness.client.ts'
import { browserAddressCheckpoint, currentBrowserTarget, type BrowserTabState } from '../src/client/browser/BrowserPersistence.ts'

const target = { kind: 'https' as const, url: 'https://example.test/', title: 'Example' }
const fixtures: ReturnType<typeof electronFixture>[] = []
function fixture() {
  const h = electronFixture()
  fixtures.push(h)
  return h
}
afterEach(async () => {
  for (const h of fixtures.splice(0)) await h.dispose()
  vi.restoreAllMocks()
})

it('waits for a mounted container and observes native history, titles and new-tab requests', async () => {
  const h = fixture()
  h.frame.goBack()
  h.frame.goForward()
  h.frame.reload()
  h.frame.loadUrl(target)
  expect(h.bridge.acquire).not.toHaveBeenCalled()
  h.mount()
  const guest = await h.guest()
  expect(guest.element.getAttribute('name')).toBe(h.reservation.lease)
  expect(guest.element.getAttribute('partition')).toBe(h.reservation.partition)
  expect(guest.element.getAttribute('src')).toBe(`about:blank#${h.reservation.lease}`)
  guest.emit('dom-ready')
  expect(guest.loadURL).toHaveBeenCalledWith(target.url)
  guest.state.url = target.url
  guest.state.title = 'Title'
  guest.state.back = true
  guest.state.forward = true
  guest.emit('did-navigate')
  expect(guest.clearHistory).toHaveBeenCalledOnce()
  expect(h.frame.getSnapshot()).toMatchObject({ address: 'observed', target: { ...target, title: 'Title' } })
  expect(guest.element.getAttribute('aria-label')).toBe('Title')
  const writes = h.persist.mock.calls.length
  guest.emit('page-title-updated')
  expect(h.persist).toHaveBeenCalledTimes(writes)
  h.frame.loadUrl(target)
  h.frame.goBack()
  h.frame.goForward()
  expect(guest.reload).toHaveBeenCalledOnce()
  expect(guest.goBack).toHaveBeenCalledOnce()
  expect(guest.goForward).toHaveBeenCalledOnce()
  guest.state.url = `${target.url}next`
  guest.emit('did-navigate-in-page', { isMainFrame: false })
  expect(h.frame.getSnapshot().target?.url).toBe(target.url)
  guest.emit('did-navigate-in-page', { isMainFrame: true })
  guest.state.title = ''
  guest.state.loading = false
  guest.emit('page-title-updated')
  guest.emit('did-stop-loading')
  expect(h.frame.getSnapshot()).toMatchObject({ loading: false, target: { url: guest.state.url, title: 'example.test' } })
  const open = h.bridge.onOpenRequested.mock.calls[0]![1]
  open('https://new.example/')
  expect(h.openRequested).toHaveBeenCalledOnce()
  await h.frame.dispose()
  open('https://late.example/')
  guest.emit('did-navigate')
  h.frame.loadUrl(target)
  h.frame.reload()
  h.frame.goBack()
  expect(h.openRequested).toHaveBeenCalledOnce()
  expect(h.opens.size).toBe(0)
  expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
})

it('releases an acquisition that finishes after attachment cancellation', async () => {
  const h = fixture()
  const pending = Promise.withResolvers<DesktopBrowserReservation>()
  h.bridge.acquire.mockReturnValueOnce(pending.promise)
  const unmount = h.mount()
  h.frame.loadUrl(target)
  try {
    await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledOnce() })
    unmount()
    const disposed = h.frame.dispose()
    expect(h.frame.dispose()).toBe(disposed)
    pending.resolve(h.reservation)
    await disposed
    expect(h.guests).toHaveLength(0)
    expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  } finally {
    pending.resolve(h.reservation)
  }
})

it('acquires the first page\'s site and reuses it when recreating the guest', async () => {
  const h = fixture()
  const unmount = h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  expect(h.bridge.acquire).toHaveBeenCalledExactlyOnceWith('https://example.test')
  first.emit('dom-ready')
  expect(h.frame.getSnapshot().site).toBe('https://example.test')
  unmount()
  expect(h.frame.getSnapshot().site).toBeUndefined()
  h.mount()
  const second = await h.guest()
  expect(second.element).not.toBe(first.element)
  expect(h.bridge.acquire).toHaveBeenCalledTimes(2)
  expect(h.bridge.acquire).toHaveBeenLastCalledWith('https://example.test')
  second.emit('dom-ready')
  expect(second.loadURL).toHaveBeenCalledWith(target.url)
  second.emit('render-process-gone')
  expect(h.frame.getSnapshot().error).toBeDefined()
  h.frame.reload()
  const third = await h.guest()
  third.emit('dom-ready')
  expect(third.loadURL).toHaveBeenCalledWith(target.url)
  expect(h.frame.getSnapshot().error).toBeUndefined()
  third.emit('destroyed')
  expect(h.frame.getSnapshot().error).toBeDefined()
})

it('keeps the first site\'s partition after a cross-site sign-in, across remount, crash retry and restart', async () => {
  const h = fixture()
  const unmount = h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  // The page sends the user to another site to sign in; the guest and its partition stay.
  first.state.url = 'https://login.example/session'
  first.emit('did-navigate')
  expect(h.frame.getSnapshot().target?.url).toBe('https://login.example/session')
  const saved = h.persist.mock.lastCall![0] as BrowserTabState
  expect(saved).toMatchObject({ site: 'https://example.test', entries: [{ url: 'https://login.example/session' }] })
  unmount()
  h.mount()
  const remounted = await h.guest()
  expect(h.bridge.acquire).toHaveBeenLastCalledWith('https://example.test')
  remounted.emit('dom-ready')
  expect(remounted.loadURL).toHaveBeenCalledWith('https://login.example/session')
  remounted.emit('render-process-gone')
  h.frame.reload()
  await vi.waitFor(() => { expect(h.guests).toHaveLength(3) })
  expect(h.bridge.acquire).toHaveBeenCalledTimes(3)
  expect(h.bridge.acquire).toHaveBeenLastCalledWith('https://example.test')

  const restarted = electronFixture(saved)
  fixtures.push(restarted)
  restarted.mount()
  // The controller's Restore action loads the saved page.
  restarted.frame.loadUrl(currentBrowserTarget(saved)!)
  const restored = await restarted.guest()
  expect(restarted.bridge.acquire).toHaveBeenCalledExactlyOnceWith('https://example.test')
  restored.emit('dom-ready')
  expect(restored.loadURL).toHaveBeenCalledWith('https://login.example/session')
})

it('acquires a legacy record without a site by its saved page and records that site', async () => {
  const legacy = browserAddressCheckpoint({ kind: 'https', url: 'https://legacy.example/home', title: 'Legacy' }, 1)
  const h = electronFixture(legacy)
  fixtures.push(h)
  h.mount()
  h.frame.loadUrl(currentBrowserTarget(legacy)!)
  await h.guest()
  expect(h.bridge.acquire).toHaveBeenCalledExactlyOnceWith('https://legacy.example')
  expect(h.persist.mock.lastCall![0]).toMatchObject({ site: 'https://legacy.example' })
})

it('clears the live lease\'s partition and reloads the page in a fresh guest without a load failure', async () => {
  const h = fixture()
  h.mount()
  h.frame.loadUrl(target)
  const first = await h.guest()
  first.emit('dom-ready')
  first.state.url = target.url
  first.emit('did-navigate')
  h.bridge.clearSite.mockImplementationOnce(async () => {
    // Main closes the guest before erasing its partition.
    first.emit('destroyed')
    expect(h.frame.getSnapshot().error).toBeUndefined()
  })
  await h.frame.siteData!.clear()
  expect(h.bridge.clearSite).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
  const second = await h.guest()
  expect(second.element).not.toBe(first.element)
  expect(h.bridge.acquire).toHaveBeenLastCalledWith('https://example.test')
  second.emit('dom-ready')
  expect(second.loadURL).toHaveBeenCalledWith(target.url)
  expect(h.frame.getSnapshot().error).toBeUndefined()

  h.bridge.clearSite.mockRejectedValueOnce(new Error('cleanup failed'))
  await expect(h.frame.siteData!.clear()).rejects.toThrow('cleanup failed')
  await vi.waitFor(() => { expect(h.guests).toHaveLength(3) })
})

it('refuses to clear without a live guest', async () => {
  const h = fixture()
  await expect(h.frame.siteData!.clear()).rejects.toThrow('Guest not available')
  expect(h.bridge.clearSite).not.toHaveBeenCalled()
})

it('contains acquisition, native command and release failures and keeps retry available', async () => {
  const h = fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.bridge.acquire.mockRejectedValueOnce(new Error('acquire failed'))
  h.mount()
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  h.frame.reload()
  const guest = await h.guest()
  guest.emit('dom-ready')
  guest.state.url = target.url
  guest.emit('did-navigate')
  guest.reload.mockImplementationOnce(() => { throw new Error('command failed') })
  h.frame.reload()
  expect(h.frame.getSnapshot().error).toBeDefined()
  h.frame.reload()
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.getURL.mockImplementationOnce(() => { throw new Error('observation failed') })
  guest.emit('did-navigate')
  expect(h.frame.getSnapshot().error).toBeDefined()
  h.bridge.release.mockRejectedValueOnce(new Error('release failed'))
  await h.frame.dispose()
  expect(error.mock.calls.some(call => call[0] === 'Desktop browser guest release failed')).toBe(true)
})

it('ignores superseded and aborted load promises, but publishes an active navigation rejection', async () => {
  const h = fixture()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.mount()
  h.frame.loadUrl(target)
  const guest = await h.guest()
  const stale = Promise.withResolvers<undefined>()
  guest.loadURL.mockReturnValueOnce(stale.promise)
  guest.emit('dom-ready')
  h.frame.loadUrl({ ...target, url: 'https://example.test/new' })
  stale.reject(new Error('old navigation failed'))
  await expect(stale.promise).rejects.toThrow('old navigation')
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.loadURL.mockRejectedValueOnce(Object.assign(new Error('aborted'), { code: 'ERR_ABORTED' }))
  h.frame.loadUrl({ ...target, url: 'https://example.test/cancelled' })
  await Promise.resolve()
  expect(h.frame.getSnapshot().error).toBeUndefined()
  guest.loadURL.mockRejectedValueOnce(new Error('active navigation failed'))
  h.frame.loadUrl(target)
  await vi.waitFor(() => { expect(h.frame.getSnapshot().error).toBeDefined() })
  expect(error).toHaveBeenCalledOnce()
})
