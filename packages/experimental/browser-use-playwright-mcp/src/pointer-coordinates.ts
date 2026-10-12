/**
 * Pointer coordinate spaces for the Playwright MCP browser tools.
 *
 * The pinned upstream server declares pointer positions in viewport-relative
 * CSS pixels — the same space as its default `css`-scale screenshots. Vision
 * models instead emit coordinates under per-vendor conventions, so a BYOM
 * deployment declares its model's space through the provider's
 * `pointerCoordinates` config and this module rewrites the model-facing tool
 * definitions and converts arguments before forwarding.
 *
 * @module
 */

import type { McpSiblingCall, McpToolDefinitionOptions } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/**
 * Coordinate space the configured model uses for pointer tools.
 * - `pixel`: upstream convention, viewport-relative CSS pixels; definitions
 *   and arguments pass through verbatim.
 * - `normalized-1000-xy`: values 0-1000 against the current viewport for the
 *   named `x` and `y` arguments (Doubao Seed, Qwen3.x; Gemini not yet measured).
 */
export type PointerCoordinateSpace = 'pixel' | 'normalized-1000-xy'

/** One upstream tool's coordinate argument pairs, always in upstream (x, y) declaration order. */
interface PointerToolShape {
  /** Upstream tool name. */
  readonly tool: string
  /** Coordinate fields; each entry names one (x, y) pair. */
  readonly pairs: readonly { readonly x: string; readonly y: string; readonly prefix: string }[]
}

/** Coordinate-bearing upstream tools and the argument pairs each one carries. */
const POINTER_TOOLS: readonly PointerToolShape[] = [
  { tool: 'browser_mouse_move_xy', pairs: [{ x: 'x', y: 'y', prefix: '' }] },
  { tool: 'browser_mouse_click_xy', pairs: [{ x: 'x', y: 'y', prefix: '' }] },
  {
    tool: 'browser_mouse_drag_xy',
    pairs: [{ x: 'startX', y: 'startY', prefix: 'Start ' }, { x: 'endX', y: 'endY', prefix: 'End ' }],
  },
]

/** Normalized-space paragraph appended to a coordinate tool's description. */
const DESCRIPTION_SUFFIX = 'Coordinates are values from 0 to 1000 against the current viewport (the default viewport screenshot, not a full-page or element screenshot), given in (x, y) order: x runs left to right, y runs top to bottom.'

/** Upstream evaluation used to read the live viewport in CSS pixels. */
const VIEWPORT_EVALUATE_FUNCTION = '() => [window.innerWidth, window.innerHeight]'

/** Live viewport size in CSS pixels, matching the screenshot and pointer space. */
export interface ViewportSize {
  /** Viewport width in CSS pixels. */
  width: number
  /** Viewport height in CSS pixels. */
  height: number
}

/**
 * Convert one normalized 0-1000 value to a pixel index along one viewport axis.
 * The result rounds to the nearest pixel and clamps to `[0, extent - 1]`.
 * @param value - normalized coordinate, already validated within 0-1000.
 * @param extent - viewport size along this axis in CSS pixels.
 * @returns pixel coordinate within the viewport.
 */
export function normalizedToPixel(value: number, extent: number): number {
  return Math.min(Math.max(Math.round(value / 1000 * extent), 0), extent - 1)
}

/** Narrow one JSON value to a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Capitalize one description's first character. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Model-facing description for one coordinate argument field. */
function coordinateFieldDescription(prefix: string, horizontal: boolean): string {
  const base = horizontal
    ? 'horizontal position, normalized to 0-1000 from the left edge of the current viewport (the screenshot)'
    : 'vertical position, normalized to 0-1000 from the top edge of the current viewport (the screenshot)'
  return capitalize(prefix + base)
}

/** Rewrite one coordinate tool's description to declare the normalized space. */
function rewriteToolDescription(description: string): string {
  return description === '' ? DESCRIPTION_SUFFIX : `${description}\n\n${DESCRIPTION_SUFFIX}`
}

/** Rewrite the coordinate argument descriptions of one tool input schema, keeping every other field. */
function rewriteInputSchema(inputSchema: Record<string, unknown>, shape: PointerToolShape): Record<string, unknown> {
  const properties = inputSchema.properties
  if (!isRecord(properties)) return inputSchema
  const nextProperties: Record<string, unknown> = { ...properties }
  for (const pair of shape.pairs) {
    const xProperty = nextProperties[pair.x]
    if (isRecord(xProperty)) nextProperties[pair.x] = { ...xProperty, description: coordinateFieldDescription(pair.prefix, true) }
    const yProperty = nextProperties[pair.y]
    if (isRecord(yProperty)) nextProperties[pair.y] = { ...yProperty, description: coordinateFieldDescription(pair.prefix, false) }
  }
  return { ...inputSchema, properties: nextProperties }
}

