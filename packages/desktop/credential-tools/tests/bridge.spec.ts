/** Bridge correlation and wire validation against a fake IPC port. */
import { describe, expect, it, vi } from 'vitest'
import { DesktopCredentialBridge, type CredentialBridgePort, type ProcessLike } from '../src/bridge.ts'
import { credentialId, type CredentialRequestMessage } from '../src/protocol.ts'

class FakePort implements CredentialBridgePort {
  connected = true
  readonly sent: CredentialRequestMessage[] = []
  private readonly listeners = new Set<(message: unknown) => void>()
  private readonly disconnects = new Set<() => void>()
  failSend = false

  send(message: CredentialRequestMessage): void {
    if (this.failSend || !this.connected) throw new Error('IPC channel unavailable')
    this.sent.push(message)
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnects.add(listener)
    return () => { this.disconnects.delete(listener) }
  }

  emit(message: unknown): void {
    for (const listener of [...this.listeners]) listener(message)
  }

  disconnect(): void {
    this.connected = false
    for (const listener of [...this.disconnects]) listener()
  }
}

function fixture(): { port: FakePort; bridge: DesktopCredentialBridge } {
  const port = new FakePort()
  return { port, bridge: new DesktopCredentialBridge(port) }
}

describe('DesktopCredentialBridge', () => {
  it('correlates concurrent requests by requestId and returns metadata only', async () => {
    const { port, bridge } = fixture()
    const list = bridge.list()
    const fill = bridge.fill(credentialId('00000000-0000-4000-8000-000000000001'), ['username', 'password'])
    expect(port.sent).toEqual([
      { type: 'credentials-list', requestId: 1 },
      { type: 'credentials-fill', requestId: 2, credentialId: '00000000-0000-4000-8000-000000000001', fields: ['username', 'password'] },
    ])
    port.emit({
      type: 'credentials-fill', requestId: 2,
      filled: ['username'], notFound: ['password'],
    })
    port.emit({
      type: 'credentials-list', requestId: 1, site: 'https://example.com',
      entries: [{ id: '00000000-0000-4000-8000-000000000001', origin: 'https://example.com', label: 'Shop', username: 'alice', hasTotp: true }],
    })
    await expect(fill).resolves.toEqual({ ok: true, filled: ['username'], notFound: ['password'] })
    await expect(list).resolves.toEqual({
      ok: true, site: 'https://example.com',
      entries: [{ id: '00000000-0000-4000-8000-000000000001', origin: 'https://example.com', label: 'Shop', username: 'alice', hasTotp: true }],
    })
    bridge.dispose()
  })

  it.each(['denied', 'no-active-page', 'no-window', 'not-found', 'origin-mismatch', 'error', 'unavailable'] as const)
  ('passes the %s category through without a message', async (error) => {
    const { port, bridge } = fixture()
    const request = bridge.list()
    port.emit({ type: 'credentials-list', requestId: 1, error })
    await expect(request).resolves.toEqual({ ok: false, error })
    bridge.dispose()
  })

  it.each([
    { type: 'credentials-list', requestId: 1, site: 42, entries: [] },
    { type: 'credentials-list', requestId: 1, site: 'https://example.com', entries: [{ id: 'x', label: 'l' }] },
    { type: 'credentials-list', requestId: 1, error: 'unknown-kind' },
    { type: 'credentials-fill', requestId: 1, filled: ['username'], notFound: ['bogus'] },
    { type: 'credentials-fill', requestId: 1, filled: 'username', notFound: [] },
    { type: 'credentials-fill', requestId: 1, error: { kind: 'denied' } },
  ])('settles a malformed response as error: %j', async (response) => {
    const { port, bridge } = fixture()
    const request = response.type === 'credentials-list' ? bridge.list() : bridge.fill(credentialId('id'), ['password'])
    port.emit(response)
    await expect(request).resolves.toEqual({ ok: false, error: 'error' })
    bridge.dispose()
  })

  it('ignores unrelated messages, unknown ids, and late answers', async () => {
    const { port, bridge } = fixture()
    const list = bridge.list()
    port.emit(undefined)
    port.emit({ type: 'update-tasks', requestId: 1, active: true })
    port.emit({ type: 'credentials-list', requestId: 99, site: 'https://x.example', entries: [] })
    port.emit({ type: 'credentials-list', requestId: '1', site: 'https://x.example', entries: [] })
    port.emit({ type: 'credentials-list', requestId: 1, site: 'https://example.com', entries: [] })
    await expect(list).resolves.toEqual({ ok: true, site: 'https://example.com', entries: [] })
    // A second answer for the settled id is dropped.
    port.emit({ type: 'credentials-list', requestId: 1, error: 'denied' })
    bridge.dispose()
  })

  it('answers unavailable without sending when the channel is down', async () => {
    const { port, bridge } = fixture()
    port.connected = false
    await expect(bridge.list()).resolves.toEqual({ ok: false, error: 'unavailable' })
    expect(port.sent).toEqual([])
    bridge.dispose()
  })

  it('settles pending requests unavailable on disconnect and on dispose', async () => {
    const { port, bridge } = fixture()
    const stuck = bridge.fill(credentialId('id'), ['totp'])
    port.disconnect()
    await expect(stuck).resolves.toEqual({ ok: false, error: 'unavailable' })
    const afterDisconnect = bridge.list()
    await expect(afterDisconnect).resolves.toEqual({ ok: false, error: 'unavailable' })

    const second = fixture()
    const pending = second.bridge.list()
    second.bridge.dispose()
    await expect(pending).resolves.toEqual({ ok: false, error: 'unavailable' })
    // Disposal unsubscribes: a late answer reaches nobody.
    expect(() => { second.port.emit({ type: 'credentials-list', requestId: 1, site: 's', entries: [] }) }).not.toThrow()
  })

  it('settles unavailable when the port throws on send', async () => {
    const { port, bridge } = fixture()
    port.failSend = true
    await expect(bridge.list()).resolves.toEqual({ ok: false, error: 'unavailable' })
    bridge.dispose()
  })

  it('settles locally on abort while the shell proceeds unaware', async () => {
    const { port, bridge } = fixture()
    const abort = new AbortController()
    const request = bridge.list(abort.signal)
    abort.abort()
    await expect(request).resolves.toEqual({ ok: false, error: 'unavailable' })
    // The late shell answer is dropped, not delivered.
    port.emit({ type: 'credentials-list', requestId: 1, site: 'https://example.com', entries: [] })
    bridge.dispose()
  })

  it('adapts the host process to the port contract', async () => {
    const listeners = new Map<string, Set<(...args: never[]) => void>>()
    const send = vi.fn<NonNullable<ProcessLike['send']>>((_message, callback) => { callback(null) })
    const target: ProcessLike = {
      connected: true,
      send,
      on: (type, listener) => {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      off: (type, listener) => {
        listeners.get(type)?.delete(listener)
      },
    }
    const { processBridgePort } = await import('../src/bridge.ts')
    const port = processBridgePort(target)
    port.send({ type: 'credentials-list', requestId: 1 })
    expect(send).toHaveBeenCalledWith({ type: 'credentials-list', requestId: 1 }, expect.any(Function))
    const stop = port.onMessage(() => {})
    expect(listeners.get('message')?.size).toBe(1)
    stop()
    expect(listeners.get('message')?.size).toBe(0)
  })
})
