/** Private stdio fixture imitating the pinned Playwright MCP pointer tools. */
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const [root] = process.argv.slice(2)
const record = (event, values = {}) => appendFileSync(join(root, 'events.ndjson'), JSON.stringify({ event, pid: process.pid, ...values }) + '\n')
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')

record('start')
process.once('exit', () => record('exit'))
const lines = createInterface({ input: process.stdin })
lines.once('close', () => process.exit(0))
lines.on('line', line => {
  const request = JSON.parse(line)
  if (request.id === undefined) return
  switch (request.method) {
    case 'server/discover':
      record('probe')
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Legacy browser fixture' } }) + '\n')
      break
    case 'initialize':
      record('initialize')
      reply(request.id, {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'pointer-fixture', version: '1' },
      })
      break
    case 'tools/list':
      reply(request.id, { tools: [
        {
          name: 'visit', description: 'Visit the fixture page.', inputSchema: { type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false },
        },
        {
          name: 'browser_evaluate',
          description: 'Evaluate JavaScript expression on page or element',
          inputSchema: {
            type: 'object',
            properties: { function: { type: 'string', description: '() => { /* code */ }' } },
            required: ['function'],
            additionalProperties: false,
          },
        },
        {
          name: 'browser_mouse_move_xy',
          description: 'Move mouse to a given position',
          inputSchema: {
            type: 'object',
            properties: { x: { type: 'number', description: 'X coordinate' }, y: { type: 'number', description: 'Y coordinate' } },
            required: ['x', 'y'],
            additionalProperties: false,
          },
        },
        {
          name: 'browser_mouse_click_xy',
          description: 'Click mouse button at a given position',
          inputSchema: {
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
          },
        },
        {
          name: 'browser_mouse_drag_xy',
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
        },
      ] })
      break
    case 'tools/call': {
      record('call', { name: request.params.name, arguments: request.params.arguments })
      const args = request.params.arguments
      if (request.params.name === 'browser_evaluate') {
        reply(request.id, { content: [{ type: 'text', text: '### Result\n[\n  1280,\n  720\n]\n### Ran Playwright code\n```typescript\nawait page.evaluate(() => [window.innerWidth, window.innerHeight]);\n```' }] })
      } else if (request.params.name.startsWith('browser_mouse_')) {
        reply(request.id, { content: [{ type: 'text', text: `Pointer ${JSON.stringify(args)}` }] })
      } else {
        reply(request.id, { content: [{ type: 'text', text: `Visit: ${args.label}` }] })
      }
      break
    }
    default:
      throw new Error(`Unexpected method ${request.method}`)
  }
})
