/**
 * The confinement runner refuses the denied file to ripgrep itself, and grep
 * tool directory searches omit denied credentials and retain public matches.
 * Skips on hosts without a usable confinement runner.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

async function usable(policy: { mode: 'read-only'; workspaceRoot: string }): Promise<boolean> {
  const ctx = new Context()
  try {
    await ctx.plugin(LocalSandboxProvider)
    const confined = await ctx.sandbox.confine(['true'], policy)
    return spawnSync(confined.argv[0]!, confined.argv.slice(1)).status === 0
  } catch {
    return false
  } finally {
    await ctx.fiber.dispose()
  }
}

describe('confined ripgrep read denial', () => {
  it('the confinement runner itself refuses the denied file', async ({ onTestFinished, skip }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-confined-rg-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const file = join(root, 'Secret.yaml')
    writeFileSync(file, 'DSH_READ_DENIAL_TEST: fixture-secret\n', { mode: 0o600 })
    if (!await usable({ mode: 'read-only', workspaceRoot: root })) skip()
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    await ctx.plugin(LocalSandboxProvider)
    const confined = await ctx.sandbox.confine(
      [await ToolFsSearch.resolveRgPath(), '--no-config', 'fixture-secret', file],
      { mode: 'workspace-write', workspaceRoot: root, deniedReadPaths: [file] },
    )
    const run = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: 'utf8' })
    expect(run.status).not.toBe(0)
    expect(run.stdout).not.toContain('fixture-secret')
  })

  for (const publicMatches of [false, true]) {
    it(`searches through grep with public matches: ${publicMatches}`, async ({ onTestFinished, skip }) => {
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
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root, deniedReadPaths: [file] })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
      const result = await ctx.tools.execute({
        callId: ToolCallId('confined-grep'), name: 'grep',
        arguments: { pattern: publicMatches ? 'line|fixture-secret' : 'fixture-secret', path: root },
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      expect(result.value).toEqual(publicMatches
        ? { matches: [{ path: join(root, 'public.txt'), lineNumber: 1, line: 'public-line' }] }
        : { matches: [] })
      const output = JSON.stringify(result)
      expect(output).not.toContain(secret)
      expect(output).not.toContain('fixture-secret')
      expect(output).not.toContain('DSH_READ_DENIAL_TEST')
      if (publicMatches) expect(output).toContain('public-line')
      else expect(output).toContain('No matches found')
    })
  }
})
