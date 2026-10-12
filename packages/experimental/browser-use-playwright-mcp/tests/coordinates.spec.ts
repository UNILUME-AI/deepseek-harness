import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Llm from '@deepseek-ai/dsh-llm'
import Projections from '@deepseek-ai/dsh-session-projection'
import type { McpToolDecorator } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { createPointerCoordinatesDecorator } from '../src/pointer-coordinates.ts'

const fixture = fileURLToPath(new URL('./coordinates-fixture.mjs', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function load(decorateTool: McpToolDecorator | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pointer-coords-'))
  roots.push(root)
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    ['browser', {
      inject: ['browserUse', 'agents', 'tools', 'systemPrompt'],
      apply(ctx: Context) {
        mountSessionMcp(ctx, {
          name: 'pointer-fixture',
          exclusive: false,
          command: process.execPath,
          args: [fixture, root],
          ...decorateTool === undefined ? {} : { decorateTool },
        })
      },
    }],
  ])
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ id: name, name, config: name === 'loop' ? { agents: [] } : {} }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const owner = await ctx.agents.create({ sessionId: SessionId('pointer-owner') })
  return { ctx, root, agent: owner.agent }
}

function execute(ctx: Context, agent: Agent, name: string, args: Record<string, unknown>) {
  return ctx.tools.execute({ agent, name, arguments: args, callId: ToolCallId(name), signal: new AbortController().signal })
}

async function calls(root: string): Promise<{ name: string; arguments: Record<string, unknown> }[]> {
  const content = await readFile(join(root, 'events.ndjson'), 'utf8')
  return content.trim().split('\n')
    .map(line => JSON.parse(line) as { event: string; name?: string; arguments?: Record<string, unknown> })
    .filter(event => event.event === 'call')
    .map(event => ({ name: event.name!, arguments: event.arguments! }))
}

const CLICK = 'mcp__pointer-fixture__browser_mouse_click_xy'
const DRAG = 'mcp__pointer-fixture__browser_mouse_drag_xy'
const EVALUATE = 'mcp__pointer-fixture__browser_evaluate'

