import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDesktopBrand } from '../scripts/desktop-brand.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'
import { brandDesktopMessages, en, zh } from '../src/locale.ts'

const resource = (name: string): string => fileURLToPath(new URL(`../resources/${name}`, import.meta.url))
const unsignedEnvironment = (platform: 'darwin' | 'win32', brandDirectory?: string): NodeJS.ProcessEnv => ({
  DSH_DESKTOP_APP_ID: 'com.example.desk',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
  DSH_DESKTOP_MANDATORY_UPDATE_CONFIG: JSON.stringify({ allowedAuthOrigins: ['https://login.example.com'] }),
  DSH_DESKTOP_TARGET_PLATFORM: platform,
  DSH_DESKTOP_TARGET_ARCH: 'x64',
  DSH_DESKTOP_UNSIGNED: '1',
  ...brandDirectory === undefined ? {} : { DSH_DESKTOP_BRAND_DIR: brandDirectory },
})

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function brandDirectory(files: Readonly<Record<string, string>>): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-brand-'))
  directories.push(directory)
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(directory, name), contents)
  return directory
}

describe('desktop brand directory', () => {
  it('keeps the shipped brand without a brand directory', () => {
    const brand = resolveDesktopBrand({})
    expect(brand).toEqual({
      productName: 'DeepSeek Harness',
      appName: { en: 'DeepSeek Harness', zh: 'DeepSeek Harness' },
      locale: {},
      macOSIcon: resource('icon-macos.png'),
      windowsIcon: resource('icon-windows.png'),
      windowsTrayIcon: resource('tray-windows.ico'),
      welcomeBrand: undefined,
    })
    expect(brandDesktopMessages(brand)).toEqual({ en, zh })
    expect(en.aboutMenu).toBe('About DeepSeek Harness')
    expect(zh.quitApplication).toBe('退出 DeepSeek Harness')

    const mac = createElectronBuilderConfig(unsignedEnvironment('darwin'), 'darwin', 'x64')
    expect(mac.productName).toBe('DeepSeek Harness')
    expect(mac.mac.icon).toBe(resource('icon-macos.png'))
    expect(mac.mac.extendInfo.NSMicrophoneUsageDescription).toBe('DeepSeek Harness uses your microphone to transcribe speech into message drafts.')
    expect(mac.files.some(entry => typeof entry === 'string' && entry.includes('welcome-brand.svg'))).toBe(false)
    const windows = createElectronBuilderConfig(unsignedEnvironment('win32'), 'win32', 'x64')
    expect(windows.win.icon).toBe(resource('icon-windows.png'))
    expect(windows.extraResources.slice(1)).toEqual([
      { from: resource('icon-windows.png'), to: 'icon.png' },
      { from: resource('tray-windows.ico'), to: 'tray.ico' },
    ])
  })

  it('packages the product name, icons, welcome logo, and copy from a brand directory', () => {
    const root = brandDirectory({
      'brand.json': JSON.stringify({ productName: 'Acme Desk', appName: { zh: 'Acme 桌面', en: 'Acme Desk' } }),
      'icon-macos.png': 'mac',
      'icon-windows.png': 'windows',
      'tray-windows.ico': 'tray',
      'welcome-brand.svg': '<svg/>',
      'locale.json': JSON.stringify({ en: { welcomeDescription: 'Work with {appName}.' }, zh: { welcomeTitle: '欢迎' } }),
    })
    const brand = resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: root })
    expect(brand.welcomeBrand).toBe(join(root, 'welcome-brand.svg'))

    const messages = brandDesktopMessages(brand)
    expect(messages.en.aboutMenu).toBe('About Acme Desk')
    expect(messages.en.quitTitle).toBe('Quit Acme Desk?')
    expect(messages.en.welcomeDescription).toBe('Work with Acme Desk.')
    expect(messages.en.welcomeTitle).toBe('Acme Desk')
    expect(messages.zh.aboutMenu).toBe('关于 Acme 桌面')
    expect(messages.zh.startupFailed).toBe('Acme 桌面 无法使用')
    expect(messages.zh.welcomeTitle).toBe('欢迎')
    expect(messages.zh.welcomeDescription).toBe(zh.welcomeDescription)
    expect(messages.zh.aboutVersion).toBe(zh.aboutVersion)

    const mac = createElectronBuilderConfig(unsignedEnvironment('darwin', root), 'darwin', 'x64')
    expect(mac.productName).toBe('Acme Desk')
    expect(mac.mac.icon).toBe(join(root, 'icon-macos.png'))
    expect(mac.mac.extendInfo.NSMicrophoneUsageDescription).toBe('Acme Desk uses your microphone to transcribe speech into message drafts.')
    expect(mac.files.slice(-2)).toEqual([
      '!renderer/assets/welcome-brand.svg',
      { from: root, to: 'renderer/assets', filter: ['welcome-brand.svg'] },
    ])
    const windows = createElectronBuilderConfig(unsignedEnvironment('win32', root), 'win32', 'x64')
    expect(windows.win.icon).toBe(join(root, 'icon-windows.png'))
    expect(windows.extraResources.slice(1)).toEqual([
      { from: join(root, 'icon-windows.png'), to: 'icon.png' },
      { from: join(root, 'tray-windows.ico'), to: 'tray.ico' },
    ])
  })

  it('falls back per entry and names the product in copy when appName is absent', () => {
    const root = brandDirectory({ 'brand.json': JSON.stringify({ productName: 'Acme Desk' }) })
    const brand = resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: root })
    expect(brand).toMatchObject({ appName: { en: 'Acme Desk', zh: 'Acme Desk' }, macOSIcon: resource('icon-macos.png'), welcomeBrand: undefined })
    expect(resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: brandDirectory({}) })).toEqual(resolveDesktopBrand({}))
  })

  it('rejects unknown locale keys and invalid brand directories', () => {
    const unknown = resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: brandDirectory({ 'locale.json': JSON.stringify({ en: { welcomeHeadline: 'Hi' } }) }) })
    expect(() => brandDesktopMessages(unknown)).toThrow('unknown keys welcomeHeadline')
    expect(() => resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: brandDirectory({ 'locale.json': JSON.stringify({ fr: {} }) }) }))
      .toThrow('locale.json fr')
    expect(() => resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: brandDirectory({ 'brand.json': JSON.stringify({ productName: 'Acme/Desk' }) }) }))
      .toThrow('productName')
    expect(() => resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: 'relative/brand' })).toThrow('DSH_DESKTOP_BRAND_DIR')
    const missing = join(brandDirectory({}), 'missing')
    expect(() => resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: missing })).toThrow('DSH_DESKTOP_BRAND_DIR')
    mkdirSync(missing)
    expect(resolveDesktopBrand({ DSH_DESKTOP_BRAND_DIR: missing }).productName).toBe('DeepSeek Harness')
  })
})
