import { Context } from '@deepseek-ai/cordis'
import * as nodeFs from 'node:fs'
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, statSync: vi.fn(actual.statSync) }
})

import { deniedReadPaths, isReadDenied } from '@deepseek-ai/dsh-sandbox'

function fixture(onTestFinished: (cleanup: () => void) => void) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-read-denial-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const file = join(root, 'Secret.yaml')
  writeFileSync(file, 'test secret', { mode: 0o600 })
  return { root, file, canonical: realpathSync.native(file), policy: { mode: 'read-only' as const, workspaceRoot: root } }
}

describe('shared read exclusions', () => {
  it('merges provider files and additions, deduplicates, and bypasses full access', ({ onTestFinished }) => {
    const { file, canonical, policy } = fixture(onTestFinished)
    const ctx = new Context()
    ctx.provide('credentials', { agentDeniedReadPaths: [file] })
    expect(deniedReadPaths(ctx, { ...policy, deniedReadPaths: [file] })).toEqual([canonical])
    expect(deniedReadPaths(ctx, { ...policy, mode: 'danger-full-access' })).toEqual([])
    expect(deniedReadPaths(new Context(), policy)).toEqual([])
    expect(isReadDenied(file, [])).toBe(false)
  })

  it('resolves missing leaves and treats absent files as path exclusions', ({ onTestFinished }) => {
    const { root, file, policy } = fixture(onTestFinished)
    const absent = join(root, 'missing', 'secret.yaml')
    const denied = deniedReadPaths(new Context(), { ...policy, deniedReadPaths: [absent] })
    expect(denied).toEqual([join(realpathSync.native(root), 'missing', 'secret.yaml')])
    expect(isReadDenied(absent, denied)).toBe(true)
    expect(isReadDenied(file, denied)).toBe(false)
    expect(isReadDenied(join(root, 'other-absent'), denied)).toBe(false)
    expect(deniedReadPaths(new Context(), { ...policy, deniedReadPaths: [join(file, 'not-a-directory')] })).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('blocks symbolic links, hard links and parent traversal by filesystem identity', ({ onTestFinished }) => {
    const { root, file, canonical } = fixture(onTestFinished)
    const symbolic = join(root, 'symbolic')
    const hard = join(root, 'hard')
    symlinkSync(file, symbolic)
    linkSync(file, hard)
    mkdirSync(join(root, 'child'))
    for (const alias of [symbolic, hard, join(root, 'child') + '/../Secret.yaml']) {
      expect(isReadDenied(alias, [canonical])).toBe(true)
    }
    const other = join(root, 'other')
    writeFileSync(other, 'public')
    expect(isReadDenied(other, [canonical])).toBe(false)
  })

  it('fails closed on canonicalization and identity I/O errors', ({ onTestFinished }) => {
    const { file, canonical, policy } = fixture(onTestFinished)
    const denied = { ...policy, deniedReadPaths: [file] }
    const error = Object.assign(new Error('access denied'), { code: 'EACCES' })
    const canonicalize = vi.spyOn(realpathSync, 'native').mockImplementationOnce(() => { throw error })
    try {
      expect(() => deniedReadPaths(new Context(), denied)).toThrow(error)
      canonicalize.mockImplementationOnce(() => { throw Object.assign(new Error('absent root'), { code: 'ENOENT' }) })
      expect(() => deniedReadPaths(new Context(), { ...policy, deniedReadPaths: [parse(file).root] })).toThrow('absent root')
    } finally {
      canonicalize.mockRestore()
    }
    // A missing target has no identity; errors looking up an existing denied inode must still propagate.
    expect(isReadDenied(file, [canonical])).toBe(true)
  })

  it('propagates identity errors and distinguishes absent identity from ENOTDIR', ({ onTestFinished }) => {
    const { file, canonical } = fixture(onTestFinished)
    const stat = vi.mocked(nodeFs.statSync)
    const original = stat.getMockImplementation()!
    try {
      const error = Object.assign(new Error('identity I/O failed'), { code: 'EIO' })
      stat.mockImplementationOnce(() => { throw error })
      expect(() => isReadDenied(file, [canonical])).toThrow(error)
      stat.mockImplementationOnce(() => { throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' }) })
      expect(isReadDenied(file, [canonical])).toBe(true)
    } finally {
      stat.mockReset()
      stat.mockImplementation(original)
    }
  })

  it('uses case-sensitive matching on Linux and case-insensitive matching on Windows', ({ onTestFinished }) => {
    const { file, canonical } = fixture(onTestFinished)
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    try {
      for (const platform of ['linux', 'win32']) {
        Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
        expect(isReadDenied(file, [canonical])).toBe(true)
      }
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('blocks case aliases on case-insensitive hosts', ({ onTestFinished }) => {
    const { file, canonical } = fixture(onTestFinished)
    expect(isReadDenied(file.toUpperCase(), [canonical])).toBe(true)
  })
})
