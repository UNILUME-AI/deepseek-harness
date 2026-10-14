/** Path anchoring keeps the components the operating system resolves through directory symlinks. */
import { posix, sep, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import { absoluteSearchPath } from '../src/paths.ts'

describe('search path anchoring', () => {
  it('uses the host dialect by default without normalizing parent components', () => {
    expect(absoluteSearchPath(`alias${sep}..${sep}Secret.yaml`, process.cwd()))
      .toBe(`${process.cwd()}${sep}alias${sep}..${sep}Secret.yaml`)
  })

  it.each([
    ['relative', 'alias/../Secret.yaml', '/workspace/alias/../Secret.yaml'],
    ['absolute', '/protected/alias/../Secret.yaml', '/protected/alias/../Secret.yaml'],
  ])('preserves POSIX %s components', (_kind, path, expected) => {
    expect(absoluteSearchPath(path, '/workspace', posix)).toBe(expected)
  })

  it.each([
    ['relative', String.raw`alias\..\Secret.yaml`, String.raw`C:\workspace\alias\..\Secret.yaml`],
    ['absolute', String.raw`D:\alias\..\Secret.yaml`, String.raw`D:\alias\..\Secret.yaml`],
    ['drive-rooted backslash', String.raw`\Secret.yaml`, String.raw`C:\Secret.yaml`],
    ['drive-rooted slash', '/Secret.yaml', 'C:/Secret.yaml'],
    ['same-drive relative', String.raw`c:alias\..\Secret.yaml`, String.raw`C:\workspace\alias\..\Secret.yaml`],
    ['UNC', String.raw`\\server\share\alias\..\Secret.yaml`, String.raw`\\server\share\alias\..\Secret.yaml`],
  ])('anchors Windows %s filenames in the execution drive', (_kind, path, expected) => {
    expect(absoluteSearchPath(path, String.raw`C:\workspace`, win32)).toBe(expected)
  })

  it('uses the inherited cwd of another Windows drive without collapsing the filename suffix', () => {
    const dialect = { ...win32, resolve: (...paths: string[]) => win32.resolve(String.raw`D:\inherited`, ...paths) }
    expect(absoluteSearchPath(String.raw`D:alias\..\Secret.yaml`, String.raw`C:\workspace`, dialect))
      .toBe(String.raw`D:\inherited\alias\..\Secret.yaml`)
  })

  it('retains a namespaced working directory for a same-drive filename', () => {
    expect(absoluteSearchPath(String.raw`C:alias\..\Secret.yaml`, String.raw`\\?\C:\workspace`, win32))
      .toBe(String.raw`\\?\C:\workspace\alias\..\Secret.yaml`)
  })
})
