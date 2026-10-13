import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'

const probe = spawnSync('sandbox-exec', ['-p', '(version 1) (allow default)', 'true'], { encoding: 'utf8' })

describe.skipIf(process.platform !== 'darwin' || probe.status !== 0)('real Seatbelt protected credential reads', () => {
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
