import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, mkdir, writeFile, rm, symlink, link, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

async function fixture(mode: SandboxMode, onTestFinished: (cleanup: () => Promise<void>) => void) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-fs-read-denial-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const file = join(root, 'Secret.yaml')
  await writeFile(file, 'test secret', { mode: 0o600 })
  ctx.provide('credentials', { agentDeniedReadPaths: [file] })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
  await ctx.plugin(SandboxedFileSystem, { cwd: root })
  return { ctx, fs: ctx.fs, root, file }
}

describe('confined filesystem content reads', () => {
  it.each(['read-only', 'workspace-write'] as const)('denies all content APIs and preserves public reads in %s', async (mode) => {
    const { fs, root, file } = await fixture(mode, onTestFinished)
    const target = await fs.resolve(file)
    const operations = [
      () => fs.readText(target),
      () => fs.streamText(target),
      () => fs.readBytes(target, undefined, 100),
      () => fs.readByteRange(target, { offset: 0, length: 4 }),
    ]
    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    const publicFile = join(root, 'public.txt')
    await writeFile(publicFile, 'public')
    const publicTarget = await fs.resolve(publicFile)
    expect(await fs.readText(publicTarget)).toBe('public')
    const chunks: string[] = []
    for await (const chunk of await fs.streamText(publicTarget)) chunks.push(chunk)
    expect(chunks.join('')).toBe('public')
    expect(new TextDecoder().decode(await fs.readBytes(publicTarget, undefined, 100))).toBe('public')
    expect(new TextDecoder().decode(await fs.readByteRange(publicTarget, { offset: 0, length: 3 }))).toBe('pub')
  })

  it('leaves full-access content reads and mutations unchanged', async ({ onTestFinished }) => {
    const { fs, file } = await fixture('danger-full-access', onTestFinished)
    const target = await fs.resolve(file)
    expect(await fs.readText(target)).toBe('test secret')
    expect(await fs.streamText(target)).toBeDefined()
    expect(await fs.readBytes(target, undefined, 100)).toHaveLength(11)
    expect(await fs.readByteRange(target, { offset: 0, length: 4 })).toHaveLength(4)
    await fs.writeText(target, 'changed')
    expect(await fs.readText(target)).toBe('changed')
  })

  it.skipIf(process.platform === 'win32')('rejects symlinks, workspace hard links, parent traversal and a swapped symlink', async ({ onTestFinished }) => {
    const { fs, file, root } = await fixture('workspace-write', onTestFinished)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    const symbolic = join(workspace, 'symbolic')
    const hard = join(workspace, 'hard')
    await symlink(file, symbolic)
    await link(file, hard)
    for (const path of [symbolic, hard, workspace + '/../Secret.yaml']) {
      await expect(fs.readText(await fs.resolve(path))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    }
    const ordinary = join(workspace, 'ordinary')
    await writeFile(ordinary, 'public')
    const swapped = join(workspace, 'swapped')
    await symlink(ordinary, swapped)
    const stale = await fs.resolve(swapped)
    await unlink(swapped)
    await symlink(file, swapped)
    await expect(fs.readText(stale)).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.writeText(await fs.resolve(hard), 'overwrite')).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(fs.editText(await fs.resolve(file), { oldString: 'secret', newString: 'public', replaceAll: false })).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('rejects case aliases', async ({ onTestFinished }) => {
    const { fs, file } = await fixture('workspace-write', onTestFinished)
    await expect(fs.readText(await fs.resolve(file.toUpperCase()))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })

  it('uses the initiating session rather than the deployment mode', async ({ onTestFinished }) => {
    const { ctx, fs, file } = await fixture('danger-full-access', onTestFinished)
    const session = Session.create(SessionId('read-denial'))
    setSandboxMode(session, 'workspace-write')
    ctx.provide('agents', { currentInitiator: () => ({ session }) })
    await expect(fs.readText(await fs.resolve(file))).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
  })
})
