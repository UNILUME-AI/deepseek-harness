/** Provider authentication requirements take precedence over configured API keys. */
import { describe, expect, it, vi } from 'vitest'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { needsWelcome } from '../src/welcome-api.ts'
import { connectDesktopWelcome } from '../src/welcome-backend.ts'

describe('desktop welcome authentication requirements', () => {
  it.each([false, true])('requires sign-in with accountRequired and hasApiKey=%s', (hasApiKey) => {
    expect(needsWelcome({ loggedIn: false, hasApiKey, accountRequired: true })).toBe(true)
    expect(needsWelcome({ loggedIn: true, hasApiKey, accountRequired: true })).toBe(false)
  })

  it.each([
    { loggedIn: false, hasApiKey: false, welcome: true },
    { loggedIn: false, hasApiKey: true, welcome: false },
    { loggedIn: true, hasApiKey: false, welcome: false },
    { loggedIn: true, hasApiKey: true, welcome: false },
  ])('preserves optional-account behavior for %j', ({ loggedIn, hasApiKey, welcome }) => {
    expect(needsWelcome({ loggedIn, hasApiKey })).toBe(welcome)
    expect(needsWelcome({ loggedIn, hasApiKey, accountRequired: false })).toBe(welcome)
  })
})

describe('desktop welcome account policy projection', () => {
  it.each([undefined, {}, { wallet: false }, { accountRequired: false }, { accountRequired: true }])(
    'reads the requirement from the same account snapshot as sign-in state: %j', async (capabilities) => {
      const send: Parameters<typeof connectDesktopWelcome>[1] = async (_input, init) => {
        if (init?.method !== 'POST') return new Response('index')
        const { rpcId, method } = JSON.parse(init.body as string) as { rpcId: string; method: string }
        const value: unknown = method === 'settings/describe'
          ? { namespaces: [
            { ns: 'llm-deepseek', value: { apiKeyEnv: 'EXAMPLE_API_KEY' } },
            { ns: 'locale', value: {} },
          ] }
          : method === 'llm/listConfigurableProviders' ? []
            : { EXAMPLE_API_KEY: { configured: true, writable: true } }
        return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } })
      }
      const backend = await connectDesktopWelcome('http://127.0.0.1:19387/?token=fixture', send)
      const snapshot: AccountView = {
        status: 'signed-out', attempt: null,
        links: { usageUrl: 'http://localhost/usage', topUpUrl: 'http://localhost/top_up' },
        ...(capabilities === undefined ? {} : { capabilities }),
      }
      const state = vi.spyOn(backend.account, 'state').mockResolvedValue(snapshot)
      const value = await backend.read()
      expect(state).toHaveBeenCalledOnce()
      expect(value.loggedIn).toBe(false)
      expect(value.hasApiKey).toBe(true)
      expect(value.accountRequired ?? false).toBe(capabilities?.accountRequired ?? false)
      expect(needsWelcome(value)).toBe(capabilities?.accountRequired ?? false)
      state.mockResolvedValue({ ...snapshot, status: 'credential-stored' })
      const signedIn = await backend.read()
      expect(signedIn.loggedIn).toBe(true)
      expect(needsWelcome(signedIn)).toBe(false)
    },
  )
})
