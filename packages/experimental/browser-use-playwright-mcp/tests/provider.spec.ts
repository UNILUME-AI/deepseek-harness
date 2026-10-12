import { existsSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { mountSessionMcp } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import * as Provider from '../src/index.ts'

vi.mock('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp', async importOriginal => ({
  ...await importOriginal<typeof import('@deepseek-ai/dsh-experimental-browser-use-runtime/mcp')>(),
  mountSessionMcp: vi.fn(),
}))
afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

it('uses the pinned Playwright executable with isolated Chromium launch settings', () => {
  vi.stubEnv('PLAYWRIGHT_MCP_CDP_ENDPOINT', 'http://invalid.example:1')
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', executablePath: '/custom/chromium', toolCallTimeoutMs: 123 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(existsSync(options.args[0]!)).toBe(true)
  expect(options).toMatchObject({ name: 'playwright-mcp', exclusive: false, command: process.execPath, toolCallTimeoutMs: 123 })
  expect(options.env).toMatchObject({ PLAYWRIGHT_MCP_CDP_ENDPOINT: '' })
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/custom/chromium'])
  expect('default' in Provider).toBe(false)
})

it('accepts a shared browser configuration that omits capabilities', () => {
  Provider.apply(new Context(), { mode: 'launch', headless: true })
  expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated', '--headless'])
})

it('supports headed launch and attaches without launching a browser or creating a profile', () => {
  Provider.apply(new Context(), Provider.Config({ mode: 'launch', headless: false }))
  expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(1)).toEqual(['--browser', 'chromium', '--isolated'])
  Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://127.0.0.1:9222' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[1]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--browser', 'chromium', '--cdp-endpoint', 'http://127.0.0.1:9222'])
})

