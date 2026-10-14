import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { bwrapProfileArgs, landlockProfileArgs, seatbeltProfileArgs } from '../src/profiles.ts'

function fixture(onTestFinished: (cleanup: () => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-read-denial-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const file = join(root, 'secret.yaml')
  writeFileSync(file, 'test secret', { mode: 0o600 })
  return { root, file, canonical: realpathSync.native(file) }
}

describe('read-denial profiles', () => {
  it.each(['read-only', 'workspace-write'] as const)('masks only existing files after all bwrap grants in %s', (mode) => {
    const { root, file, canonical } = fixture(onTestFinished)
    const policy = { mode, workspaceRoot: root }
    const args = bwrapProfileArgs(policy, [canonical, join(root, 'absent')])
    expect(args.slice(-3)).toEqual(['--ro-bind', '/dev/null', canonical])
    expect(args).not.toContain(join(root, 'absent'))
    expect(landlockProfileArgs({ ...policy, deniedReadPaths: [file] })).toEqual(landlockProfileArgs(policy))
    const profile = seatbeltProfileArgs(policy, [canonical])[1]
    expect(profile).toContain(`(deny file-read* (literal "${canonical}"))`)
  })

  it('quotes SBPL filenames with backslashes and quotes', () => {
    expect(seatbeltProfileArgs({ mode: 'read-only', workspaceRoot: '/' }, ['a"b\\c'])[1])
      .toContain('(literal "a\\"b\\\\c")')
  })

  it('denies mutation of a protected workspace file after granting ordinary workspace writes', ({ onTestFinished }) => {
    const { root, canonical } = fixture(onTestFinished)
    const profile = seatbeltProfileArgs({ mode: 'workspace-write', workspaceRoot: root }, [canonical])[1]!
    const deny = `(deny file-write* (literal "${canonical}"))`
    expect(profile).toContain(deny)
    expect(profile.indexOf(deny)).toBeGreaterThan(profile.lastIndexOf('(allow file-write*'))
    expect(profile).toContain(`(subpath "${realpathSync.native(root)}")`)
  })

  it.each(['bwrap', 'landlock', 'seatbelt', 'windows-acl'] as const)('uses provider files for %s and preserves its enforcement judgment', async (runner) => {
    const { root, file, canonical } = fixture(onTestFinished)
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    ctx.provide('credentials', { agentDeniedReadPaths: [file] })
    await ctx.plugin(LocalSandboxProvider)
    const sandbox = ctx.sandbox as LocalSandboxProvider
    sandbox.internals = { chain: [runner], windowsAclRunnerArgs: ['fake-acl'] }
    const confined = await sandbox.confine(['cat', file], { mode: 'read-only', workspaceRoot: root })
    const profile = confined.argv.slice(0, confined.argv.indexOf('--'))
    expect(confined.enforcement).toBe(runner === 'landlock' || runner === 'windows-acl' ? 'partial' : 'full')
    if (runner === 'bwrap') expect(profile).toContain(canonical)
    if (runner === 'seatbelt') expect(confined.argv[2]).toContain(`(deny file-read* (literal "${canonical}"))`)
    if (runner === 'landlock') expect(profile).not.toContain(canonical)
    if (runner === 'windows-acl') expect(profile).not.toContain(canonical)
  })

  it('adds exclusions to bwrap-compatible runner overrides', async ({ onTestFinished }) => {
    const { root, file, canonical } = fixture(onTestFinished)
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider, { runnerCommand: ['custom'], runnerFailureSignatures: ['custom failed'] })
    try {
      const confined = await ctx.sandbox.confine(['cat', file], { mode: 'workspace-write', workspaceRoot: root, deniedReadPaths: [file] })
      expect(confined.argv).toContain(canonical)
      expect(confined.enforcement).toBe('full')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.skipIf(process.platform === 'win32')('normalizes symlink and parent-component exclusions before Seatbelt matching', async ({ onTestFinished }) => {
    const { root, file, canonical } = fixture(onTestFinished)
    const directory = join(root, 'child')
    mkdirSync(directory)
    const alias = join(root, 'alias')
    symlinkSync(file, alias)
    const ctx = new Context()
    await ctx.plugin(LocalSandboxProvider)
    try {
      const sandbox = ctx.sandbox as LocalSandboxProvider
      sandbox.internals = { chain: ['seatbelt'] }
      for (const path of [alias, directory + '/../secret.yaml']) {
        const confined = await sandbox.confine(['cat', path], { mode: 'workspace-write', workspaceRoot: root, deniedReadPaths: [path] })
        expect(confined.argv[2]).toContain(`(deny file-read* (literal "${canonical}"))`)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
