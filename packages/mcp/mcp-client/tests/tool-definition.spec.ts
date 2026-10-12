import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { jsonSchemaToPy, jsonSchemaToTs } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createMcpToolDefinition } from '../src/index.ts'

describe('MCP result callback adaptation', () => {
  it('preserves the exact execution, arguments and canonical structured results', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      let execution: ToolExecution | undefined
      ctx.on('tools/execute', (exec, next) => {
        execution = exec
        return next()
      })
      const call = vi.fn(async () => ({
        content: [{ type: 'text', text: 'Observed window.' }],
        structuredContent: { window: 7 },
      }))
      ctx.tools.register(createMcpToolDefinition(ctx, {
        name: 'native_window', rawName: 'window', description: 'Read the selected window.',
        inputSchema: { type: 'object', properties: { window: { type: 'integer' } } },
        outputSchema: { type: 'object', properties: { window: { type: 'integer' } }, required: ['window'] },
        call,
      }))
      const signal = new AbortController().signal
      const result = await ctx.tools.execute({
        name: 'native_window', callId: ToolCallId('window-call'), arguments: { window: 7 }, signal,
      })
      expect(call).toHaveBeenCalledWith({ window: 7 }, execution)
      expect(execution?.signal).toBe(signal)
      expect(result.isError).toBe(false)
      expect(result.value).toEqual({
        content: [{ type: 'text', text: 'Observed window.' }], structuredContent: { window: 7 },
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each([null, { content: [42] }, { content: [{ type: 'image' }] }])(
    'rejects invalid external results before exposing content (%j)', async (invalid) => {
      const ctx = new Context()
      try {
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        ctx.tools.register(createMcpToolDefinition(ctx, {
          name: 'invalid_result', rawName: 'invalid', description: 'External result fixture.',
          inputSchema: { type: 'object' }, call: async () => invalid,
        }))
        const result = await ctx.tools.execute({
          name: 'invalid_result', callId: ToolCallId('invalid-call'), arguments: {},
          signal: new AbortController().signal,
        })
        expect(result.isError).toBe(true)
        expect(result.value).toBeUndefined()
      } finally {
        await ctx.fiber.dispose()
      }
    },
  )
})

describe('presentation metadata projection', () => {
  const MARK = 'dsh/presentation'
  /** Small cap so boundary payloads stay readable: `{"t":"…"}` serializes to 8 + payload bytes. */
  const CAP = 64

  /** Projection options; omitting the cap means the definition never projects. */
  type Projection = { maxPresentationMetaBytes?: number }

  /** Execute one raw MCP result through a real registry pipeline and return the outcome. */
  async function callWith(
    ctx: Context,
    rawResult: unknown,
    warns: string[],
    projection: Projection = { maxPresentationMetaBytes: CAP },
  ): Promise<ToolExecutionResult> {
    ctx.logger.warn = ((message: unknown) => { warns.push(String(message)) }) as typeof ctx.logger.warn
    ctx.tools.register(createMcpToolDefinition(ctx, {
      name: 'mcp__card__kpi', rawName: 'kpi', description: 'KPI card fixture.',
      inputSchema: { type: 'object' }, call: async () => rawResult,
      ...projection,
    }))
    return ctx.tools.execute({
      name: 'mcp__card__kpi', callId: ToolCallId('card-call'), arguments: {},
      signal: new AbortController().signal,
    })
  }

  async function setup(): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    return ctx
  }

  /** Run one marked payload and return its outcome plus diagnostics. */
  async function project(mark: unknown, projection?: Projection): Promise<{ result: ToolExecutionResult; warns: string[] }> {
    const ctx = await setup()
    try {
      const warns: string[] = []
      const result = await callWith(ctx, {
        _meta: { [MARK]: mark },
        content: [{ type: 'text', text: 'plain' }],
        structuredContent: { answer: 1 },
      }, warns, projection)
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: 'text', text: 'plain' }])
      expect(result.value).toEqual({ content: [{ type: 'text', text: 'plain' }], structuredContent: { answer: 1 } })
      return { result, warns }
    } finally {
      await ctx.fiber.dispose()
    }
  }

  it('projects a marked JSON object onto result meta without changing the canonical value', async () => {
    const card = { kind: 'kpi', title: 'Revenue', value: '42' }
    const { result, warns } = await project(card)
    expect(result.meta).toEqual(card)
    expect(warns).toEqual([])
  })

  it('keeps results presentation-free when the server marks nothing', async () => {
    const warns: string[] = []
    for (const rawResult of [
      { content: [{ type: 'text', text: 'plain' }], structuredContent: { answer: 1 } },
      { _meta: { 'other/namespace': true }, content: [{ type: 'text', text: 'plain' }] },
    ]) {
      const ctx = await setup()
      try {
        const result = await callWith(ctx, rawResult, warns)
        expect(result.isError).toBe(false)
        expect(result).not.toHaveProperty('meta')
        expect(result.content).toEqual([{ type: 'text', text: 'plain' }])
      } finally {
        await ctx.fiber.dispose()
      }
    }
    expect(warns).toEqual([])
  })

  it.each(['text', ['not', 'an', 'object'], null, { broken: undefined }])(
    'keeps results presentation-free for a non-object or non-JSON mark %j', async (mark) => {
      const { result, warns } = await project(mark)
      expect(result).not.toHaveProperty('meta')
      expect(warns).toEqual([])
    },
  )

  it('never projects when the definition has no presentation cap', async () => {
    const { result, warns } = await project({ kind: 'kpi' }, {})
    expect(result).not.toHaveProperty('meta')
    expect(warns).toEqual([])
  })

  it('projects a payload of exactly the cap in serialized bytes', async () => {
    const mark = { t: 'x'.repeat(CAP - 8) }
    expect(Buffer.byteLength(JSON.stringify(mark))).toBe(CAP)
    const { result, warns } = await project(mark)
    expect(result.meta).toEqual(mark)
    expect(warns).toEqual([])
  })

  it('drops a payload one byte over the cap with a content-free diagnostic', async () => {
    const { result, warns } = await project({ t: 'x'.repeat(CAP - 7) })
    expect(result).not.toHaveProperty('meta')
    expect(warns).toEqual([
      `tool "kpi" marked a ${CAP + 1}-byte dsh/presentation payload over the ${CAP}-byte cap; presentation metadata omitted`,
    ])
  })

  it('counts UTF-8 bytes, not characters, against the cap', async () => {
    const mark = { t: '中'.repeat(20) }
    expect(JSON.stringify(mark).length).toBeLessThanOrEqual(CAP)
    const { result, warns } = await project(mark)
    expect(result).not.toHaveProperty('meta')
    expect(warns).toEqual([
      `tool "kpi" marked a 68-byte dsh/presentation payload over the ${CAP}-byte cap; presentation metadata omitted`,
    ])
  })

  it('keeps the PTC mode SDK declaration free of presentation data', () => {
    const definition = createMcpToolDefinition(new Context(), {
      name: 'mcp__card__kpi', rawName: 'kpi', description: 'KPI card fixture.',
      inputSchema: { type: 'object' }, call: async () => ({ content: [] }), maxPresentationMetaBytes: CAP,
    })
    expect(jsonSchemaToTs(definition.output.schema)).toMatchInlineSnapshot(`
      "{
        content: JsonValue[];
        structuredContent?: JsonValue;
      }"
    `)
    expect(jsonSchemaToPy(definition.output.schema)).toMatchInlineSnapshot('"dict[str, Any]"')
  })
})
