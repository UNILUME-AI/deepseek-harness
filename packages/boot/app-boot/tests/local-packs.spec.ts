/**
 * Local packs at the two fixed installation locations: the source checkout's workspace root and the prepared
 * Desktop runtime root, including patch insertion, runtime resolution, and every rejected layout.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createRuntimeResolution, loadProfileDirectory } from '../src/index.ts'
import { stageLocalPacksRuntimeMetadata } from '../../../../scripts/local-packs.ts'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const PACK = '@fixture/local-pack'
const BASE = '@deepseek-ai/dsh-base'
const WEB = '@deepseek-ai/dsh-web-app'
const OTHER = '@fixture/other-bundle'

function tmp(): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-local-packs-')))
  tempRoots.push(dir)
  return dir
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`)
}

/** Write one package directory with a manifest and an ESM entry. */
function writePackage(dir: string, manifest: Record<string, unknown>): void {
  writeJson(join(dir, 'package.json'), { version: '1.0.0', type: 'module', main: './index.js', ...manifest })
  writeFileSync(join(dir, 'index.js'), 'export const name = "fixture"\n')
}

/** Stage the dsh app package with base, web-app, and one more bundle beside it; returns the install anchor. */
function stageApp(appDir: string, webPatch: string[] = ['./cordis.patch.yml', './presets/standard.patch.yml']): string {
  const modules = join(appDir, 'node_modules')
  for (const [name, patch] of [[BASE, ['./cordis.patch.yml']], [WEB, webPatch], [OTHER, ['./cordis.patch.yml']]] as const) {
    const dir = join(modules, ...name.split('/'))
    writePackage(dir, { name, dsh: { bundle: { patch } } })
    for (const file of patch) {
      mkdirSync(join(dir, file, '..'), { recursive: true })
      writeFileSync(join(dir, file), '- insert: []\n')
    }
  }
  writePackage(join(modules, 'installed-dep'), { name: 'installed-dep' })
  const anchor = join(appDir, 'package.json')
  writePackage(appDir, { name: '@deepseek-ai/dsh', dependencies: { [BASE]: '1.0.0', [WEB]: '1.0.0', [OTHER]: '1.0.0', 'installed-dep': '1.0.0' } })
  return anchor
}

function stageProfileDir(root: string): string {
  const dir = join(root, 'home/profiles/web')
  writeJson(join(dir, 'package.json'), { name: 'web', private: true, dsh: { profile: { bundles: [BASE, WEB, OTHER] } } })
  return dir
}

/** Write a source-checkout local pack with one installed dependency. */
function writeLocalPack(localRoot: string, directory = 'pack', name = PACK): string {
  const dir = join(localRoot, directory)
  writePackage(dir, { name, dependencies: { 'pack-dep': '1.0.0' } })
  writePackage(join(dir, 'node_modules/pack-dep'), { name: 'pack-dep' })
  return dir
}

function writePatches(localRoot: string): void {
  mkdirSync(localRoot, { recursive: true })
  writeFileSync(join(localRoot, 'base.patch.yml'), '- insert:\n    - id: local-base\n      name: local-base-plugin\n')
  writeFileSync(join(localRoot, 'bundle.patch.yml'), `- insert:\n    - id: local-pack\n      name: '${PACK}'\n`)
}

