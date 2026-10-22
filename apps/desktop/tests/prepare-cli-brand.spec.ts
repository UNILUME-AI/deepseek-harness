/** Packaged terminal commands follow the build's product name on both platforms. */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { prepareDesktopCli } from '../scripts/prepare-cli.ts'

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-cli-brand-'))
  onTestFinished(() => rmSync(root, { recursive: true, force: true }))
  return root
}

it.each(['darwin', 'win32'] as const)('keeps the unbranded %s launcher byte for byte', (platform) => {
  const root = directory()
  const name = platform === 'darwin' ? 'dsh' : 'dsh.cmd'
  prepareDesktopCli(root, platform, {})
  const command = join(root, 'bin', name)
  expect(readFileSync(command)).toEqual(readFileSync(new URL(`../cli/${name}`, import.meta.url)))
  if (platform === 'darwin' && process.platform !== 'win32') expect(statSync(command).mode & 0o777).toBe(0o755)
})

it.each(['darwin', 'win32'] as const)('targets the branded executable in the %s launcher', (platform) => {
  const root = directory()
  writeFileSync(join(root, 'brand.json'), JSON.stringify({ productName: 'Acme Desk' }))
  prepareDesktopCli(root, platform, { DSH_DESKTOP_BRAND_DIR: root })
  const name = platform === 'darwin' ? 'dsh' : 'dsh.cmd'
  const command = readFileSync(join(root, 'bin', name), 'utf8')
  expect(command).toContain(platform === 'darwin' ? '"$resources/../MacOS/Acme Desk"' : '"%~dp0..\\..\\..\\..\\Acme Desk.exe"')
  expect(command).not.toContain('DeepSeek Harness')
})

it.each(['darwin', 'win32'] as const)('escapes product-name expansion characters in the %s launcher', (platform) => {
  const root = directory()
  writeFileSync(join(root, 'brand.json'), JSON.stringify({ productName: 'Acme $Desk `Demo` %PATH%' }))
  prepareDesktopCli(root, platform, { DSH_DESKTOP_BRAND_DIR: root })
  const name = platform === 'darwin' ? 'dsh' : 'dsh.cmd'
  const command = readFileSync(join(root, 'bin', name), 'utf8')
  expect(command).toContain(platform === 'darwin' ? 'Acme \\$Desk \\`Demo\\` %PATH%' : 'Acme $Desk `Demo` %%PATH%%.exe')
})
