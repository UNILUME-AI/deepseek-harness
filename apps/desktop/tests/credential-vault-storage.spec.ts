import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { openSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CredentialVault } from '../src/credential-vault.ts'

const electronMock = vi.hoisted(() => ({ safeStorage: {
  isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: vi.fn(() => 'keychain'),
  encryptString: vi.fn((value: string) => Buffer.from(value)), decryptString: vi.fn((value: Buffer) => value.toString()),
} }))
vi.mock('electron', () => electronMock)
const { safeStorage } = electronMock
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, openSync: vi.fn(fs.openSync), renameSync: vi.fn(fs.renameSync) }
})
let directory: string
let path: string
beforeEach(async () => { vi.clearAllMocks(); directory = await mkdtemp(join(tmpdir(), 'keychain-storage-')); path = join(directory, 'credential-vault.json') })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('credential vault persistence', () => {
  it('creates the temporary file as 0600, renames in the same directory and lists without decrypting', async () => {
    const vault = new CredentialVault(directory)
    const id = await vault.add('https://EXAMPLE.com:443/path', 'Seller', 'alice', 'test-password', 'JBSWY3DPEHPK3PXP')
    expect(openSync).toHaveBeenCalledWith(expect.stringMatching(/credential-vault\.json\..+\.tmp$/), 'wx', 0o600)
    expect(renameSync).toHaveBeenCalledWith(expect.stringContaining(directory), path)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['credential-vault.json'])
    expect(await readFile(path, 'utf8')).not.toContain('test-password')
    const reloaded = new CredentialVault(directory); await reloaded.load()
    expect(reloaded.list()).toEqual([{ id, origin: 'https://example.com', label: 'Seller', username: 'alice', hasTotp: true }])
    expect(safeStorage.decryptString).not.toHaveBeenCalled()
  })

  it.each(['{ broken-json', '{}', '[{}]', '[{"password":"sensitive-file-content"}]'])
  ('refuses corrupt data and preserves its exact bytes on later mutations: %s', async (data) => {
    await writeFile(path, data)
    const vault = new CredentialVault(directory)
    await expect(vault.load()).rejects.toThrow('Invalid credential vault')
    await expect(vault.add('https://example.com', 'Seller', 'alice', 'pw')).rejects.toThrow('Invalid credential vault')
    await expect(vault.remove('unused')).rejects.toThrow('Invalid credential vault')
    expect(await readFile(path, 'utf8')).toBe(data)
    expect(renameSync).not.toHaveBeenCalled()
  })

  it('preserves disk and memory after a failed atomic replacement and cleans its temporary file', async () => {
    const vault = new CredentialVault(directory)
    await vault.add('https://example.com', 'Original', 'alice', 'pw')
    const original = await readFile(path, 'utf8')
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('disk write failure') })
    await expect(vault.add('https://example.com', 'Rejected', 'bob', 'pw')).rejects.toThrow('disk write failure')
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(vault.list().map(item => item.label)).toEqual(['Original'])
    expect(await readdir(directory)).toEqual(['credential-vault.json'])
  })

  it('serializes concurrent additions without dropping either entry', async () => {
    const vault = new CredentialVault(directory)
    await Promise.all(['First', 'Second'].map(label => vault.add('https://example.com', label, 'alice', 'pw')))
    const reloaded = new CredentialVault(directory); await reloaded.load()
    expect(reloaded.list().map(item => item.label)).toEqual(['First', 'Second'])
  })

  it('rejects an unavailable keyring or Linux basic_text backend without creating a file', async () => {
    const vault = new CredentialVault(directory)
    vi.mocked(safeStorage.isEncryptionAvailable).mockReturnValueOnce(false)
    await expect(vault.add('https://example.com', 'Site', 'u', 'pw')).rejects.toThrow('not available')
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.mocked(safeStorage.getSelectedStorageBackend).mockReturnValueOnce('basic_text')
    await expect(vault.add('https://example.com', 'Site', 'u', 'pw')).rejects.toThrow('not available')
    platform.mockRestore()
    expect(await readdir(directory)).toEqual([])
  })
})


it('reloads passwords at the input limit even when JSON expands every character', async () => {
  const vault = new CredentialVault(directory)
  const id = await vault.add('https://example.com', 'Site', 'alice', '\u0000'.repeat(16384))
  const reloaded = new CredentialVault(directory)
  await reloaded.load()
  expect((await reloaded.getSecrets(id))?.password.length).toBe(16384)
})
