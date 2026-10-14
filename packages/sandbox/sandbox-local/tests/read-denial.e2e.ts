import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'

const probe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', 'true'], { encoding: 'utf8' })

describe.skipIf(process.platform !== 'darwin' || probe.status !== 0)('real Seatbelt protected credential reads', () => {
  it('denies renaming a protected workspace file and preserves ordinary workspace writes', async ({ onTestFinished }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-seatbelt-secret-rename-'))
    onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    const file = join(root, 'Secret.yaml')
    const renamed = join(root, 'renamed.yaml')
    const content = 'version: 1\nrefs:\n  DSH_READ_DENIAL_TEST: fixture-secret\n'
    writeFileSync(file, content, { mode: 0o600 })
    await ctx.plugin(LocalCredentialProvider, { path: file, watch: false })
    await ctx.plugin(LocalSandboxProvider)
    const policy = { mode: 'workspace-write' as const, workspaceRoot: root }
    const confined = await ctx.sandbox.confine(
      ['/bin/sh', '-c', 'mv "$1" "$2" && cat "$2"', 'rename-test', file, renamed], policy,
    )
    const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr.toLowerCase()).toContain('operation not permitted')
    expect(existsSync(renamed)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe(content)

    const publicFile = join(root, 'public.txt')
    const ordinary = await ctx.sandbox.confine(
      ['/bin/sh', '-c', 'printf public > "$1" && cat "$1"', 'write-test', publicFile], policy,
    )
    const written = spawnSync(ordinary.argv[0]!, ordinary.argv.slice(1), { encoding: 'utf8' })
    expect(written.error).toBeUndefined()
    expect(written.signal).toBeNull()
    expect(written.status).toBe(0)
    expect(written.stdout).toBe('public')
    expect(readFileSync(publicFile, 'utf8')).toBe('public')
  })

  it('denies the configured file and its path aliases while permitting an ordinary workspace file', async ({ onTestFinished }) => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-seatbelt-secret-'))
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
    const file = join(root, 'Secret.yaml')
    const publicFile = join(root, 'public.txt')
    writeFileSync(file, 'version: 1\nrefs:\n  DSH_READ_DENIAL_TEST: fixture-secret\n', { mode: 0o600 })
    writeFileSync(publicFile, 'public')
    const symbolic = join(root, 'alias')
    symlinkSync(file, symbolic)
    mkdirSync(join(root, 'child'))
    await ctx.plugin(LocalCredentialProvider, { path: file, watch: false })
    await ctx.plugin(LocalSandboxProvider)
    const aliases = [file, symbolic, root + '/child/../Secret.yaml']
    const caseAlias = realpathSync.native(file).toUpperCase()
    if (existsSync(caseAlias)) aliases.push(caseAlias)
    for (const alias of aliases) {
      const confined = await ctx.sandbox.confine(['/bin/cat', alias], { mode: 'workspace-write', workspaceRoot: root })
      const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr.toLowerCase()).toContain('operation not permitted')
    }
    const confined = await ctx.sandbox.confine(['/bin/cat', publicFile], { mode: 'workspace-write', workspaceRoot: root })
    const result = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('public')
  })
})
