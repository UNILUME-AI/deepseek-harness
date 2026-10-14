/**
 * Kernel-level proof that a confined ripgrep cannot read a denied file, and
 * that a confined directory search still returns every other file's matches
 * (ripgrep exits 2 on the denied file's permission error; the tool parses the
 * remaining stream as a partial result). Skips on hosts without a usable
 * confinement runner.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { resolveRgPath } from '@deepseek-ai/dsh-tool-fs-search'

async function usable(policy: { mode: 'read-only'; workspaceRoot: string }): Promise<boolean> {
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSandboxProvider)
    await ctx.sandbox.confine(['true'], policy)
    return true
  } catch {
    return false
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('confined ripgrep read denial', () => {
  it('reads no content from the denied file and keeps every other match in a directory search', async ({ onTestFinished, skip }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-confined-rg-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const file = join(root, 'Secret.yaml')
    const secret = 'DSH_READ_DENIAL_TEST: fixture-secret'
    writeFileSync(file, `version: 1\nrefs:\n  ${secret}\n`, { mode: 0o600 })
    writeFileSync(join(root, 'public.txt'), 'public-line\n')
    if (!await usable({ mode: 'read-only', workspaceRoot: root })) skip()
    await ctx.plugin(LocalSandboxProvider)
    const policy = { mode: 'workspace-write' as const, workspaceRoot: root, deniedReadPaths: [file] }
    const rg = await resolveRgPath()

    // Searching the denied file directly yields no content under any runner:
    // Seatbelt/Landlock fail the open, bwrap masks the file with /dev/null.
    const direct = await ctx.sandbox.confine([rg, '--no-config', '--json', '--regexp=fixture-secret', '--', file], policy)
    const denied = spawnSync(direct.argv[0]!, direct.argv.slice(1), { encoding: 'utf8' })
    expect(denied.error).toBeUndefined()
    expect(denied.status).not.toBe(0)
    expect(denied.stdout).not.toContain('fixture-secret')

    // A directory search still returns the remaining files' matches; the
    // denied file contributes a permission error, not content.
    const confined = await ctx.sandbox.confine([rg, '--no-config', '--json', '--regexp=line', '--', root], policy)
    const search = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: 'utf8' })
    expect(search.error).toBeUndefined()
    expect(search.stdout).toContain('public-line')
    expect(search.stdout).not.toContain('fixture-secret')
  })
})
