/** Resolve the Desktop brand that packaging and bundling fix into one build. */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BRAND_DIR_ENV = 'DSH_DESKTOP_BRAND_DIR'
const DEFAULT_PRODUCT_NAME = 'DeepSeek Harness'
const LANGUAGES = ['en', 'zh']

/**
 * Read the brand directory named by `DSH_DESKTOP_BRAND_DIR`; each absent entry keeps the shipped brand.
 * @param {NodeJS.ProcessEnv} env - Build or packaging environment.
 * @returns {import('./desktop-brand.d.mts').DesktopBrand} Product name, copy overrides, and packaged image paths.
 */
export function resolveDesktopBrand(env = process.env) {
  const directory = env[BRAND_DIR_ENV]
  if (directory !== undefined && (!isAbsolute(directory) || !statSync(directory, { throwIfNoEntry: false })?.isDirectory())) {
    throw new Error(`desktop brand: ${BRAND_DIR_ENV} must be an absolute directory path`)
  }
  const branded = name => directory !== undefined && existsSync(join(directory, name)) ? join(directory, name) : undefined
  const resource = name => branded(name) ?? fileURLToPath(new URL(`../resources/${name}`, import.meta.url))
  const json = name => {
    const path = branded(name)
    if (path === undefined) return {}
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    }
    catch (error) {
      throw new Error(`desktop brand: cannot parse ${path}`, { cause: error })
    }
  }
  const brand = json('brand.json')
  const productName = brand.productName ?? DEFAULT_PRODUCT_NAME
  // The product name becomes the application bundle and executable file name.
  if (typeof productName !== 'string' || !/^[^\\/:*?"<>|]+$/u.test(productName.trim())) {
    throw new Error('desktop brand: brand.json productName must be a non-empty file name')
  }
  const appName = Object.fromEntries(LANGUAGES.map(language => [language, brand.appName?.[language] ?? productName]))
  if (Object.values(appName).some(name => typeof name !== 'string' || name === '')) {
    throw new Error('desktop brand: brand.json appName.en and appName.zh must be non-empty strings')
  }
  const locale = json('locale.json')
  for (const [language, messages] of Object.entries(locale)) {
    if (!LANGUAGES.includes(language) || typeof messages !== 'object' || messages === null
      || Object.values(messages).some(message => typeof message !== 'string')) {
      throw new Error(`desktop brand: locale.json ${language} must be en or zh and map keys to strings`)
    }
  }
  return {
    productName,
    appName,
    locale,
    macOSIcon: resource('icon-macos.png'),
    windowsIcon: resource('icon-windows.png'),
    windowsTrayIcon: resource('tray-windows.ico'),
    welcomeBrand: branded('welcome-brand.svg'),
  }
}
