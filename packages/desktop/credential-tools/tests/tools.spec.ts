/**
 * Tool behavior over the real registry pipeline: a stub bridge stands in for the
 * Electron shell (the external boundary), while registration, argument validation,
 * output validation, and rendering all run through the shipping `ctx.tools`.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createCredentialTools, CREDENTIALS_FILL_TOOL, CREDENTIALS_LIST_TOOL, type CredentialToolBridge } from '../src/index.ts'
import { credentialId, type CredentialFillResult, type CredentialListResult } from '../src/protocol.ts'

const SECRET = 'p"a\\b\n秘\u2028\u2029c'

interface Fixture {
  readonly ctx: Context
  readonly bridge: {
    list: (signal?: AbortSignal) => Promise<CredentialListResult>
    fill: CredentialToolBridge['fill']
    calls: { list: number; fill: { credentialId: string; fields: readonly string[] }[] }
  }
}

async function setup(results: {
  list?: CredentialListResult
  fill?: CredentialFillResult
}): Promise<Fixture> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const calls: Fixture['bridge']['calls'] = { list: 0, fill: [] }
  const bridge: CredentialToolBridge = {
    list: async () => {
      calls.list++
      return results.list ?? { ok: true, site: 'https://example.com', entries: [] }
    },
    fill: async (credentialId, fields) => {
      calls.fill.push({ credentialId, fields })
      return results.fill ?? { ok: true, filled: [...fields], notFound: [] }
    },
  }
  const disposers = createCredentialTools(bridge).map(tool => ctx.tools.register(tool))
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'test: credential tools')
  return { ctx, bridge: { ...bridge, calls } }
}

let callCounter = 0
async function callTool(ctx: Context, name: string, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('desktop credential tools', () => {
  it('registers both tools with reference-only parameters', async () => {
    const { ctx } = await setup({})
    try {
      const schemas = ctx.tools.schemas()
      const list = schemas.find(schema => schema.name === CREDENTIALS_LIST_TOOL)
      const fill = schemas.find(schema => schema.name === CREDENTIALS_FILL_TOOL)
      expect(list).toBeDefined()
      expect(fill).toBeDefined()
      expect(list!.description).toContain('never exposed')
      expect(fill!.description).toContain('approve')
      expect(fill!.description).toContain('never submitted automatically')
      const fillProperties = (fill!.parameters as { properties: Record<string, unknown> }).properties
      expect(Object.keys(fillProperties).sort()).toEqual(['credentialId', 'fields'])
      const listProperties = (list!.parameters as { properties: Record<string, unknown> }).properties
      expect(Object.keys(listProperties)).toEqual([])
      // No parameter or description can carry a value: the model references ids and field names only.
      expect(JSON.stringify(fill!.parameters)).not.toContain(SECRET)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists site-matched metadata without any secret field', async () => {
    const { ctx } = await setup({
      list: {
        ok: true,
        site: 'https://example.com',
        entries: [
          { id: credentialId('00000000-0000-4000-8000-000000000001'), origin: 'https://example.com', label: `Shop ${SECRET}`, username: 'alice', hasTotp: true },
          { id: credentialId('00000000-0000-4000-8000-000000000002'), origin: 'https://example.com', label: 'Bank', username: 'bob', hasTotp: false },
        ],
      },
    })
    try {
      const result = await callTool(ctx, CREDENTIALS_LIST_TOOL, {})
      expect(result.isError).toBe(false)
      // The model-visible result text is pinned verbatim; metadata labels pass through unescaped.
      expect(text(result)).toBe('Credentials for https://example.com:\n'
        + `- Shop ${SECRET} (id: 00000000-0000-4000-8000-000000000001, username: alice, one-time code available)\n`
        + '- Bank (id: 00000000-0000-4000-8000-000000000002, username: bob)')
      // The wire vocabulary has no password field at all.
      expect(JSON.stringify(result.content)).not.toContain('"password"')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an empty match', async () => {
    const { ctx } = await setup({ list: { ok: true, site: 'https://empty.example', entries: [] } })
    try {
      const result = await callTool(ctx, CREDENTIALS_LIST_TOOL, {})
      expect(text(result)).toContain('No saved credentials')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['no-active-page', 'no-window', 'unavailable', 'error'] as const)
  ('surfaces the list failure category %s without internals', async (error) => {
    const { ctx } = await setup({ list: { ok: false, error } })
    try {
      const result = await callTool(ctx, CREDENTIALS_LIST_TOOL, {})
      expect(result.isError).toBe(false)
      const rendered = text(result)
      expect(rendered.length).toBeGreaterThan(0)
      expect(JSON.stringify(result)).not.toContain('secret')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fills the requested fields and reports per-field outcomes', async () => {
    const { ctx, bridge } = await setup({ fill: { ok: true, filled: ['username', 'password'], notFound: ['totp'] } })
    try {
      const result = await callTool(ctx, CREDENTIALS_FILL_TOOL, {
        credentialId: '00000000-0000-4000-8000-000000000001',
        fields: ['username', 'password', 'totp'],
      })
      expect(result.isError).toBe(false)
      expect(bridge.calls.fill).toEqual([
        { credentialId: '00000000-0000-4000-8000-000000000001', fields: ['username', 'password', 'totp'] },
      ])
      // The model-visible result text is pinned verbatim; a leak of any secret
      // value into it changes this exact string and fails here.
      expect(text(result)).toBe('Filled: username, password. No matching input found on the page for: totp.')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('tells the model up front that an interrupted fill has an unknown outcome', async () => {
    const { ctx } = await setup({ fill: { ok: false, error: 'unavailable' } })
    try {
      const schemas = ctx.tools.schemas()
      const fill = schemas.find(schema => schema.name === CREDENTIALS_FILL_TOOL)
      expect(fill!.description).toContain('the outcome is unknown')
      expect(fill!.description).toContain('Confirm with the user')

      // The registry's cancellation contract supersedes the tool's own answer
      // once the caller signal is aborted, so the model never reads a settled
      // `unavailable` as "nothing was filled" for an aborted call.
      const controller = new AbortController()
      controller.abort()
      const result = await ctx.tools.execute({
        signal: controller.signal,
        callId: ToolCallId('call-aborted'),
        name: CREDENTIALS_FILL_TOOL,
        arguments: { credentialId: '00000000-0000-4000-8000-000000000001', fields: ['password'] },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('aborted')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('turns a refusal into a clean category, not an exception', async () => {
    const { ctx } = await setup({ fill: { ok: false, error: 'denied' } })
    try {
      const result = await callTool(ctx, CREDENTIALS_FILL_TOOL, { credentialId: 'x', fields: ['password'] })
      expect(result.isError).toBe(false)
      expect(text(result)).toContain('not approve')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an empty field selection and unknown fields at the schema boundary', async () => {
    const { ctx, bridge } = await setup({})
    try {
      const empty = await callTool(ctx, CREDENTIALS_FILL_TOOL, { credentialId: 'x', fields: [] })
      expect(empty.isError).toBe(true)
      const bogus = await callTool(ctx, CREDENTIALS_FILL_TOOL, { credentialId: 'x', fields: ['pin'] })
      expect(bogus.isError).toBe(true)
      expect(bridge.calls.fill).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
