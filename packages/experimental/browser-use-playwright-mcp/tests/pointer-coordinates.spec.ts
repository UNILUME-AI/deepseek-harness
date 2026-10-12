import { describe, expect, it, vi } from 'vitest'
import type { McpToolDefinitionOptions } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { createPointerCoordinatesDecorator, normalizedToPixel } from '../src/pointer-coordinates.ts'

const execution = {} as ToolExecution

const VIEWPORT_RESULT = {
  content: [{
    type: 'text',
    text: '### Result\n[\n  1280,\n  720\n]\n### Ran Playwright code\n```typescript\nawait page.evaluate(() => [window.innerWidth, window.innerHeight]);\n```',
  }],
}

/** Build one upstream-looking tool definition whose call echoes its arguments. */
function clickTool(): McpToolDefinitionOptions {
  return {
    name: 'mcp__playwright-mcp__browser_mouse_click_xy',
    rawName: 'browser_mouse_click_xy',
    description: 'Click mouse button at a given position',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        button: { type: 'string', description: 'Button to click, defaults to left' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    },
    call: async (args: Record<string, unknown>) => ({ forwarded: args }),
  }
}

/** One fake sibling invoker returning the canned viewport result and recording its calls. */
function sibling(result: unknown = VIEWPORT_RESULT) {
  const calls: { rawName: string; args: Record<string, unknown> }[] = []
  const callSibling = (rawName: string, args: Record<string, unknown>, exec: ToolExecution) => {
    calls.push({ rawName, args })
    expect(exec).toBe(execution)
    return Promise.resolve(result)
  }
  return { calls, callSibling }
}

describe('normalizedToPixel', () => {
  it('scales, rounds, and clamps along one axis', () => {
    expect(normalizedToPixel(0, 1280)).toBe(0)
    expect(normalizedToPixel(500, 1280)).toBe(640)
    expect(normalizedToPixel(499, 1280)).toBe(639)
    expect(normalizedToPixel(501, 1280)).toBe(641)
    expect(normalizedToPixel(250, 720)).toBe(180)
    expect(normalizedToPixel(1000, 1280)).toBe(1279)
    expect(normalizedToPixel(1000, 720)).toBe(719)
    expect(normalizedToPixel(1000, 1)).toBe(0)
    expect(normalizedToPixel(500, 2)).toBe(1)
  })
})

