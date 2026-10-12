/** Discover, build, and stage the ignored workspace packages under `local-packs/`. */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** One local pack's workspace directory and parsed manifest. */
export interface LocalPack {
  /** Absolute package directory. */
  readonly directory: string
  /** Manifest package name. */
  readonly name: string
  /** Parsed package manifest. */
  readonly manifest: Record<string, unknown>
}

const LOCAL_PACKS_DIRECTORY = 'local-packs'
const RUNTIME_PATCHES = ['base.patch.yml', 'bundle.patch.yml'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read the immediate package directories in one checkout's ignored local-packs workspace.
 * `locateLocalPacks` and `localPackPackages` in `packages/boot/app-boot/src/profile.ts` apply the same rules at
 * source launch; this copy exists because the root build runs it before workspace packages are built.
 * @param repositoryRoot - Repository root containing `local-packs/`.
 * @returns Packages in directory-name order; an absent or empty directory returns no packages.
 * @throws When a child directory lacks a valid named package manifest or package names collide.
 */
export function discoverLocalPacks(repositoryRoot: string): LocalPack[] {
  const localRoot = join(resolve(repositoryRoot), LOCAL_PACKS_DIRECTORY)
  if (!existsSync(localRoot)) return []
  if (!statSync(localRoot).isDirectory()) throw new Error(`local packs: ${localRoot} is not a directory`)

  const names = new Set<string>()
  const packs: LocalPack[] = []
  const entries = readdirSync(localRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const directory = join(localRoot, entry.name)
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) throw new Error(`local packs: ${directory} has no package.json`)
    const value: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (!isRecord(value)) {
      throw new Error(`local packs: ${manifestPath} must declare a package name`)
    }
    const { name } = value
    if (typeof name !== 'string' || name === '') {
      throw new Error(`local packs: ${manifestPath} must declare a package name`)
    }
    if (names.has(name)) throw new Error(`local packs: duplicate package name ${name}`)
    names.add(name)
    packs.push({ directory, name, manifest: value })
  }
  return packs
}

/**
 * Run each local pack's required build script through the pnpm executable that launched dsh.
 * @param repositoryRoot - Repository root containing `local-packs/`.
 * @param environment - Build process environment, including pnpm's lifecycle executable.
 * @returns Nothing when every pack build succeeds.
 * @throws When a package omits `scripts.build`, pnpm cannot be resolved, or a build exits unsuccessfully.
 */
export function buildLocalPacks(repositoryRoot: string, environment: NodeJS.ProcessEnv = process.env): void {
  const root = resolve(repositoryRoot)
  for (const pack of discoverLocalPacks(root)) {
    const scripts = Reflect.get(pack.manifest, 'scripts')
    if (scripts === null || typeof scripts !== 'object' || typeof Reflect.get(scripts, 'build') !== 'string') {
      throw new Error(`local packs: ${pack.name} must declare scripts.build`)
    }
    const isNpmEntrypoint = /(?:^|[/\\])npm-cli\.js$/iu.test(environment.npm_execpath ?? '')
    const directoryArgument = isNpmEntrypoint ? '--prefix' : '--dir'
    const invocation = pnpmInvocation([directoryArgument, pack.directory, 'run', 'build'], environment)
    const result = spawnSync(invocation.command, invocation.args, { cwd: root, env: environment, stdio: 'inherit' })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) {
      throw new Error(`local packs: ${pack.name} build exited with ${String(result.status ?? result.signal)}`)
    }
  }
}

/**
 * Copy local patch files and package names into a prepared Desktop runtime.
 * The Desktop runtime reads `local-packs/.packages.json` instead of scanning directories, so the index is written
 * even when it lists no package.
 * @param repositoryRoot - Repository root containing the local packs.
 * @param runtimeRoot - Prepared runtime directory that contains its production `node_modules`.
 * @returns Nothing when the index and existing patch files are staged.
 */
export function stageLocalPacksRuntimeMetadata(repositoryRoot: string, runtimeRoot: string): void {
  const root = resolve(repositoryRoot)
  const localRoot = join(root, LOCAL_PACKS_DIRECTORY)
  const stagedRoot = join(resolve(runtimeRoot), LOCAL_PACKS_DIRECTORY)
  mkdirSync(stagedRoot, { recursive: true })
  for (const file of RUNTIME_PATCHES) {
    if (existsSync(join(localRoot, file))) copyFileSync(join(localRoot, file), join(stagedRoot, file))
  }
  writeFileSync(join(stagedRoot, '.packages.json'), `${JSON.stringify(discoverLocalPacks(root).map(pack => pack.name))}\n`)
}