it('rejects malformed endpoints before mounting any browser resources', () => {
  expect(() => { Provider.apply(new Context(), Provider.Config({ mode: 'attach', endpoint: 'http://localhost:bad/path' })) }).toThrow('browser endpoint')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

const inheritedToken = 'fixture-inherited-token'
const resolvedToken = 'fixture-resolved-token'

it.each(['chrome', 'msedge'] as const)('connects through the %s extension and clears inherited options without a reference', (browser) => {
  vi.stubEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', inheritedToken)
  vi.stubEnv('playwright_mcp_headless', 'true')
  Provider.apply(new Context(), Provider.Config({ mode: 'extension', browser }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options.exclusive).toBe(true)
  expect(options.args.slice(1)).toEqual(['--browser', browser, '--extension'])
  expect(options.env).toMatchObject({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: '', playwright_mcp_headless: '' })
})

it.each([
  { mode: 'launch' as const },
  { mode: 'attach' as const, endpoint: 'http://localhost:9222' },
  { mode: 'extension' as const },
])('exposes vision only when configured in $mode mode', (config) => {
  Provider.apply(new Context(), Provider.Config({ ...config, capabilities: ['vision'] }))
  expect(vi.mocked(mountSessionMcp).mock.calls[0]![1].args.slice(-2)).toEqual(['--caps', 'vision'])
})

it('resolves the extension credential per startup and never puts it in arguments', async () => {
  const ctx = new Context()
  const resolve = vi.fn().mockResolvedValue({ value: resolvedToken, source: 'fixture' })
  vi.spyOn(ctx, 'get').mockImplementation(name => name === 'credentials' ? { resolve } : undefined)
  vi.stubEnv('PLAYWRIGHT_MCP_EXTENSION_TOKEN', inheritedToken)
  Provider.apply(ctx, Provider.Config({ mode: 'extension', extensionTokenEnv: 'BROWSER_TOKEN', toolCallTimeoutMs: 345 }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  expect(options.toolCallTimeoutMs).toBe(345)
  expect(options.args.slice(1)).toEqual(['--browser', 'chrome', '--extension'])
  expect(options.args.join(' ')).not.toContain(resolvedToken)
  expect(resolve).not.toHaveBeenCalled()
  if (typeof options.env !== 'function') throw new Error('Expected startup resolver')
  expect(await options.env()).toMatchObject({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: resolvedToken })
  resolve.mockResolvedValue({ value: 'fixture-rotated-token' })
  expect(await options.env()).toMatchObject({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'fixture-rotated-token' })
  expect(resolve).toHaveBeenCalledTimes(2)
  expect(resolve).toHaveBeenCalledWith('BROWSER_TOKEN')
  resolve.mockResolvedValue(undefined)
  await expect(options.env()).rejects.toThrow('extension credential BROWSER_TOKEN is not configured')
  resolve.mockResolvedValue({ value: '' })
  await expect(options.env()).rejects.toThrow('extension credential BROWSER_TOKEN is not configured')
  resolve.mockRejectedValue(new Error(resolvedToken))
  await expect(options.env()).rejects.toThrow('extension credential resolution failed')
})

it('uses the launch environment only when the credential service is absent', async () => {
  const ctx = new Context()
  const get = vi.fn().mockReturnValue({ value: resolvedToken })
  vi.spyOn(ctx, 'get').mockImplementation(name => name === 'launchEnvironment' ? { get } : undefined)
  Provider.apply(ctx, Provider.Config({ mode: 'extension', extensionTokenEnv: 'BROWSER_TOKEN' }))
  const options = vi.mocked(mountSessionMcp).mock.calls[0]![1]
  if (typeof options.env !== 'function') throw new Error('Expected startup resolver')
  expect(await options.env()).toMatchObject({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: resolvedToken })
  get.mockReturnValue(undefined)
  await expect(options.env()).rejects.toThrow('extension credential BROWSER_TOKEN is not configured')
})

it.each([
  { mode: 'extension', endpoint: 'http://localhost:9222' },
  { mode: 'extension', headless: true },
  { mode: 'extension', executablePath: '/chrome' },
  { mode: 'extension', browser: 'chromium' },
  { mode: 'extension', extensionTokenEnv: 'invalid-ref' },
  { mode: 'extension', toolCallTimeoutMs: 0 },
  ...['launch', 'attach'].map(mode => ({ mode, endpoint: 'http://localhost:9222', capabilities: ['unknown'] })),
  { mode: 'extension', capabilities: ['unknown'] },
  { mode: 'launch', browser: 'msedge' },
  { mode: 'attach', endpoint: 'http://localhost:9222', extensionTokenEnv: 'BROWSER_TOKEN' },
])('rejects unsupported configuration before resource mounting: %j', (config) => {
  expect(() => Provider.Config(config as Parameters<typeof Provider.Config>[0])).toThrow()
  expect(mountSessionMcp).not.toHaveBeenCalled()
})

it('defaults pointerCoordinates to pixel and wires the tool decorator for every space', () => {
  expect(Provider.Config({ mode: 'launch' })).toEqual({ mode: 'launch', headless: true, capabilities: [], pointerCoordinates: 'pixel' })
  expect(Provider.Config({ mode: 'attach', endpoint: 'http://127.0.0.1:9222', pointerCoordinates: 'normalized-1000-xy' }))
    .toMatchObject({ pointerCoordinates: 'normalized-1000-xy' })
  expect(() => Provider.Config({ mode: 'launch', pointerCoordinates: 'diagonal' } as never)).toThrow()
  expect(() => Provider.Config({ mode: 'launch', pointerCoordinates: 'normalized-1000-yx' } as never)).toThrow()

  Provider.apply(new Context(), Provider.Config({ mode: 'launch' }))
  const pixelDecorator = vi.mocked(mountSessionMcp).mock.calls[0]![1].decorateTool!
  const untouched = {
    name: 'mcp__playwright-mcp__browser_mouse_click_xy',
    rawName: 'browser_mouse_click_xy',
    description: 'Click mouse button at a given position',
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({}),
  }
  expect(pixelDecorator(untouched, () => Promise.resolve({}))).toBe(untouched)

  Provider.apply(new Context(), Provider.Config({ mode: 'launch', capabilities: ['vision'], pointerCoordinates: 'normalized-1000-xy' }))
  const normalizedDecorator = vi.mocked(mountSessionMcp).mock.calls[1]![1].decorateTool!
  expect(normalizedDecorator(untouched, () => Promise.resolve({}))).not.toBe(untouched)
})

it.each([
  { mode: 'launch' as const },
  { mode: 'attach' as const, endpoint: 'http://localhost:9222' },
  { mode: 'extension' as const },
])('rejects a normalized pointer space without the vision capability in $mode mode', (config) => {
  const ctx = new Context()
  expect(() => {
    Provider.apply(ctx, Provider.Config({ ...config, pointerCoordinates: 'normalized-1000-xy' }))
  })
    .toThrow('pointerCoordinates normalized-1000-xy requires capabilities [vision]')
  expect(mountSessionMcp).not.toHaveBeenCalled()
})
