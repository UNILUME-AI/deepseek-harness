import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Provider from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
import { loadSidebarProvider } from './sidebar-browser-provider.ts'

it('registers only read and navigation tools and rejects guessed script tool names at execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidebar-provider-'))
  let dispose: (() => Promise<void>) | undefined
  try {
    const { ctx, agent } = await loadSidebarProvider(directory, Provider.Config({
      name: 'sidebar-browser', mode: 'sidebar', socketPath: 'unused.sock', socketToken: '0'.repeat(64),
      executablePath: fileURLToPath(new URL('../resources/sidebar-browser-connect', import.meta.url)),
    }))
    dispose = () => ctx.fiber.dispose()
    expect(agent.session.header.cwd).toBe(resolve(directory))
    for (const rawName of ['browser_snapshot', 'browser_take_screenshot']) {
      const schema = ctx.tools.schemas(agent).find(tool => tool.name === `mcp__sidebar-browser__${rawName}`)!
      expect(schema.parameters.properties).not.toHaveProperty('filename')
      expect(schema.parameters.required ?? []).not.toContain('filename')
      expect(schema.parameters.additionalProperties).toBe(false)
    }
    const names = ctx.tools.schemas(agent).map(tool => tool.name).filter(name => name.startsWith('mcp__sidebar-browser__'))
    expect(names).toContain('mcp__sidebar-browser__browser_snapshot')
    expect(names).toContain('mcp__sidebar-browser__browser_take_screenshot')
    expect(names).toContain('mcp__sidebar-browser__browser_navigate')
    expect(names).toContain('mcp__sidebar-browser__browser_navigate_back')
    expect(names).toContain('mcp__sidebar-browser__browser_tabs')
    const allowed = ['browser_snapshot', 'browser_take_screenshot', 'browser_navigate', 'browser_navigate_back',
      'browser_navigate_forward', 'browser_tabs']
    for (const name of names) expect(allowed).toContain(name.slice('mcp__sidebar-browser__'.length))
    expect(names).not.toContain('mcp__sidebar-browser__browser_evaluate')
    let page = 'idle'
    const unregister = ctx.tools.register({
      name: 'mcp__sidebar-browser__browser_evaluate', description: 'Fixture script tool',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: value => [{ type: 'text', text: String(value) }] },
      execute: async () => { page = 'changed'; return 'changed' },
    })
    try {
      const result = await ctx.tools.execute({
        agent, name: 'mcp__sidebar-browser__browser_evaluate', arguments: {}, callId: ToolCallId('script'), signal: new AbortController().signal,
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('only reading and navigation are allowed')
      expect(page).toBe('idle')
    } finally { unregister() }
  } finally {
    await dispose?.()
    await rm(directory, { recursive: true, force: true })
  }
})

it('refuses direct filenames without creating or truncating files and refuses non-HTTP navigation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidebar-provider-'))
  let dispose: (() => Promise<void>) | undefined
  try {
    const { ctx, agent } = await loadSidebarProvider(directory, Provider.Config({
      name: 'sidebar-browser', mode: 'sidebar', socketPath: 'unused.sock', socketToken: '0'.repeat(64),
      executablePath: fileURLToPath(new URL('../resources/sidebar-browser-connect', import.meta.url)),
    }))
    dispose = () => ctx.fiber.dispose()
    const existing = join(directory, 'package.json')
    const original = '{"name":"sidebar-file-fixture"}\n'
    await writeFile(existing, original)
    for (const rawName of ['browser_snapshot', 'browser_take_screenshot']) {
      const name = `mcp__sidebar-browser__${rawName}`
      const definition = ctx.tools.get(name, agent)!
      // A writable executor bypasses schema/decorator checks to exercise the execution listener itself.
      const writer = vi.spyOn(definition, 'execute').mockImplementation(async (args) => {
        await writeFile(resolve(directory, (args as { filename: string }).filename), 'truncated')
        return 'written'
      })
      const missing = `${rawName}.new`
      try {
        for (const filename of ['package.json', missing]) {
          const result = await ctx.tools.execute({
            agent, name, arguments: { filename }, callId: ToolCallId(`${rawName}-${filename}`), signal: new AbortController().signal,
          })
          expect(await readFile(existing, 'utf8')).toBe(original)
          expect(existsSync(join(directory, missing))).toBe(false)
          expect(result.isError).toBe(true)
          expect(JSON.stringify(result.content)).toContain('filename is refused')
        }
        expect(writer).not.toHaveBeenCalled()
      } finally { writer.mockRestore() }
    }
    for (const url of ['about:blank', 'about:blank#page', 'javascript:document.body.remove()', 'file:///page.html']) {
      const result = await ctx.tools.execute({
        agent, name: 'mcp__sidebar-browser__browser_navigate', arguments: { url }, callId: ToolCallId('navigation'), signal: new AbortController().signal,
      })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('navigation requires an HTTP(S) URL')
    }
  } finally {
    await dispose?.()
    await rm(directory, { recursive: true, force: true })
  }
})
