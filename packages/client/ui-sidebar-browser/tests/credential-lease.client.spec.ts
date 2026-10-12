// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { electronFixture } from './electron-harness.client.ts'
import type { CredentialId, DesktopCredentialsBridge } from '../src/types.ts'

it('binds credential fills to the ready guest lease and rejects fills after disposal', async () => {
  const id = '00000000-0000-4000-8000-000000000001' as CredentialId
  const bridge = { list: vi.fn(async () => []), add: vi.fn(async () => id), remove: vi.fn(async () => {}),
    fill: vi.fn<DesktopCredentialsBridge['fill']>(async request => ({ filled: [...request.fields], notFound: [] })),
  }
  const fixture = electronFixture(undefined, bridge)
  try {
    const credentials = fixture.credentials
    if (credentials === undefined) throw new Error('Credential provider missing')
    await expect(credentials.fill(id, ['password'])).rejects.toThrow('Guest not available')
    fixture.mount()
    fixture.frame.loadUrl({ kind: 'https', url: 'https://example.com/', title: 'Example' })
    const guest = await fixture.guest()
    guest.emit('dom-ready')
    await credentials.list('https://example.com')
    await credentials.add('https://example.com', 'Site', 'alice', 'fixture-password')
    await credentials.remove(id)
    expect(bridge.list).toHaveBeenCalledWith('https://example.com')
    expect(bridge.add).toHaveBeenCalledWith('https://example.com', 'Site', 'alice', 'fixture-password', undefined)
    expect(bridge.remove).toHaveBeenCalledWith(id)
    expect(await credentials.fill(id, ['username', 'password'])).toEqual({ filled: ['username', 'password'], notFound: [] })
    expect(bridge.fill).toHaveBeenCalledExactlyOnceWith({ lease: fixture.reservation.lease, credentialId: id, fields: ['username', 'password'] })
    await fixture.dispose()
    await expect(credentials.fill(id, ['password'])).rejects.toThrow('Guest not available')
    expect(bridge.fill).toHaveBeenCalledTimes(1)
  } finally { await fixture.dispose() }
})
