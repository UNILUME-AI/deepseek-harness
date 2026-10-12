/**
 * Named registrations for the browser-use capability; distinct names coexist.
 * @module @deepseek-ai/dsh-browser-use
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { BrowserUseProviderName } from './brand.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browserUse: BrowserUseRegistry
  }
}

/** Owns the provider registrations in the shared browser-use service. */
export class BrowserUseRegistry extends Service {
  private readonly registrations = new Set<BrowserUseProviderName>()

  constructor(ctx: Context) {
    super(ctx, 'browserUse')
  }

  /** Names of the registered providers in registration order, including providers whose resources are closing. */
  get providerNames(): readonly BrowserUseProviderName[] {
    return [...this.registrations]
  }

  /**
   * Reserve one provider name until the contribution is disposed.
   * Providers with distinct names coexist; repeating a registered name fails because the name
   * is also the provider's tool namespace. Providers must stop their tools and await owned work
   * before releasing this registration.
   * @param name - provider-owned name used in registration diagnostics.
   * @returns the effect disposer for this exact registration.
   */
  register(name: BrowserUseProviderName): () => Promise<void> {
    if (this.registrations.has(name)) {
      throw new Error(`browser use provider "${name}" is already registered`)
    }
    return this.ctx.effect(() => {
      this.registrations.add(name)
      return () => {
        this.registrations.delete(name)
      }
    }, 'browserUse.register()')
  }
}

export default BrowserUseRegistry
