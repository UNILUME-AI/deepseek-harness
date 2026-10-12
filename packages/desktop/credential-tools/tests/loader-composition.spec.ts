// Proves the shipped composition: the plugin booted from a cordis.yml row
// registers both tools and drops them on dispose, and the web-app patch entry
// keeps the plugin desktop-only.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as CredentialTools from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot a cordis.yml carrying the desktop-credential-tools row.
 * @returns the booted context.
 */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-credential-tools-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-desktop-credential-tools'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-desktop-credential-tools', CredentialTools],
  ])
  const unreachable = (): never => { throw new Error('loader internal stub: unexpected call') }
  const internal: NonNullable<typeof ctx.loader.internal> = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
    loadCache: new Map(),
    register: unreachable,
    getOrCreateModuleJob: unreachable,
    resolveSync: unreachable,
    load: unreachable,
  }
  ctx.loader.internal = internal
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('desktop-credential-tools Loader composition', () => {
  it('registers credentials_list and credentials_fill from a cordis.yml row and removes them on dispose', async () => {
    const ctx = await boot()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual(['credentials_fill', 'credentials_list'])
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-desktop-credential-tools')
    expect(entry).toBeDefined()
    const fiber = entry!.fiber!
    ctx.loader.remove(entry!.id)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
  }, 30_000)

  it.each([
    { profile: 'desktop', disabled: false },
    { profile: 'web', disabled: true },
    { profile: undefined, disabled: true },
  ])('the shipped desktop-only gate disables the tools when profile is $profile', async ({ profile, disabled }) => {
    const patchPath = fileURLToPath(new URL('../../../bundle/web-app/cordis.patch.yml', import.meta.url))
    const rows = loadOverlayPatches('credential-tools-defaults', patchPath)
      .flatMap(patch => patch.insert ?? []).filter(row => row.id === 'desktop-credential-tools')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('@deepseek-ai/dsh-desktop-credential-tools')
    const configured = applyEntryPatches(rows, [], (message) => { throw new Error(message) })
    const ctx = new Context()
    context = ctx
    if (profile !== undefined) {
      ctx.provide('profileContext', {
        name: profile, dir: '/profile', patchPath: '/profile/cordis.patch.yml', installAnchor: '/profile/package.json',
        cwd: '/workspace', home: '/home', startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
      })
    }
    ctx.baseUrl = 'file:///'
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Loader).await()
    ctx.loader.builtins['desktop-credential-tools'] = CredentialTools
    await ctx.loader.root.update([{ ...configured[0]!, name: 'cordis:desktop-credential-tools' }])
    await ctx.loader.await()
    const entry = ctx.loader.resolve('desktop-credential-tools')
    expect(entry.disabled).toBe(disabled)
    expect(entry.fiber !== undefined).toBe(!disabled)
  }, 30_000)
})
