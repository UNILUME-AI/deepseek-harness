/** Shared local file read exclusions for process profiles and the in-process filesystem provider. @module */

import type { Context } from '@deepseek-ai/cordis'
import { realpathSync, statSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SandboxExecutionPolicy } from './index.ts'

/** Local credential providers publish filenames through their existing Cordis service slot. */
interface CredentialFiles {
  readonly agentDeniedReadPaths: readonly string[]
}

/** Resolve missing leaves through their existing ancestors; permission and I/O errors fail closed. */
function canonicalFile(path: string): string {
  try {
    return realpathSync.native(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(canonicalFile(parent), basename(path))
  }
}

/**
 * Derive the one local read-denial list from provider-owned filenames and additional policy entries.
 * The structural Cordis lookup avoids coupling process confinement to a credential implementation.
 * @param ctx - context containing the optional credentials service.
 * @param policy - per-call mode and additional absolute host filenames.
 * @returns canonical, deduplicated filenames; no exclusions in danger-full-access.
 */
export function deniedReadPaths(ctx: Context, policy: SandboxExecutionPolicy): string[] {
  if (policy.mode === 'danger-full-access') return []
  const credentials = ctx.get('credentials') as CredentialFiles | undefined
  return [...new Set([...(credentials?.agentDeniedReadPaths ?? []), ...(policy.deniedReadPaths ?? [])]
    .map(path => canonicalFile(path)))]
}

/** Obtain file identity without contents; missing files have no inode to compare. */
function identity(path: string): BigIntStats | undefined {
  try {
    return statSync(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined
    throw error
  }
}

/**
 * Match a local target by canonical filename or device/inode, including hard-link aliases.
 * @param path - path the reader is about to open.
 * @param denied - canonical filenames from deniedReadPaths.
 * @returns true for a denied file; filesystem errors other than absence fail closed.
 */
export function isReadDenied(path: string, denied: readonly string[]): boolean {
  if (denied.length === 0) return false
  const canonical = canonicalFile(path)
  const folded = (value: string): string => process.platform === 'darwin' || process.platform === 'win32' ? value.toLowerCase() : value
  const target = identity(canonical)
  return denied.some((file) => {
    if (folded(canonical) === folded(file)) return true
    const source = identity(file)
    return target !== undefined && source !== undefined && target.dev === source.dev && target.ino === source.ino
  })
}
