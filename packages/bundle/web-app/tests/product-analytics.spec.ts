import OTel from '@deepseek-ai/dsh-otel'
/** Product collection stays off across profiles; an opted-in launch still gets bounded shutdown against an unresponsive receiver. */
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as Telemetry from '@deepseek-ai/dsh-host-product-telemetry-otel'
import Analytics from '@deepseek-ai/dsh-client-product-analytics'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs() })

it.each(['desktop', 'web'])('keeps product collection off across profiles: %s', async (profile) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('profileContext', {
    name: profile, dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
    cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  })
  const identity = vi.fn().mockResolvedValue(undefined)
  ctx.provide('deepseekAccount', { getDeviceIdentity: identity } as never)
  await ctx.plugin(OTel)
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader).await()
  ctx.loader.builtins.telemetry = Telemetry
  ctx.loader.builtins.analytics = Analytics
  const rows = loadOverlayPatches('analytics', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))
    .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'desktop-product-telemetry' || row.id === 'product-analytics')
  // The bundle disables both rows unconditionally: a literal flag, not the
  // upstream profile-gated expression, and no profile may boot collection.
  expect(rows).toHaveLength(2)
  for (const row of rows) expect(row.disabled).toBe(true)
  const entries = rows.map(row => ({ ...row, name: row.id === 'desktop-product-telemetry' ? 'cordis:telemetry' : 'cordis:analytics' }))
  await ctx.loader.root.update(entries)
  await ctx.loader.await()
  expect(ctx.loader.resolve('desktop-product-telemetry').disabled).toBe(true)
  expect(ctx.get('productTelemetry')).toBeUndefined()
  expect(ctx.get('productAnalytics')).toBeUndefined()
  if (profile !== 'desktop') return

  // A deployment that re-enables collection keeps the collector policy and
  // bounded shutdown the plugins own.
  const received = Promise.withResolvers<undefined>()
  const server = createServer((req) => { req.resume(); req.once('end', () => { received.resolve(undefined) }) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing collector address')
  vi.stubEnv('DSH_CLIENT_VERSION', 'test-version')
  vi.stubEnv('DSH_PRODUCT_ANALYTICS_OTLP_URL', `http://127.0.0.1:${address.port}/logs`)
  expect(rows[0]!.config).toMatchObject({
    scheduledDelayMillis: 30000, timeoutMillis: 15000, exportTimeoutMillis: 20000, shutdownTimeoutMillis: 2000,
  })
  const enabledEntries = entries.map(row => ({ ...row, disabled: false }))
  await ctx.loader.root.update(enabledEntries)
  await ctx.loader.await()
  expect(ctx.loader.resolve('desktop-product-telemetry').disabled).toBe(false)
  const entry = ctx.loader.resolve('desktop-product-telemetry')
  const analytics = ctx.productAnalytics
  const analyticsFiber = ctx.loader.resolve('product-analytics').fiber
  const telemetryFiber = entry.fiber
  const lifetime = new AbortController()
  onTestFinished(() => { lifetime.abort() })
  const policy = analytics.watchPolicy(lifetime.signal)[Symbol.asyncIterator]()
  expect(await policy.next()).toEqual({ value: true, done: false })
  for (const enabled of [false, true]) {
    const changed = policy.next()
    await ctx.loader.root.update(enabledEntries.map(row => row.id === 'product-analytics'
      ? { ...row, config: { ...row.config as Record<string, unknown>, enabled } } : row))
    await ctx.loader.await()
    expect(await changed).toEqual({ value: enabled, done: false })
    expect(ctx.loader.resolve('product-analytics').fiber === analyticsFiber).toBe(true)
    expect(entry.fiber === telemetryFiber).toBe(true)
    if (!enabled) {
      await analytics.report({ eventName: 'desktop_app_launch', timestamp: 1, attributes: {} })
      expect(identity).not.toHaveBeenCalled()
    }
  }
  const emit = vi.spyOn(ctx.productTelemetry, 'emit')
  await analytics.report({ eventName: 'desktop_app_launch', timestamp: 1, attributes: {} })
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({ attributes: { app_version: 'test-version' } }))
  lifetime.abort()
  await policy.return?.()
  ctx.productTelemetry.emit({ eventName: 'desktop_upgrade_install_restart_click', body: 'upgrade', timestamp: Date.now() })
  const disposal = entry.fiber!.dispose()
  await received.promise
  await disposal
})
