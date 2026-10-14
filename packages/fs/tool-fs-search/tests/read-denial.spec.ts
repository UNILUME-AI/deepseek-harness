/** Real ripgrep calls exercise local credential exclusions through the tool registry. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SaveTextSpill } from '@deepseek-ai/dsh-spill'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

async function setup(mode: 'read-only' | 'workspace-write' | 'danger-full-access' = 'workspace-write', nestedWorkspace = false) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-grep-denied-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const file = join(root, 'Secret.yaml')
  const workdir = nestedWorkspace ? join(root, 'workspace') : root
  if (nestedWorkspace) mkdirSync(workdir)
  const extra = join(root, 'extra.yaml')
  writeFileSync(file, 'credential-secret-line\n')
  writeFileSync(extra, 'additional-secret-line\n')
  writeFileSync(join(root, 'public.txt'), 'public-line\nsecond-public-line\n')
  mkdirSync(join(root, 'child'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  ctx.provide('credentials', { agentDeniedReadPaths: [file] })
  const spilled: string[] = []
  ctx.provide('spillStore', {
    saveText: async (request: SaveTextSpill) => { spilled.push(request.content); throw new Error('fixture spill unavailable') },
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root, deniedReadPaths: [extra] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false, grepMaxMatches: 1 })
  const sessionId = SessionId('grep-read-denial')
  const session = Session.create(sessionId, undefined, {
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false, cwd: workdir,
  })
  const agent = { session } as Agent
  let callId = 0
  const grep = (path?: string, withAgent = true) => ctx.tools.execute({
    callId: ToolCallId(`credential-grep-${++callId}`), name: 'grep',
    arguments: { pattern: 'line', ...path === undefined ? {} : { path } },
    signal: new AbortController().signal, ...withAgent ? { agent } : {},
  })
  return { root, workdir, file, extra, ctx, session, grep, spilled }
}

describe('grep read exclusions', () => {
  it.skipIf(process.platform === 'win32')('rejects a symlink directory followed by parent traversal before spawning', async () => {
    const test = await setup('workspace-write', true)
    symlinkSync(join(test.root, 'child'), join(test.workdir, 'alias-dir'), 'dir')
    const spawn = vi.spyOn(test.ctx.subprocess, 'spawn')
    onTestFinished(() => { spawn.mockRestore() })
    const result = await test.grep('alias-dir/../Secret.yaml')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('credential-secret-line')
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['read-only', 'workspace-write'] as const)('rejects explicit credential and additional paths before spawning in %s', async (mode) => {
    const test = await setup(mode)
    const spawn = vi.spyOn(test.ctx.subprocess, 'spawn')
    onTestFinished(() => { spawn.mockRestore() })
    for (const path of ['Secret.yaml', test.file, test.root + '/child/../Secret.yaml', test.extra]) {
      const result = await test.grep(path)
      expect(result.isError).toBe(true)
      expect(result.error).toMatchObject({ info: { code: 'SEARCH_FAILED' } })
      expect(JSON.stringify(result)).not.toContain('secret-line')
    }
    expect(spawn).not.toHaveBeenCalled()
    expect(test.spilled).toEqual([])
  })

  it.skipIf(process.platform === 'win32')('rejects explicit symbolic and hard links before spawning', async () => {
    const test = await setup()
    const symbolic = join(test.root, 'symbolic')
    const hard = join(test.root, 'hard')
    symlinkSync(test.file, symbolic)
    linkSync(test.file, hard)
    const spawn = vi.spyOn(test.ctx.subprocess, 'spawn')
    onTestFinished(() => { spawn.mockRestore() })
    for (const path of [symbolic, hard]) expect((await test.grep(path)).isError).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it.each(['read-only', 'workspace-write'] as const)('filters directory matches before result values, metadata and spills in %s', async (mode) => {
    const test = await setup(mode)
    if (process.platform !== 'win32') linkSync(test.file, join(test.root, 'hard'))
    for (const path of [undefined, '.', test.root]) {
      const result = await test.grep(path)
      expect(result.isError).toBe(false)
      expect(result.value).toMatchObject({ matches: [
        { lineNumber: 1, line: 'public-line' },
        { lineNumber: 2, line: 'second-public-line' },
      ] })
      expect(result.value).toHaveProperty('matches.0.path', expect.stringMatching(/(?:^|[/\\])public\.txt$/u))
      expect(result.value).toHaveProperty('matches.1.path', expect.stringMatching(/(?:^|[/\\])public\.txt$/u))
      expect(JSON.stringify(result)).not.toContain('secret-line')
    }
    expect(test.spilled).toHaveLength(3)
    for (const spill of test.spilled) {
      expect(spill).toContain('second-public-line')
      expect(spill).not.toContain('secret-line')
      expect(spill).not.toContain('Secret.yaml')
    }
  })

  it('uses the deployment root for an agentless explicit target', async () => {
    const test = await setup()
    const denied = await test.grep(test.file, false)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied)).not.toContain('secret-line')
    const ordinary = await test.grep(join(test.root, 'public.txt'), false)
    expect(ordinary.isError).toBe(false)
    expect(ordinary.value).toHaveProperty('matches')
  })

  it('preserves full-access searches and honors the calling session override', async () => {
    const test = await setup('read-only')
    setSandboxMode(test.session, 'danger-full-access')
    expect((await test.grep('Secret.yaml')).value).toEqual({ matches: [
      { path: 'Secret.yaml', lineNumber: 1, line: 'credential-secret-line' },
    ] })
    expect((await test.grep('extra.yaml')).value).toEqual({ matches: [
      { path: 'extra.yaml', lineNumber: 1, line: 'additional-secret-line' },
    ] })
    setSandboxMode(test.session, 'workspace-write')
    expect((await test.grep('Secret.yaml')).isError).toBe(true)
  })

  it('keeps glob path-only discovery unchanged', async () => {
    const test = await setup()
    const result = await test.ctx.tools.execute({
      callId: ToolCallId('credential-glob'), name: 'glob', arguments: { pattern: '*.yaml', path: test.root },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(JSON.stringify(result)).toContain('Secret.yaml')
    expect(JSON.stringify(result)).not.toContain('secret-line')
  })
})