/** Stage a source checkout: `pnpm-workspace.yaml` at `root`, the app under `apps/cli`. */
function stageSource(root = tmp()): { root: string; anchor: string; profileDir: string; localRoot: string } {
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - local-packs/*\n')
  return { root, anchor: stageApp(join(root, 'apps/cli')), profileDir: stageProfileDir(root), localRoot: join(root, 'local-packs') }
}

async function resolvedNames(anchor: string, profileDir: string): Promise<string[]> {
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  const resolution = await createRuntimeResolution({ installAnchor: anchor, profile, home: join(profileDir, '../..') })
  return resolution.entries.map(entry => entry.name)
}

function patchPaths(anchor: string, profileDir: string): string[][] {
  return loadProfileDirectory('dsh', profileDir, anchor).layers.map(layer => [...layer.patchPaths])
}

function ownPatchPaths(appDir: string): string[][] {
  const modules = join(appDir, 'node_modules')
  return [
    [join(modules, BASE, 'cordis.patch.yml')],
    [join(modules, WEB, 'cordis.patch.yml'), join(modules, WEB, 'presets/standard.patch.yml')],
    [join(modules, OTHER, 'cordis.patch.yml')],
  ]
}

const INSTALLATION_NAMES = ['@deepseek-ai/dsh', BASE, WEB, OTHER, 'installed-dep']

describe('source checkout local packs', () => {
  it('adds nothing when local-packs is absent or empty', async () => {
    const source = stageSource()
    expect(patchPaths(source.anchor, source.profileDir)).toEqual(ownPatchPaths(join(source.root, 'apps/cli')))
    expect(await resolvedNames(source.anchor, source.profileDir)).toEqual(INSTALLATION_NAMES)
    mkdirSync(source.localRoot)
    expect(patchPaths(source.anchor, source.profileDir)).toEqual(ownPatchPaths(join(source.root, 'apps/cli')))
    expect(await resolvedNames(source.anchor, source.profileDir)).toEqual(INSTALLATION_NAMES)
  })

  it('resolves packs and their dependencies and inserts patches after each main bundle patch', async () => {
    const source = stageSource()
    const packDir = writeLocalPack(source.localRoot)
    writePatches(source.localRoot)
    writeFileSync(join(source.localRoot, 'notes.txt'), 'files beside packs are ignored\n')
    const own = ownPatchPaths(join(source.root, 'apps/cli'))
    expect(patchPaths(source.anchor, source.profileDir)).toEqual([
      [own[0]![0], join(source.localRoot, 'base.patch.yml')],
      [own[1]![0], join(source.localRoot, 'bundle.patch.yml'), own[1]![1]],
      own[2],
    ])
    const profile = loadProfileDirectory('dsh', source.profileDir, source.anchor)
    const resolution = await createRuntimeResolution({ installAnchor: source.anchor, profile, home: join(source.root, 'home') })
    expect(resolution.entries.map(entry => entry.name)).toEqual([...INSTALLATION_NAMES, PACK, 'pack-dep'])
    expect(resolution.entries.find(entry => entry.name === PACK)).toMatchObject({
      packageDir: packDir, declarer: join(packDir, 'package.json'), version: '1.0.0', scope: 'installation',
    })
  })

  it('skips a patched bundle that does not declare ./cordis.patch.yml', () => {
    const root = tmp()
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    const anchor = stageApp(join(root, 'apps/cli'), ['./presets/standard.patch.yml'])
    writePatches(join(root, 'local-packs'))
    const profile = loadProfileDirectory('dsh', stageProfileDir(root), anchor)
    expect(profile.skippedBundles).toEqual([{
      packageName: WEB,
      reason: `Error: dsh local packs: ${WEB} does not declare ./cordis.patch.yml in dsh.bundle.patch`,
    }])
  })

  it.each([
    ['a file named local-packs', (localRoot: string) => { writeFileSync(localRoot, '') }, 'is not a directory'],
    ['a directory without package.json', (localRoot: string) => { mkdirSync(join(localRoot, 'empty'), { recursive: true }) }, 'has no package.json'],
    ['a manifest without a name', (localRoot: string) => { writeJson(join(localRoot, 'nameless/package.json'), {}) }, 'must declare a package name'],
    ['two packs with one name', (localRoot: string) => { writeLocalPack(localRoot, 'a'); writeLocalPack(localRoot, 'b') }, `duplicate package name ${PACK}`],
    ['a pack named like an installed package', (localRoot: string) => { writeLocalPack(localRoot, 'web', WEB) }, `package ${WEB} conflicts with the installation`],
  ])('rejects %s', async (_label, arrange, message) => {
    const source = stageSource()
    arrange(source.localRoot)
    await expect(resolvedNames(source.anchor, source.profileDir)).rejects.toThrow(message)
  })

  it('does not search above the workspace root', async () => {
    const outer = tmp()
    writeLocalPack(join(outer, 'local-packs'))
    writePatches(join(outer, 'local-packs'))
    const root = join(outer, 'checkout')
    mkdirSync(root)
    const source = stageSource(root)
    expect(patchPaths(source.anchor, source.profileDir)).toEqual(ownPatchPaths(join(root, 'apps/cli')))
    expect(await resolvedNames(source.anchor, source.profileDir)).toEqual(INSTALLATION_NAMES)
  })

  it('does not read the main checkout local packs from a nested worktree', async () => {
    const main = stageSource()
    writeLocalPack(main.localRoot)
    writePatches(main.localRoot)
    const worktreeRoot = join(main.root, '.worktrees/feature')
    mkdirSync(worktreeRoot, { recursive: true })
    const worktree = stageSource(worktreeRoot)
    expect(patchPaths(worktree.anchor, worktree.profileDir)).toEqual(ownPatchPaths(join(worktreeRoot, 'apps/cli')))
    expect(await resolvedNames(worktree.anchor, worktree.profileDir)).toEqual(INSTALLATION_NAMES)
  })

  it('has no local packs outside any workspace', async () => {
    const root = tmp()
    writeLocalPack(join(root, 'local-packs'))
    const anchor = stageApp(join(root, 'app'))
    expect(await resolvedNames(anchor, stageProfileDir(root))).toEqual(INSTALLATION_NAMES)
  })
})

/** Stage a prepared Desktop runtime whose `node_modules` holds the dsh app and the installed local pack. */
function stageRuntime(runtimeName = '@deepseek-ai/dsh-desktop-runtime'): { root: string; anchor: string; profileDir: string; localRoot: string } {
  const root = tmp()
  const runtimeRoot = join(root, 'runtime')
  const anchor = stageApp(join(runtimeRoot, 'node_modules/@deepseek-ai/dsh'))
  writeJson(join(runtimeRoot, 'package.json'), { name: runtimeName, private: true })
  writePackage(join(runtimeRoot, 'node_modules', PACK), { name: PACK })
  return { root, anchor, profileDir: stageProfileDir(root), localRoot: join(runtimeRoot, 'local-packs') }
}

describe('prepared Desktop runtime local packs', () => {
  it('loads the packs and patches staged from a source checkout', async () => {
    const runtime = stageRuntime()
    const source = stageSource()
    writeLocalPack(source.localRoot)
    writePatches(source.localRoot)
    stageLocalPacksRuntimeMetadata(source.root, join(runtime.localRoot, '..'))
    const own = ownPatchPaths(join(runtime.anchor, '..'))
    expect(patchPaths(runtime.anchor, runtime.profileDir)).toEqual([
      [own[0]![0], join(runtime.localRoot, 'base.patch.yml')],
      [own[1]![0], join(runtime.localRoot, 'bundle.patch.yml'), own[1]![1]],
      own[2],
    ])
    expect(await resolvedNames(runtime.anchor, runtime.profileDir)).toEqual([...INSTALLATION_NAMES, PACK])
  })

  it('adds nothing for an index staged from a checkout without local packs', async () => {
    const runtime = stageRuntime()
    stageLocalPacksRuntimeMetadata(stageSource().root, join(runtime.localRoot, '..'))
    expect(patchPaths(runtime.anchor, runtime.profileDir)).toEqual(ownPatchPaths(join(runtime.anchor, '..')))
    expect(await resolvedNames(runtime.anchor, runtime.profileDir)).toEqual(INSTALLATION_NAMES)
  })

  it.each([
    ['a missing index', undefined, 'prepared Desktop runtime has no'],
    ['a non-array index', '{}', 'must contain a package-name array'],
    ['an empty package name', '[""]', 'must contain a package-name array'],
    ['duplicate names', `["${PACK}","${PACK}"]`, 'contains duplicate package names'],
    ['a package absent from node_modules', '["@fixture/missing"]', '@fixture/missing is absent from the prepared runtime'],
    ['a package named like an installed package', `["${WEB}"]`, `package ${WEB} conflicts with the installation`],
  ])('rejects %s', async (_label, index, message) => {
    const runtime = stageRuntime()
    mkdirSync(runtime.localRoot)
    if (index !== undefined) writeFileSync(join(runtime.localRoot, '.packages.json'), index)
    await expect(resolvedNames(runtime.anchor, runtime.profileDir)).rejects.toThrow(message)
  })

  it('rejects an installed manifest whose name differs from the index', async () => {
    const runtime = stageRuntime()
    writePackage(join(runtime.localRoot, '../node_modules', PACK), { name: '@fixture/renamed' })
    mkdirSync(runtime.localRoot)
    writeFileSync(join(runtime.localRoot, '.packages.json'), `["${PACK}"]`)
    await expect(resolvedNames(runtime.anchor, runtime.profileDir)).rejects.toThrow(`installed manifest does not match ${PACK}`)
  })

  it('ignores local-packs beside an installation that is not the Desktop runtime', async () => {
    const runtime = stageRuntime('consumer-project')
    writePatches(runtime.localRoot)
    writeFileSync(join(runtime.localRoot, '.packages.json'), `["${PACK}"]`)
    expect(patchPaths(runtime.anchor, runtime.profileDir)).toEqual(ownPatchPaths(join(runtime.anchor, '..')))
    expect(await resolvedNames(runtime.anchor, runtime.profileDir)).toEqual(INSTALLATION_NAMES)
    rmSync(join(runtime.localRoot, '../package.json'))
    expect(await resolvedNames(runtime.anchor, runtime.profileDir)).toEqual(INSTALLATION_NAMES)
  })
})
