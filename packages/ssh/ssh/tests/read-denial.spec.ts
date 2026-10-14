/** Host-only exclusions stay local while the real SSH helper validates and executes remote policies. */
import { Context } from '@deepseek-ai/cordis'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { SshSandboxProvider } from '@deepseek-ai/dsh-sandbox-ssh'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createHelperHarness } from './fixtures/helper.ts'

describe.skipIf(process.platform === 'win32')('SSH policies with host-only read exclusions', () => {
  it('executes confined commands and full-access mutations through the strict helper protocol', async ({ onTestFinished }) => {
    const helper = await createHelperHarness()
    onTestFinished(helper.close)
    const ctx = new Context()
    onTestFinished(async () => { await ctx.fiber.dispose() })
    ctx.provide('ssh', helper.connection)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicyService, {
      mode: 'workspace-write', workspaceRoot: helper.root, deniedReadPaths: [join(helper.root, 'host-secret.yaml')],
    })
    await ctx.plugin(SshSandboxProvider)
    await ctx.plugin(SshFileSystem)
    // Kernel confinement is covered by backend tests; this fixture isolates policy transport and real helper execution.
    const confine = vi.spyOn(LocalSandboxProvider.prototype, 'confine').mockImplementation(async argv => ({
      argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [],
    }))
    onTestFinished(() => { confine.mockRestore() })
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const policy = { ...ctx.sandboxPolicy.resolve({ mode }), mode }
      expect(policy.deniedReadPaths).toHaveLength(1)
      const command = await ctx.sandbox.confine([process.execPath, '-e', 'process.stdout.write("command-ok")'], policy)
      const result = spawnSync(command.argv[0]!, command.argv.slice(1), { cwd: helper.root, encoding: 'utf8' })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe('command-ok')
      const target = await ctx.fs.resolve(`${mode}.txt`)
      const written = await ctx.fs.writeText(target, 'command-ok', undefined, undefined,
        ctx.sandboxPolicy.resolve({ mode: 'danger-full-access' }))
      expect(written.after).toBe('command-ok')
      expect(await readFile(join(helper.root, `${mode}.txt`), 'utf8')).toBe('command-ok')
      expect(command.argv).toEqual([process.execPath, '-e', 'process.stdout.write("command-ok")'])
      expect(confine).toHaveBeenLastCalledWith(command.argv, { mode, workspaceRoot: helper.root }, expect.any(AbortSignal))
    }
    const target = await ctx.fs.resolve('workspace-write.txt')
    expect((await ctx.fs.editText(target, { oldString: 'command', newString: 'edit', replaceAll: false }, undefined, undefined,
      ctx.sandboxPolicy.resolve({ mode: 'danger-full-access' }))).after).toBe('edit-ok')
    expect(await readFile(join(helper.root, 'workspace-write.txt'), 'utf8')).toBe('edit-ok')
    await expect(ctx.fs.writeText(target, 'denied', undefined, undefined,
      ctx.sandboxPolicy.resolve({ mode: 'read-only' }))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})
