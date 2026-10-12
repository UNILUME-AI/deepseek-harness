// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { electronFixture } from './electron-harness.client.ts'
import type { CredentialId, DesktopCredentialsBridge } from '../src/types.ts'

const credentialBridge = (id: CredentialId): DesktopCredentialsBridge => ({
  list: vi.fn(async () => []),
  add: vi.fn(async () => id),
  remove: vi.fn(async () => {}),
  fill: vi.fn(async () => ({ filled: [], notFound: [] })),
})

it('reports activation immediately once the guest lease exists', async () => {
  const id = '00000000-0000-4000-8000-000000000001' as CredentialId
  const fixture = electronFixture(undefined, credentialBridge(id))
  try {
    fixture.mount()
    fixture.frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'Example' })
    await fixture.guest()
    fixture.credentials?.reportActive()
    expect(fixture.bridge.reportActive).toHaveBeenCalledExactlyOnceWith(fixture.reservation.lease)
    fixture.credentials?.reportActive()
    expect(fixture.bridge.reportActive).toHaveBeenCalledTimes(2)
  } finally { await fixture.dispose() }
})

it('defers an early activation report until the lease is acquired', async () => {
  const id = '00000000-0000-4000-8000-000000000001' as CredentialId
  const fixture = electronFixture(undefined, credentialBridge(id))
  try {
    fixture.credentials?.reportActive()
    expect(fixture.bridge.reportActive).not.toHaveBeenCalled()
    fixture.mount()
    fixture.frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'Example' })
    await fixture.guest()
    expect(fixture.bridge.reportActive).toHaveBeenCalledExactlyOnceWith(fixture.reservation.lease)
  } finally { await fixture.dispose() }
})

it('stops reporting after disposal', async () => {
  const id = '00000000-0000-4000-8000-000000000001' as CredentialId
  const fixture = electronFixture(undefined, credentialBridge(id))
  fixture.mount()
  fixture.frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'Example' })
  await fixture.guest()
  await fixture.dispose()
  fixture.credentials?.reportActive()
  expect(fixture.bridge.reportActive).not.toHaveBeenCalled()
  fixture.credentials?.reportInactive()
  expect(fixture.bridge.reportInactive).not.toHaveBeenCalled()
})

it('reports deactivation once the guest lease exists and cancels a pending activation', async () => {
  const id = '00000000-0000-4000-8000-000000000001' as CredentialId
  const fixture = electronFixture(undefined, credentialBridge(id))
  try {
    fixture.mount()
    fixture.frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'Example' })
    await fixture.guest()
    fixture.credentials?.reportInactive()
    expect(fixture.bridge.reportInactive).toHaveBeenCalledExactlyOnceWith(fixture.reservation.lease)

    // A hidden tab's earlier queued activation must not fire when the lease arrives.
    const hidden = electronFixture(undefined, credentialBridge(id))
    try {
      hidden.credentials?.reportActive()
      hidden.credentials?.reportInactive()
      hidden.mount()
      hidden.frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'Example' })
      await hidden.guest()
      expect(hidden.bridge.reportActive).not.toHaveBeenCalled()
      expect(hidden.bridge.reportInactive).not.toHaveBeenCalled()
    } finally { await hidden.dispose() }
  } finally { await fixture.dispose() }
})

it('drops a deactivation reported before the lease exists', async () => {
  const id = '00000000-0000-4000-8000-000000000001' as CredentialId
  const fixture = electronFixture(undefined, credentialBridge(id))
  try {
    fixture.credentials?.reportInactive()
    expect(fixture.bridge.reportInactive).not.toHaveBeenCalled()
    fixture.mount()
    fixture.frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'Example' })
    await fixture.guest()
    // No lease existed when the tab hid, so nothing was ever reported and
    // nothing becomes active: the pending flag was cleared, not deferred.
    expect(fixture.bridge.reportActive).not.toHaveBeenCalled()
    expect(fixture.bridge.reportInactive).not.toHaveBeenCalled()
  } finally { await fixture.dispose() }
})
