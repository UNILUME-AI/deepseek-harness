/** Caller metadata reaches the MCP server separately for every tool request. */

import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Client, InMemoryTransport, type JSONRPCRequest, type Transport } from '@modelcontextprotocol/client'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from '../src/index.ts'
import { createFixtureServer } from './fixture-server.ts'

const { mockTransport } = vi.hoisted(() => ({ mockTransport: vi.fn<() => Transport>() }))
vi.mock('../src/transport.ts', () => ({ createTransport: mockTransport }))

type CallHooks = Pick<Config, 'callMeta' | 'decorateTool'>

async function connect(transport: Config['transport'], hooks: CallHooks = {}, legacy = false) {
  const ctx = new Context()
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const serving = serveStdio(createFixtureServer, { transport: serverTransport })
  onTestFinished(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      await serving.close()
    }
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)

  const callTool = vi.spyOn(Client.prototype, 'callTool')
  onTestFinished(() => { callTool.mockRestore() })
  if (legacy) {
    // Legacy MCP has no SDK-owned request envelope, so omission is observable on the wire.
    // oxlint-disable-next-line typescript/unbound-method -- The forwarding spy binds the captured method with call(this, ...).
    const originalConnect = Client.prototype.connect
    const connectSpy = vi.spyOn(Client.prototype, 'connect').mockImplementation(function (this: Client, wire, options) {
      this.setVersionNegotiation({ mode: 'legacy' })
      return originalConnect.call(this, wire, options)
    })
    onTestFinished(() => { connectSpy.mockRestore() })
  }

  const receive = serverTransport.onmessage
  if (receive === undefined) throw new Error('fixture server has no request receiver')
  const requests: JSONRPCRequest[] = []
  serverTransport.onmessage = (message, extra) => {
    if ('id' in message && 'method' in message && message.method === 'tools/call') {
      requests.push(structuredClone(message))
    }
    receive(message, extra)
  }
  mockTransport.mockReturnValue(clientTransport)

  const common = {
    serverName: 'fixture',
    toolCallTimeoutMs: 60_000,
    failOnStartupError: true,
    reconnect: { enabled: false },
    ...hooks,
  }
  const config: Config = transport === 'stdio'
    ? { ...common, transport, command: 'fixture', args: [], env: {}, cwd: '' }
    : { ...common, transport, url: 'https://fixture.invalid/mcp', headers: {} }
  await apply(ctx, config)
  return { ctx, requests, callTool }
}

