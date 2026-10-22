/** Brand fixed into one Desktop build; every field holds the shipped value when the brand directory omits it. */
export interface DesktopBrand {
  /** Installer, application bundle, and executable name. */
  readonly productName: string
  /** Product name substituted for `{appName}` in each Desktop dictionary. */
  readonly appName: { readonly en: string, readonly zh: string }
  /** Replacement copy keyed by Desktop dictionary key; `locale.ts` rejects unknown keys. */
  readonly locale: { readonly en?: Readonly<Record<string, string>>, readonly zh?: Readonly<Record<string, string>> }
  readonly macOSIcon: string
  readonly windowsIcon: string
  readonly windowsTrayIcon: string
  /** Replacement welcome-window logo; undefined keeps `renderer/assets/welcome-brand.svg`. */
  readonly welcomeBrand: string | undefined
}

/**
 * Read the brand directory named by `DSH_DESKTOP_BRAND_DIR`; each absent entry keeps the shipped brand.
 * @param env - Build or packaging environment.
 * @returns Product name, copy overrides, and packaged image paths.
 */
export function resolveDesktopBrand(env?: NodeJS.ProcessEnv): DesktopBrand
