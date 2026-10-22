/** Package terminal launch scripts that reuse the installed Electron runtime. */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDesktopBrand } from './desktop-brand.mjs'

/**
 * Generate the platform launcher for the packaged product's executable name.
 * @param destination - Physical runtime/cli directory prepared for the application.
 * @param platform - Target Desktop operating system.
 * @param env - Packaging environment containing the optional brand directory.
 */
export function prepareDesktopCli(destination: string, platform: 'darwin' | 'win32', env: NodeJS.ProcessEnv = process.env): void {
  const { productName } = resolveDesktopBrand(env)
  const executableName = platform === 'win32'
    ? productName.replaceAll('%', '%%')
    : productName.replace(/[$`]/gu, character => `\\${character}`)
  const name = platform === 'win32' ? 'dsh.cmd' : 'dsh'
  const command = join(destination, 'bin', name)
  const template = readFileSync(join(import.meta.dirname, '..', 'cli', name), 'utf8')
  mkdirSync(join(destination, 'bin'), { recursive: true })
  writeFileSync(command, template.replaceAll('DeepSeek Harness', () => executableName))
  if (platform === 'darwin') chmodSync(command, 0o755)
}