describe.each(['stdio', 'streamable-http'] as const)('callMeta over %s', (transport) => {
  it('computes metadata from the current execution before every request', async () => {
    const executions: ToolExecution[] = []
    const callMeta = vi.fn((execution: ToolExecution, rawName: string) => {
      executions.push(execution)
      return { sessionId: 'session-1', turnId: execution.callId, tool: rawName, detail: { caller: 'host' } }
    })
    const { ctx, requests, callTool } = await connect(transport, { callMeta })
    const signal = new AbortController().signal

    for (const callId of ['turn-1', 'turn-2']) {
      const result = await ctx.tools.execute({
        callId: ToolCallId(callId), name: 'mcp__fixture__add', arguments: { a: 2, b: 3 }, signal,
      })
      expect(result).toMatchObject({ isError: false, content: [{ type: 'text', text: '5' }] })
    }

    expect(callMeta).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(2)
    for (const [index, callId] of ['turn-1', 'turn-2'].entries()) {
      expect(callMeta).toHaveBeenNthCalledWith(index + 1, executions[index], 'add')
      expect(executions[index]).toMatchObject({ callId, signal, name: 'mcp__fixture__add' })
      const meta = { sessionId: 'session-1', turnId: callId, tool: 'add', detail: { caller: 'host' } }
      expect(callTool.mock.calls[index]?.[0]).toEqual({ name: 'add', arguments: { a: 2, b: 3 }, _meta: meta })
      expect(requests[index]?.params).toMatchObject({ name: 'add', arguments: { a: 2, b: 3 }, _meta: meta })
    }
    expect(executions[0]).not.toBe(executions[1])
  })

  it.each([
    { label: 'no hook is configured', hooks: {} },
    { label: 'the hook returns undefined', hooks: { callMeta: () => undefined } },
  ])('omits metadata when $label, including sibling requests', async ({ hooks }) => {
    const { ctx, requests, callTool } = await connect(transport, {
      ...hooks,
      decorateTool: (tool, callSibling) => tool.rawName === 'add'
        ? {
          ...tool,
          call: async (args, execution) => {
            await callSibling('greet', { name: 'Caller' }, execution)
            return tool.call(args, execution)
          },
        }
        : tool,
    }, true)

    const result = await ctx.tools.execute({
      callId: ToolCallId('without-meta'), name: 'mcp__fixture__add', arguments: { a: 2, b: 3 },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(callTool.mock.calls.map(call => call[0])).toEqual([
      { name: 'greet', arguments: { name: 'Caller' } },
      { name: 'add', arguments: { a: 2, b: 3 } },
    ])
    expect(requests.map(request => request.params)).toEqual([
      { name: 'greet', arguments: { name: 'Caller' } },
      { name: 'add', arguments: { a: 2, b: 3 } },
    ])
    for (const request of requests) expect(request.params).not.toHaveProperty('_meta')
  })

  it('computes sibling metadata with the sibling raw name and the same execution', async () => {
    const executions: ToolExecution[] = []
    const callMeta = vi.fn((execution: ToolExecution, rawName: string) => {
      executions.push(execution)
      return { callId: execution.callId, rawName, sequence: executions.length }
    })
    const { ctx, requests, callTool } = await connect(transport, {
      callMeta,
      decorateTool: (tool, callSibling) => tool.rawName === 'add'
        ? {
          ...tool,
          call: async (args, execution) => {
            await callSibling('greet', { name: 'Caller' }, execution)
            return tool.call(args, execution)
          },
        }
        : tool,
    })
    const result = await ctx.tools.execute({
      callId: ToolCallId('decorated'), name: 'mcp__fixture__add', arguments: { a: 2, b: 3 },
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(false)
    expect(callMeta).toHaveBeenCalledTimes(2)
    expect(executions[0]).toBe(executions[1])
    expect(callMeta).toHaveBeenNthCalledWith(1, executions[0], 'greet')
    expect(callMeta).toHaveBeenNthCalledWith(2, executions[0], 'add')
    expect(requests).toHaveLength(2)
    for (const [index, rawName] of ['greet', 'add'].entries()) {
      const meta = { callId: 'decorated', rawName, sequence: index + 1 }
      expect(callTool.mock.calls[index]?.[0]._meta).toEqual(meta)
      expect(requests[index]?.params?._meta).toMatchObject(meta)
    }
  })

  it.each([
    { label: 'an Error', error: new Error('caller context unavailable') },
    { label: 'a string', error: 'caller context unavailable' },
  ])('fails a call without sending a request when the metadata hook throws $label', async ({ error }) => {
    const { ctx, requests, callTool } = await connect(transport, {
      callMeta: () => { throw error },
    })
    const result = await ctx.tools.execute({
      callId: ToolCallId('failed-meta'), name: 'mcp__fixture__add', arguments: { a: 2, b: 3 },
      signal: new AbortController().signal,
    })

    expect(result.isError).toBe(true)
    expect(result.error?.message).toBe('mcp-client(fixture): callMeta failed for tool "add": caller context unavailable')
    expect(callTool).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })

  it('rejects the sibling promise without sending a request when its metadata hook throws', async () => {
    let siblingRejected = false
    const { ctx, requests, callTool } = await connect(transport, {
      callMeta: () => { throw new Error('caller context unavailable') },
      decorateTool: (tool, callSibling) => tool.rawName === 'add'
        ? {
          ...tool,
          call: (_args, execution) => callSibling('greet', { name: 'Caller' }, execution).catch((error: unknown) => {
            siblingRejected = true
            throw error
          }),
        }
        : tool,
    })
    const result = await ctx.tools.execute({
      callId: ToolCallId('failed-sibling-meta'), name: 'mcp__fixture__add', arguments: { a: 2, b: 3 },
      signal: new AbortController().signal,
    })

    expect(siblingRejected).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.error?.message).toBe('mcp-client(fixture): callMeta failed for tool "greet": caller context unavailable')
    expect(callTool).not.toHaveBeenCalled()
    expect(requests).toEqual([])
  })
})
