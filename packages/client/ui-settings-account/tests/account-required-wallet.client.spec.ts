// @vitest-environment jsdom
/** Sign-in policy leaves independently declared wallet support at its documented default. */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { AccountDetails, AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountSectionInjected } from '../src/client/AccountSection.tsx'

const it = createClientTest({ roster: webApp })
const signedIn: AccountView = {
  status: 'credential-stored', attempt: null, capabilities: { accountRequired: true },
  links: { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top_up' },
}
const profile: AccountDetails['profile'] = {
  status: 'ready', value: { id: null, name: 'Account User', contact: 'u***@example.com' },
}
const balance: AccountDetails['balance'] = {
  status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [],
}

beforeEach(() => { vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('reads wallet data when the provider declares only a sign-in requirement', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  const actions = injected as AccountSectionInjected
  c.mock.unary('account/getProfile', ok(profile))
  c.mock.unary('account/getBalance', ok(balance))
  c.mock.unary('account/getUnnotifiedBonuses', ok(null))

  c.mock.streams.push('account/watch', signedIn)
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().details?.balance).toEqual(balance)
    expect(c.mock.log.calls('account/getUnnotifiedBonuses')).toHaveLength(1)
  })
  await c.flush()
  expect(c.mock.log.calls('account/getBalance')).toHaveLength(1)
}, 60_000)

it('skips wallet data when a sign-in requirement also disables the wallet', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  const actions = injected as AccountSectionInjected
  c.mock.unary('account/getProfile', ok(profile))
  c.mock.unary('account/getBalance', ok(balance))
  c.mock.unary('account/getUnnotifiedBonuses', ok(null))

  c.mock.streams.push('account/watch', { ...signedIn, capabilities: { accountRequired: true, wallet: false } })
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile) })
  await c.flush()
  expect(actions.hooks.account.getSnapshot().details?.balance).toBeUndefined()
  expect(c.mock.log.calls('account/getBalance')).toHaveLength(0)
  expect(c.mock.log.calls('account/getUnnotifiedBonuses')).toHaveLength(0)
}, 60_000)