describe('createPointerCoordinatesDecorator', () => {
  it('passes every tool through unchanged in pixel space', () => {
    const decorator = createPointerCoordinatesDecorator('pixel')
    const tool = clickTool()
    expect(decorator(tool, sibling().callSibling)).toBe(tool)
  })

  it('passes non-pointer tools through unchanged in normalized spaces', () => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const tool: McpToolDefinitionOptions = {
      ...clickTool(),
      name: 'mcp__playwright-mcp__browser_navigate',
      rawName: 'browser_navigate',
      description: 'Navigate to a URL',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
    }
    expect(decorator(tool, sibling().callSibling)).toBe(tool)
  })

  it('rewrites the click definition and converts (x, y) arguments against the live viewport', async () => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const tool = clickTool()
    const { calls, callSibling } = sibling()
    const decorated = decorator(tool, callSibling)
    expect(decorated).not.toBe(tool)
    expect(decorated.name).toBe(tool.name)
    expect(decorated.rawName).toBe(tool.rawName)
    expect(decorated.description).toBe('Click mouse button at a given position\n\nCoordinates are values from 0 to 1000 against the current viewport (the default viewport screenshot, not a full-page or element screenshot), given in (x, y) order: x runs left to right, y runs top to bottom.')
    expect(decorated.inputSchema).toEqual({
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Horizontal position, normalized to 0-1000 from the left edge of the current viewport (the screenshot)' },
        y: { type: 'number', description: 'Vertical position, normalized to 0-1000 from the top edge of the current viewport (the screenshot)' },
        button: { type: 'string', description: 'Button to click, defaults to left' },
      },
      required: ['x', 'y'],
      additionalProperties: false,
    })
    expect(tool.inputSchema.properties).toMatchObject({ x: { description: 'X coordinate' } })

    const args = { x: 500, y: 250, button: 'right' }
    const result = await decorated.call(args, execution) as { forwarded: Record<string, unknown> }
    expect(result.forwarded).toEqual({ x: 640, y: 180, button: 'right' })
    expect(args).toEqual({ x: 500, y: 250, button: 'right' })
    expect(calls).toEqual([{ rawName: 'browser_evaluate', args: { function: '() => [window.innerWidth, window.innerHeight]' } }])
  })

  it('converts drag coordinates for all four fields', async () => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const tool: McpToolDefinitionOptions = {
      name: 'mcp__playwright-mcp__browser_mouse_drag_xy',
      rawName: 'browser_mouse_drag_xy',
      description: 'Drag left mouse button to a given position',
      inputSchema: {
        type: 'object',
        properties: {
          startX: { type: 'number', description: 'Start X coordinate' },
          startY: { type: 'number', description: 'Start Y coordinate' },
          endX: { type: 'number', description: 'End X coordinate' },
          endY: { type: 'number', description: 'End Y coordinate' },
        },
        required: ['startX', 'startY', 'endX', 'endY'],
        additionalProperties: false,
      },
      call: async (args: Record<string, unknown>) => ({ forwarded: args }),
    }
    const decorated = decorator(tool, sibling().callSibling)
    expect(decorated.description).toBe('Drag left mouse button to a given position\n\nCoordinates are values from 0 to 1000 against the current viewport (the default viewport screenshot, not a full-page or element screenshot), given in (x, y) order: x runs left to right, y runs top to bottom.')
    expect(decorated.inputSchema).toMatchObject({
      properties: {
        startX: { description: 'Start horizontal position, normalized to 0-1000 from the left edge of the current viewport (the screenshot)' },
        startY: { description: 'Start vertical position, normalized to 0-1000 from the top edge of the current viewport (the screenshot)' },
        endX: { description: 'End horizontal position, normalized to 0-1000 from the left edge of the current viewport (the screenshot)' },
        endY: { description: 'End vertical position, normalized to 0-1000 from the top edge of the current viewport (the screenshot)' },
      },
    })
    const dragArgs = { startX: 0, startY: 0, endX: 1000, endY: 1000 }
    const result = await decorated.call(dragArgs, execution) as { forwarded: Record<string, unknown> }
    expect(result.forwarded).toEqual({
      startX: 0,
      startY: 0,
      endX: 1279,
      endY: 719,
    })
  })

  it('returns an upstream error result without the conversion note', async () => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const failure = { isError: true, content: [{ type: 'text', text: '### Error\nclick failed' }] }
    const decorated = decorator({ ...clickTool(), call: async () => failure }, sibling().callSibling)
    expect(await decorated.call({ x: 500, y: 250 }, execution)).toBe(failure)
  })

  it('rewrites a missing upstream description to the space paragraph alone', () => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const tool = { ...clickTool(), description: '' }
    expect(decorator(tool, sibling().callSibling).description)
      .toBe('Coordinates are values from 0 to 1000 against the current viewport (the default viewport screenshot, not a full-page or element screenshot), given in (x, y) order: x runs left to right, y runs top to bottom.')
  })

  it('keeps an input schema without object properties as-is', () => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const inputSchema = { type: 'object' }
    const tool = { ...clickTool(), inputSchema }
    expect(decorator(tool, sibling().callSibling).inputSchema).toBe(inputSchema)
  })

  it.each([
    ['above range', 1000.1],
    ['below range', -0.1],
    ['not finite', Number.POSITIVE_INFINITY],
    ['not a number', '500'],
    ['boolean', true],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s coordinates before reading the viewport', async (_label, bad) => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const { calls, callSibling } = sibling()
    const forward = vi.fn(async (args: Record<string, unknown>) => ({ forwarded: args }))
    const decorated = decorator({ ...clickTool(), call: forward }, callSibling)
    await expect(decorated.call({ x: bad, y: 0 }, execution)).rejects.toThrow('pointer argument "x" must be a finite number between 0 and 1000')
    await expect(decorated.call({ x: 0, y: bad }, execution)).rejects.toThrow('pointer argument "y" must be a finite number between 0 and 1000')
    expect(calls).toEqual([])
    expect(forward).not.toHaveBeenCalled()
  })

  it('rejects NaN coordinates', async () => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const decorated = decorator(clickTool(), sibling().callSibling)
    await expect(decorated.call({ x: Number.NaN, y: 0 }, execution)).rejects.toThrow('pointer argument "x" must be a finite number between 0 and 1000')
  })

  it.each([
    ['an error result', { isError: true, content: [{ type: 'text', text: '### Error\nboom' }] }, 'reading the browser viewport failed'],
    ['no Result section', { content: [{ type: 'text', text: 'nothing here' }] }, 'no Result section'],
    ['malformed JSON', { content: [{ type: 'text', text: '### Result\n[not-json' }] }, 'invalid JSON'],
    ['a short pair', { content: [{ type: 'text', text: '### Result\n[1280]' }] }, 'did not return a positive [width, height] pair'],
    ['a non-numeric pair', { content: [{ type: 'text', text: '### Result\n[1280, "720"]' }] }, 'did not return a positive [width, height] pair'],
    ['a zero extent', { content: [{ type: 'text', text: '### Result\n[0, 720]' }] }, 'did not return a positive [width, height] pair'],
    ['no content blocks', {}, 'no Result section'],
    ['non-text content', { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }, 'no Result section'],
    ['a non-object result', null, 'no Result section'],
  ])('fails the call when the viewport read returns %s', async (_label, siblingResult, diagnostic) => {
    const decorator = createPointerCoordinatesDecorator('normalized-1000-xy')
    const { calls, callSibling } = sibling(siblingResult)
    const forward = vi.fn(async (args: Record<string, unknown>) => ({ forwarded: args }))
    const decorated = decorator({ ...clickTool(), call: forward }, callSibling)
    await expect(decorated.call({ x: 500, y: 250 }, execution)).rejects.toThrow(diagnostic)
    expect(calls).toEqual([{ rawName: 'browser_evaluate', args: { function: '() => [window.innerWidth, window.innerHeight]' } }])
    expect(forward).not.toHaveBeenCalled()
  })
})
