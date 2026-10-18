// @vitest-environment jsdom
/** Account providers without wallets do not display stale bonus notices. */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { AccountMenu } from '../src/client/AccountMenu.tsx'
import type { AccountSectionInjected, AccountSnapshot } from '../src/client/AccountSection.tsx'
import type { BonusNotice } from '../src/client/bonus-notices.ts'
import type {} from '../src/client/index.ts'
import { en, type AccountKey } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('hides a retained bonus notice when the account has no wallet', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const account: AccountSnapshot = {
    view: {
      status: 'credential-stored', attempt: null, capabilities: { wallet: false },
      links: { usageUrl: '', topUpUrl: '' },
    },
    details: { profile: { status: 'ready', value: { id: null, name: 'Account User', contact: null } } },
    failed: false,
    notice: { orderId: 'stale-bonus' as BonusNotice['orderId'], message: 'Awarded 5.00', expiresAt: '2099-01-01T00:00:00Z' },
  }
  const theme: ThemeSnapshot = {
    preference: 'light', fontSize: 14, active: { id: 'light', colorScheme: 'light', tokens: {} }, themes: [], revision: 0,
  }
  const operations: AccountSectionInjected = {
    hooks: {
      account: { getSnapshot: () => account, subscribe: () => () => {} },
      theme: { getSnapshot: () => theme, subscribe: () => () => {} },
    },
    refreshAccount: vi.fn(async () => {}),
    contactUs: vi.fn(), showLogin: vi.fn(), setOnboarding: vi.fn(),
    bonusNoticeShown: vi.fn(), bonusNoticeDismissed: vi.fn(),
    hasRunningAccountTasks: vi.fn(async () => false),
    start: vi.fn(async () => {}), cancel: vi.fn(async () => {}), signOut: vi.fn(async () => {}),
  }
  render(<AccountMenu {...({} as GlobalStandardProps)} {...operations} wide settingsOpen={false}
    useAccount={selector => selector(account)} useTheme={selector => selector(theme)}
    openOnboarding={() => {}} openSettings={() => {}} t={key => en[key as AccountKey]} />)
  expect(screen.getByRole('button', { name: en.menu }).textContent).toBe('Account User')
  expect(screen.queryByText(en.bonusNoticeTitle)).toBeNull()
  expect(screen.queryByText('Awarded 5.00')).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
  expect(operations.bonusNoticeShown).not.toHaveBeenCalled()
  expect(operations.bonusNoticeDismissed).not.toHaveBeenCalled()
})
