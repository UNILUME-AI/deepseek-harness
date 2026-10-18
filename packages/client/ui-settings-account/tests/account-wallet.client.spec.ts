// @vitest-environment jsdom
/** Account provider capabilities govern wallet reads in the shipped client composition. */
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type {
  AccountBonusBatch, AccountBonusOrderId, AccountDetails, AccountUserId, AccountView,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountSectionInjected } from '../src/client/AccountSection.tsx'

const it = createClientTest({ roster: webApp })
const signedIn: AccountView = {
  status: 'credential-stored', attempt: null,
  links: { usageUrl: 'https://example.test/usage', topUpUrl: 'https://example.test/top_up' },
}
const profile: AccountDetails['profile'] = {
  status: 'ready', value: { id: null, name: 'Account User', contact: 'u***@example.com' },
}
const balance: AccountDetails['balance'] = {
  status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }],
  bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
}
const bonusBatch: AccountBonusBatch = {
  accountId: 'account-user' as AccountUserId,
  bonuses: [{
    orderId: '4c1b0000-0000-4000-8000-000000000001' as AccountBonusOrderId,
    campaign: 'account_bonus', amount: '5.00', currency: 'CNY',
    grantedAt: '2026-10-18T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', message: 'Account bonus available',
  }],
}

beforeEach(() => { vi.stubEnv('DSH_CLIENT_VERSION', '0.0.0-test') })
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks() })

it('reads profiles without balance or bonus requests when the provider has no wallet', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  const actions = injected as AccountSectionInjected
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', { ...signedIn, capabilities: { wallet: false } })
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile) })
  await c.flush()
  expect(c.mock.remote.account.getBalance).not.toHaveBeenCalled()
  expect(c.mock.remote.account.getUnnotifiedBonuses).not.toHaveBeenCalled()
  expect(actions.hooks.account.getSnapshot().details?.balance).toBeUndefined()
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()

  await actions.refreshAccount()
  expect(c.mock.remote.account.getProfile).toHaveBeenCalledTimes(2)
  expect(c.mock.remote.account.getBalance).not.toHaveBeenCalled()
  expect(c.mock.remote.account.getUnnotifiedBonuses).not.toHaveBeenCalled()
}, 60_000)

it('keeps balance and bonus requests enabled when capabilities are absent', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  const actions = injected as AccountSectionInjected
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', signedIn)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details?.balance).toEqual(balance) })
  await vi.waitFor(() => { expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledOnce() })
  await c.flush()
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledOnce()

  await actions.refreshAccount()
  expect(c.mock.remote.account.getProfile).toHaveBeenCalledTimes(2)
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(2)
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(2)
}, 60_000)

it('clears wallet state when support is removed and resumes wallet reads when support returns', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  const actions = injected as AccountSectionInjected
  const enabled: AccountView = { ...signedIn, capabilities: { wallet: true } }
  const disabled: AccountView = { ...signedIn, capabilities: { wallet: false } }
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(bonusBatch))
  c.mock.streams.push('account/watch', enabled)
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().details?.balance).toEqual(balance)
    expect(actions.hooks.account.getSnapshot().notice?.message).toBe('Account bonus available')
  })

  c.mock.streams.push('account/watch', disabled)
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().view).toEqual(disabled)
    expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile)
  })
  expect(actions.hooks.account.getSnapshot().details?.balance).toBeUndefined()
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
  await actions.refreshAccount()
  expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile)
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledOnce()
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledOnce()

  c.mock.streams.push('account/watch', enabled)
  await vi.waitFor(() => {
    expect(actions.hooks.account.getSnapshot().view).toEqual(enabled)
    expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile)
    expect(actions.hooks.account.getSnapshot().details?.balance).toEqual(balance)
    expect(actions.hooks.account.getSnapshot().notice?.message).toBe('Account bonus available')
  })
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(2)
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(2)
}, 60_000)

it('drops pending wallet and bonus results after wallet support is removed', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const injected: object = c.ctx.slots.entries('settings.launcher')[0]!.inject!()
  const actions = injected as AccountSectionInjected
  const disabled: AccountView = { ...signedIn, capabilities: { wallet: false } }
  c.mock.remote.account.getProfile.mockResolvedValue(ok(profile))
  c.mock.remote.account.getBalance.mockResolvedValue(ok(balance))
  c.mock.remote.account.getUnnotifiedBonuses.mockResolvedValue(ok(null))
  c.mock.streams.push('account/watch', signedIn)
  await vi.waitFor(() => { expect(actions.hooks.account.getSnapshot().details?.balance).toEqual(balance) })
  await c.flush()

  const pendingBalance = Promise.withResolvers<ReturnType<typeof ok<AccountDetails['balance'] | null>>>()
  const pendingBonus = Promise.withResolvers<ReturnType<typeof ok<AccountBonusBatch | null>>>()
  c.mock.remote.account.getBalance.mockReturnValueOnce(pendingBalance.promise)
  c.mock.remote.account.getUnnotifiedBonuses.mockReturnValueOnce(pendingBonus.promise)
  const refresh = actions.refreshAccount()
  try {
    await vi.waitFor(() => {
      expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(2)
      expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(2)
    })
    c.mock.streams.push('account/watch', disabled)
    await vi.waitFor(() => {
      expect(actions.hooks.account.getSnapshot().view).toEqual(disabled)
      expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile)
    })
  } finally {
    pendingBalance.resolve(ok(balance))
    pendingBonus.resolve(ok(bonusBatch))
    await refresh
  }
  await c.flush()
  expect(actions.hooks.account.getSnapshot().view).toEqual(disabled)
  expect(actions.hooks.account.getSnapshot().details?.profile).toEqual(profile)
  expect(actions.hooks.account.getSnapshot().details?.balance).toBeUndefined()
  expect(actions.hooks.account.getSnapshot().notice).toBeUndefined()
  expect(c.mock.remote.account.getBalance).toHaveBeenCalledTimes(2)
  expect(c.mock.remote.account.getUnnotifiedBonuses).toHaveBeenCalledTimes(2)
}, 60_000)
