import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import BrowserUseRegistry from '../src/index.ts'
import { BrowserUseProviderName } from '../src/brand.ts'

const MCP = BrowserUseProviderName('playwright-mcp')
const SIDEBAR = BrowserUseProviderName('sidebar-browser')

describe('browser-use provider registration', () => {
  it('admits providers with distinct names and rejects a repeated name', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(BrowserUseRegistry)
      expect(ctx.browserUse.providerNames).toEqual([])
      const dispose = ctx.browserUse.register(MCP)
      const disposeSidebar = ctx.browserUse.register(SIDEBAR)
      expect(ctx.browserUse.providerNames).toEqual([MCP, SIDEBAR])
      expect(() => ctx.browserUse.register(MCP)).toThrow('browser use provider "playwright-mcp" is already registered')
      expect(() => ctx.browserUse.register(SIDEBAR)).toThrow('"sidebar-browser" is already registered')
      await dispose()
      expect(ctx.browserUse.providerNames).toEqual([SIDEBAR])
      const disposeAgain = ctx.browserUse.register(MCP)
      await dispose()
      expect(ctx.browserUse.providerNames).toEqual([SIDEBAR, MCP])
      await disposeSidebar()
      await disposeAgain()
      expect(ctx.browserUse.providerNames).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('releases a provider contribution when its plugin unloads', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(BrowserUseRegistry)
      const provider = ctx.plugin({
        name: 'test-browser-use-provider',
        inject: ['browserUse'],
        apply(ctx: Context) { ctx.browserUse.register(MCP) },
      })
      await provider
      expect(ctx.browserUse.providerNames).toEqual([MCP])
      await provider.dispose()
      expect(ctx.browserUse.providerNames).toEqual([])
      ctx.browserUse.register(MCP)
      expect(ctx.browserUse.providerNames).toEqual([MCP])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
