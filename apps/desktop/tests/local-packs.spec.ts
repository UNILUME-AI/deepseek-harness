import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, createRuntimeResolution, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it } from 'vitest'
import { runBuildSteps } from '../../../scripts/build.ts'
import { discoverLocalPacks, stageLocalPacksRuntimeMetadata } from '../../../scripts/local-packs.ts'
import {
  selectDesktopPackageClosure,
  type PackedDesktopPackage,
} from '../scripts/prepare-package-set.ts'

const roots: string[] = []
const fixture = fileURLToPath(new URL('./fixtures/local-pack/', import.meta.url))
const PACK_NAME = '@fixture/minimal-local-pack'
const PNPM_ENTRYPOINT = process.env.npm_execpath
  ?? fileURLToPath(new URL('../../../node_modules/pnpm/bin/pnpm.mjs', import.meta.url))

interface LocalPackProject {
  root: string
  anchor: string
  profileDir: string
  packageDir: string
}

/** Stage a checkout with base and web-app bundles; `local-packs` is absent, empty, or holds the fixture. */
function project(localPacks: 'absent' | 'empty' | 'fixture'): LocalPackProject {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-local-packs-')))
  roots.push(root)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - local-packs/*\n  - packages/bundle/*\n')
  const cliDir = join(root, 'apps/cli')
  mkdirSync(cliDir, { recursive: true })
  const anchor = join(cliDir, 'package.json')
  writeFileSync(anchor, `${JSON.stringify({ name: '@fixture/dsh', version: '1.0.0', dependencies: {} })}\n`)
  const profileDir = join(root, 'home/profiles/web')
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'web', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  })}\n`)

  const baseDir = bundleDirectory(root, '@deepseek-ai/dsh-base', ['./cordis.patch.yml'])
  writeFileSync(join(baseDir, 'cordis.patch.yml'), '- insert: []\n')
  const webDir = bundleDirectory(root, '@deepseek-ai/dsh-web-app', ['./cordis.patch.yml', './presets/standard.patch.yml'])
  writeFileSync(join(webDir, 'cordis.patch.yml'), '- insert: []\n')
  mkdirSync(join(webDir, 'presets'), { recursive: true })
  writeFileSync(join(webDir, 'presets/standard.patch.yml'), '- insert: []\n')

  const packageDir = join(root, 'local-packs/minimal-local-pack')
  if (localPacks === 'absent') return { root, anchor, profileDir, packageDir }
  mkdirSync(join(root, 'local-packs'), { recursive: true })
  if (localPacks === 'empty') return { root, anchor, profileDir, packageDir }
  cpSync(fixture, packageDir, { recursive: true })
  writeFileSync(join(root, 'local-packs/base.patch.yml'), '- insert: []\n')
  writeFileSync(join(root, 'local-packs/bundle.patch.yml'), [
    '- insert:',
    '    - id: local-pack-test',
    `      name: '${PACK_NAME}'`,
    '',
  ].join('\n'))
  return { root, anchor, profileDir, packageDir }
}

function bundleDirectory(root: string, name: string, patch: string[]): string {
  const directory = join(root, 'apps/cli/node_modules', ...name.split('/'))
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({
    name, version: '1.0.0', dsh: { bundle: { patch } },
  })}\n`)
  return directory
}

function bundlePatch(root: string, name: string, file: string): string {
  return join(root, 'apps/cli/node_modules', ...name.split('/'), file)
}

function packed(name: string, dependencies: Record<string, string> = {}): PackedDesktopPackage {
  return { tarball: `${name}.tgz`, manifest: { name, version: '1.0.0', dependencies } }
}

const CORE_PACKAGES = [
  ['@deepseek-ai/dsh', packed('@deepseek-ai/dsh')],
  ['@deepseek-ai/dsh-desktop-host', packed('@deepseek-ai/dsh-desktop-host', { '@deepseek-ai/dsh': '1.0.0' })],
] as const

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each(['absent', 'empty'] as const)('keeps patches, resolution, closure, and staged metadata unchanged when local-packs is %s', async (localPacks) => {
  const current = project(localPacks)
  const profile = loadProfileDirectory('dsh', current.profileDir, current.anchor)
  const resolution = await createRuntimeResolution({ installAnchor: current.anchor, profile, home: join(current.root, 'home') })

  expect(discoverLocalPacks(current.root)).toEqual([])
  expect(profile.layers.map(layer => layer.patchPaths)).toEqual([
    [bundlePatch(current.root, '@deepseek-ai/dsh-base', 'cordis.patch.yml')],
    [
      bundlePatch(current.root, '@deepseek-ai/dsh-web-app', 'cordis.patch.yml'),
      bundlePatch(current.root, '@deepseek-ai/dsh-web-app', 'presets/standard.patch.yml'),
    ],
  ])
  expect(resolution.entries.map(entry => entry.name)).toEqual(['@fixture/dsh'])
  expect(selectDesktopPackageClosure(new Map(CORE_PACKAGES), current.root).map(entry => entry.manifest.name)).toEqual([
    '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host',
  ])

  const runtimeRoot = join(current.root, 'prepared-runtime')
  stageLocalPacksRuntimeMetadata(current.root, runtimeRoot)
  expect(readFileSync(join(runtimeRoot, 'local-packs/.packages.json'), 'utf8')).toBe('[]\n')
  expect(existsSync(join(runtimeRoot, 'local-packs/bundle.patch.yml'))).toBe(false)
  expect(existsSync(join(runtimeRoot, 'local-packs/base.patch.yml'))).toBe(false)
})

it('builds local packs between workspace libraries and the client build', () => {
  const current = project('fixture')
  const built = join(current.packageDir, 'lib/index.js')
  const steps: string[] = []
  runBuildSteps(current.root, { ...process.env, npm_execpath: PNPM_ENTRYPOINT }, (script) => {
    steps.push(`${script}:${existsSync(built) ? 'built' : 'unbuilt'}`)
  })
  expect(steps).toEqual(['build:native-system:unbuilt', 'build:lib:unbuilt', 'build:web:built'])
})

it('resolves, patches, packages, and stages a fixture copied into a temporary local-packs workspace', async () => {
  const current = project('fixture')
  const profile = loadProfileDirectory('dsh', current.profileDir, current.anchor)
  const resolution = await createRuntimeResolution({ installAnchor: current.anchor, profile, home: join(current.root, 'home') })
  expect(resolution.entries.find(entry => entry.name === PACK_NAME)?.packageDir).toBe(current.packageDir)
  expect(profile.layers.map(layer => layer.patchPaths)).toEqual([
    [bundlePatch(current.root, '@deepseek-ai/dsh-base', 'cordis.patch.yml'), join(current.root, 'local-packs/base.patch.yml')],
    [
      bundlePatch(current.root, '@deepseek-ai/dsh-web-app', 'cordis.patch.yml'),
      join(current.root, 'local-packs/bundle.patch.yml'),
      bundlePatch(current.root, '@deepseek-ai/dsh-web-app', 'presets/standard.patch.yml'),
    ],
  ])
  expect(composeEntries(profile.layers.map(layer => layer.patches)).find(entry => entry.id === 'local-pack-test')?.name).toBe(PACK_NAME)

  const available = new Map<string, PackedDesktopPackage>([...CORE_PACKAGES, [PACK_NAME, packed(PACK_NAME)]])
  expect(selectDesktopPackageClosure(available, current.root).map(entry => entry.manifest.name)).toEqual([
    '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', PACK_NAME,
  ])

  const runtimeRoot = join(current.root, 'prepared-runtime')
  stageLocalPacksRuntimeMetadata(current.root, runtimeRoot)
  expect(JSON.parse(readFileSync(join(runtimeRoot, 'local-packs/.packages.json'), 'utf8'))).toEqual([PACK_NAME])
  expect(readFileSync(join(runtimeRoot, 'local-packs/bundle.patch.yml'), 'utf8')).toContain(PACK_NAME)
  expect(readFileSync(join(runtimeRoot, 'local-packs/base.patch.yml'), 'utf8')).toBe('- insert: []\n')
})