/**
 * Reject one model-supplied coordinate that is not a finite number in 0-1000.
 * @param value - the model-facing argument value.
 * @param field - upstream argument name, for the diagnostic.
 */
function assertNormalizedCoordinate(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) {
    throw new Error(`pointer argument "${field}" must be a finite number between 0 and 1000, got ${String(value)}`)
  }
}

/** Extract the joined text of an MCP result's text content blocks. */
function resultText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const text: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') text.push(block.text)
  }
  return text.join('\n')
}

/** Parse the `### Result` section of an upstream evaluate response. */
function parseEvaluateResult(text: string): unknown {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.startsWith('### Result'))
  if (start === -1) throw new Error('reading the browser viewport failed: browser_evaluate returned no Result section')
  const body: string[] = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined || line.startsWith('### ')) break
    body.push(line)
  }
  try {
    return JSON.parse(body.join('\n'))
  } catch (error) {
    throw new Error(`reading the browser viewport failed: browser_evaluate returned invalid JSON: ${String(error)}`, { cause: error })
  }
}

/**
 * Read the live viewport size in CSS pixels through the upstream evaluate
 * tool, so converted coordinates match the screenshot the model saw. Costs one
 * extra MCP round trip per coordinate call.
 * @param callSibling - invoker for another tool on the same MCP connection.
 * @param execution - the exact coordinate invocation requesting the viewport.
 * @returns the viewport size in CSS pixels.
 */
async function readViewportSize(callSibling: McpSiblingCall, execution: ToolExecution): Promise<ViewportSize> {
  const raw: unknown = await callSibling('browser_evaluate', { function: VIEWPORT_EVALUATE_FUNCTION }, execution)
  const result = isRecord(raw) ? raw : {}
  const text = resultText(result.content)
  if (result.isError === true) {
    throw new Error(`reading the browser viewport failed: ${text}`)
  }
  const parsed: unknown = parseEvaluateResult(text)
  if (!Array.isArray(parsed) || parsed.length !== 2
    || typeof parsed[0] !== 'number' || !Number.isFinite(parsed[0]) || parsed[0] <= 0
    || typeof parsed[1] !== 'number' || !Number.isFinite(parsed[1]) || parsed[1] <= 0) {
    throw new Error('reading the browser viewport failed: browser_evaluate did not return a positive [width, height] pair')
  }
  return { width: parsed[0], height: parsed[1] }
}

/**
 * Build the tool decorator for one configured pointer coordinate space.
 * Non-pixel spaces rewrite the three upstream pointer tools so the model sees
 * normalized 0-1000 viewport coordinates, validate the model's arguments, read
 * the live viewport through the upstream evaluate tool, and forward CSS pixel
 * coordinates. The upstream result echoes the pixel values, so a text block
 * restating the normalized space is appended to it. `pixel` and non-pointer
 * tools pass through unchanged.
 * @param space - the coordinate space the configured model emits.
 * @returns the decorator for the shared runtime's per-tool adaptation seam.
 */
export function createPointerCoordinatesDecorator(
  space: PointerCoordinateSpace,
): (tool: McpToolDefinitionOptions, callSibling: McpSiblingCall) => McpToolDefinitionOptions {
  if (space === 'pixel') return tool => tool
  return (tool, callSibling) => {
    const shape = POINTER_TOOLS.find(entry => entry.tool === tool.rawName)
    if (shape === undefined) return tool
    const forward = (args: Record<string, unknown>, execution: ToolExecution) => tool.call(args, execution)
    return {
      ...tool,
      description: rewriteToolDescription(tool.description),
      inputSchema: rewriteInputSchema(tool.inputSchema, shape),
      call: async (args, execution) => {
        const coordinates = shape.pairs.map((pair) => {
          const x = args[pair.x]
          const y = args[pair.y]
          assertNormalizedCoordinate(x, pair.x)
          assertNormalizedCoordinate(y, pair.y)
          return { pair, horizontal: x, vertical: y }
        })
        const viewport = await readViewportSize(callSibling, execution)
        const converted: Record<string, unknown> = { ...args }
        for (const { pair, horizontal, vertical } of coordinates) {
          converted[pair.x] = normalizedToPixel(horizontal, viewport.width)
          converted[pair.y] = normalizedToPixel(vertical, viewport.height)
        }
        const result = await forward(converted, execution)
        if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) return result
        const content: unknown[] = result.content
        const note = `Pointer arguments were converted from 0-1000 values to CSS pixels on a ${viewport.width}x${viewport.height} viewport; keep sending 0-1000 values.`
        return { ...result, content: [...content, { type: 'text', text: note }] }
      },
    }
  }
}
