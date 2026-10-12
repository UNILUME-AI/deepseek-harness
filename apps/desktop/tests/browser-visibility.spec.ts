import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { RendererVisibility, VISIBILITY_CONFIRM_TIMEOUT_MS, type VisibilityAnswerListener } from '../src/browser-visibility.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'

const LEASE = '00000000-0000-4000-8000-0000000000aa' as DesktopBrowserLeaseId

/** Minimal main-process IPC registry delivering answers the way ipcMain does. */
function fakeIpc(): VisibilityAnswerListener & { deliver(channel: string, event: unknown, answer: unknown): void } {
  const handlers = new Map<string, ((event: unknown, answer: unknown) => void)[]>()
  const ipc: VisibilityAnswerListener & { deliver(channel: string, event: unknown, answer: unknown): void } = {
    on(channel: string, listener: (event: never, answer: never) => void) {
      const list = handlers.get(channel) ?? []
      list.push(listener as (event: unknown, answer: unknown) => void)
      handlers.set(channel, list)
      return ipc
    },
    deliver(channel: string, event: unknown, answer: unknown) {
      for (const listener of [...handlers.get(channel) ?? []]) listener(event, answer)
    },
  }
  return ipc
}

/** A primary window WebContents recording the queries it receives. */
function fakeOwner(destroyed = false): WebContents & { sent: unknown[] } {
  const sent: unknown[] = []
  const owner = {
    id: 1,
    isDestroyed: () => destroyed,
    mainFrame: { url: 'dsh-app://app/' },
    sent,
    send: (_channel: string, request: unknown) => { sent.push(request) },
  }
  return owner as WebContents & { sent: unknown[] }
}

/** Reply to the newest outstanding query as the renderer would. */
function reply(ipc: ReturnType<typeof fakeIpc>, owner: WebContents & { sent: unknown[] }, visible: boolean, sender?: WebContents): void {
  const request = owner.sent.at(-1) as { requestId: number }
  ipc.deliver(DESKTOP_IPC.browserVisibilityAnswer,
    { sender: sender ?? owner, senderFrame: (sender ?? owner).mainFrame },
    { requestId: request.requestId, visible })
}

describe('RendererVisibility', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('resolves the renderer answer for the queried lease', async () => {
    const ipc = fakeIpc()
    const visibility = new RendererVisibility(ipc)
    const owner = fakeOwner()
    const pending = visibility.confirm(owner, LEASE)
    expect(owner.sent).toEqual([{ requestId: 1, lease: LEASE }])
    reply(ipc, owner, true)
    await expect(pending).resolves.toBe(true)
  })

  it('resolves false when no answer arrives before the deadline', async () => {
    const ipc = fakeIpc()
    const visibility = new RendererVisibility(ipc)
    const owner = fakeOwner()
    let settled: boolean | undefined
    const pending = visibility.confirm(owner, LEASE).then((value) => { settled = value; return value })
    await vi.advanceTimersByTimeAsync(VISIBILITY_CONFIRM_TIMEOUT_MS - 1)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(false)
  })

  it('resolves false when the renderer reports the lease invisible', async () => {
    const ipc = fakeIpc()
    const visibility = new RendererVisibility(ipc)
    const owner = fakeOwner()
    const pending = visibility.confirm(owner, LEASE)
    reply(ipc, owner, false)
    await expect(pending).resolves.toBe(false)
  })

  it('ignores malformed answers and answers from other senders', async () => {
    const ipc = fakeIpc()
    const visibility = new RendererVisibility(ipc)
    const owner = fakeOwner()
    const foreign = fakeOwner()
    const pending = visibility.confirm(owner, LEASE)
    const request = owner.sent.at(-1) as { requestId: number }
    ipc.deliver(DESKTOP_IPC.browserVisibilityAnswer, { sender: owner, senderFrame: owner.mainFrame }, { requestId: request.requestId })
    ipc.deliver(DESKTOP_IPC.browserVisibilityAnswer, { sender: owner, senderFrame: owner.mainFrame },
      { requestId: request.requestId, visible: 'yes' })
    reply(ipc, owner, true, foreign)
    await Promise.resolve()
    reply(ipc, owner, true)
    await expect(pending).resolves.toBe(true)
  })

  it('resolves false for a destroyed owner and settles pending queries on disposal', async () => {
    const ipc = fakeIpc()
    const visibility = new RendererVisibility(ipc)
    const owner = fakeOwner(true)
    await expect(visibility.confirm(owner, LEASE)).resolves.toBe(false)
    expect(owner.sent).toEqual([])

    const pending = visibility.confirm(fakeOwner(), LEASE)
    visibility.dispose()
    await expect(pending).resolves.toBe(false)
  })
})