it('converts normalized 0-1000 (x, y) coordinates to viewport pixels before forwarding', async () => {
  const { ctx, root, agent } = await load(createPointerCoordinatesDecorator('normalized-1000-xy'))
  const schemas = ctx.tools.schemas(agent)
  const click = schemas.find(tool => tool.name === CLICK)!
  expect(click.description).toBe('Click mouse button at a given position\n\nCoordinates are values from 0 to 1000 against the current viewport (the default viewport screenshot, not a full-page or element screenshot), given in (x, y) order: x runs left to right, y runs top to bottom.')
  expect(click.parameters).toMatchObject({
    properties: {
      x: { type: 'number', description: 'Horizontal position, normalized to 0-1000 from the left edge of the current viewport (the screenshot)' },
      y: { type: 'number', description: 'Vertical position, normalized to 0-1000 from the top edge of the current viewport (the screenshot)' },
      button: { type: 'string', description: 'Button to click, defaults to left' },
    },
  })
  const drag = schemas.find(tool => tool.name === DRAG)!
  expect(drag.description).toContain('given in (x, y) order')
  expect(drag.parameters).toMatchObject({
    properties: {
      startX: { description: 'Start horizontal position, normalized to 0-1000 from the left edge of the current viewport (the screenshot)' },
      startY: { description: 'Start vertical position, normalized to 0-1000 from the top edge of the current viewport (the screenshot)' },
      endX: { description: 'End horizontal position, normalized to 0-1000 from the left edge of the current viewport (the screenshot)' },
      endY: { description: 'End vertical position, normalized to 0-1000 from the top edge of the current viewport (the screenshot)' },
    },
  })
  const evaluate = schemas.find(tool => tool.name === EVALUATE)!
  expect(evaluate.description).toBe('Evaluate JavaScript expression on page or element')
  const visit = schemas.find(tool => tool.name === 'mcp__pointer-fixture__visit')!
  expect(visit.description).toBe('Visit the fixture page.')

  const clickResult = await execute(ctx, agent, CLICK, { x: 500, y: 250, button: 'left' })
  expect(clickResult.isError).toBe(false)
  expect(clickResult.content).toEqual([
    { type: 'text', text: 'Pointer {"x":640,"y":180,"button":"left"}\nPointer arguments were converted from 0-1000 values to CSS pixels on a 1280x720 viewport; keep sending 0-1000 values.' },
  ])
  const dragResult = await execute(ctx, agent, DRAG, { startX: 0, startY: 0, endX: 1000, endY: 1000 })
  expect(dragResult.isError).toBe(false)
  expect(dragResult.content).toEqual([
    { type: 'text', text: 'Pointer {"startX":0,"startY":0,"endX":1279,"endY":719}\nPointer arguments were converted from 0-1000 values to CSS pixels on a 1280x720 viewport; keep sending 0-1000 values.' },
  ])
  const upstream = await calls(root)
  expect(upstream.filter(call => call.name === 'browser_evaluate')).toEqual([
    { name: 'browser_evaluate', arguments: { function: '() => [window.innerWidth, window.innerHeight]' } },
    { name: 'browser_evaluate', arguments: { function: '() => [window.innerWidth, window.innerHeight]' } },
  ])
  expect(upstream.filter(call => call.name === 'browser_mouse_click_xy')).toEqual([
    { name: 'browser_mouse_click_xy', arguments: { x: 640, y: 180, button: 'left' } },
  ])
  expect(upstream.filter(call => call.name === 'browser_mouse_drag_xy')).toEqual([
    { name: 'browser_mouse_drag_xy', arguments: { startX: 0, startY: 0, endX: 1279, endY: 719 } },
  ])
})

it('keeps tool definitions and arguments verbatim in pixel space', async () => {
  const { ctx, root, agent } = await load(createPointerCoordinatesDecorator('pixel'))
  const click = ctx.tools.schemas(agent).find(tool => tool.name === CLICK)!
  expect(click.description).toBe('Click mouse button at a given position')
  expect(click.parameters).toEqual({
    type: 'object',
    properties: {
      x: { type: 'number', description: 'X coordinate' },
      y: { type: 'number', description: 'Y coordinate' },
      button: { type: 'string', description: 'Button to click, defaults to left' },
      clickCount: { type: 'number', description: 'Number of clicks, defaults to 1' },
      delay: { type: 'number', description: 'Time to wait between mouse down and mouse up in milliseconds, defaults to 0' },
    },
    required: ['x', 'y'],
    additionalProperties: false,
  })
  const result = await execute(ctx, agent, CLICK, { x: 100, y: 50 })
  expect(result.isError).toBe(false)
  const upstream = await calls(root)
  expect(upstream.filter(call => call.name === 'browser_mouse_click_xy')).toEqual([
    { name: 'browser_mouse_click_xy', arguments: { x: 100, y: 50 } },
  ])
  expect(upstream.some(call => call.name === 'browser_evaluate')).toBe(false)
})

it.each([
  ['out of range above', { x: 1001, y: 0 }],
  ['out of range below', { x: -1, y: 0 }],
  ['not a number', { x: '500', y: 0 }],
  ['missing', { y: 0 }],
])('rejects %s coordinates without forwarding', async (_label, args) => {
  const { ctx, root, agent } = await load(createPointerCoordinatesDecorator('normalized-1000-xy'))
  const before = (await calls(root)).length
  const result = await execute(ctx, agent, CLICK, args)
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain('between 0 and 1000')
  const upstream = await calls(root)
  expect(upstream.length).toBe(before)
  expect(upstream.some(call => call.name === 'browser_mouse_click_xy')).toBe(false)
  expect(upstream.some(call => call.name === 'browser_evaluate')).toBe(false)
})
