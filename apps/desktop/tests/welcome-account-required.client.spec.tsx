// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountView } from '@deepseek-ai/dsh-deepseek-account/types'
import { Welcome } from '../src/client/WelcomePage.tsx'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { WelcomeNotice, WelcomeSaveResult } from '../src/welcome-api.ts'

afterEach(cleanup)

function account(capabilities?: AccountView['capabilities'], attempt: AccountView['attempt'] = null): AccountView {
  return { status: 'signed-out', links: { usageUrl: '', topUpUrl: '' }, attempt,
    ...(capabilities === undefined ? {} : { capabilities }) }
}

function mount(initial: AccountView) {
  const api = {
    ...resolveDesktopLocale('en'),
    analyticsEnabled: async () => true,
    takeNotice: vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined),
    onAccountState: vi.fn((listener: (state: AccountView) => void) => { listener(initial); return () => {} }),
    startSignIn: vi.fn<() => Promise<AccountView>>().mockResolvedValue(initial),
    cancelSignIn: vi.fn<() => Promise<AccountView>>().mockResolvedValue(initial),
    copySignInLink: vi.fn(async () => undefined),
    saveApiKey: vi.fn<(value: string) => Promise<WelcomeSaveResult>>().mockResolvedValue({ ok: true }),
    skip: vi.fn(async () => {}),
  }
  render(<Welcome api={api} />)
  const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!
  const publish = (state: AccountView) => { act(() => { api.onAccountState.mock.calls[0]![0](state) }) }
  const keyForm = () => document.querySelector<HTMLFormElement>('#key-form')!
  return { api, button, publish, keyForm }
}

const required = { accountRequired: true } as const
const attemptId = 'attempt' as NonNullable<AccountView['attempt']>['id']

describe('desktop welcome required account', () => {
  it('offers only sign-in on the initial page', () => {
    const view = mount(account(required))
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([view.api.messages.welcomeSignIn])
    expect(view.button('api-key').hidden).toBe(true)
    expect(view.keyForm().hidden).toBe(true)
  })

  it.each(['failed', 'expired'] as const)('offers retry without an API-key alternative after %s sign-in', async (phase) => {
    const view = mount(account(required))
    view.publish(account(required, { id: attemptId, phase }))
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([view.api.messages.welcomeAuthRetry])
    expect(view.button('auth-api-key').hidden).toBe(true)
    await act(async () => { fireEvent.click(view.button('auth-retry')) })
    expect(view.api.startSignIn).toHaveBeenCalledOnce()
    expect(view.button('api-key').hidden).toBe(true)
  })

  it('refuses key-page navigation through hidden entry and failed-sign-in actions', () => {
    const view = mount(account(required))
    fireEvent.click(view.button('api-key'))
    expect(view.keyForm().hidden).toBe(true)
    expect(view.button('sign-in').closest('[hidden]')).toBeNull()
    view.publish(account(required, { id: attemptId, phase: 'failed' }))
    fireEvent.click(view.button('auth-api-key'))
    expect(view.keyForm().hidden).toBe(true)
    expect(view.button('auth-retry').closest('[hidden]')).toBeNull()
  })

  it('leaves an open key page and refuses an earlier action when the provider requires an account', () => {
    const view = mount(account())
    const keyButton = view.button('api-key')
    fireEvent.click(keyButton)
    expect(view.keyForm().hidden).toBe(false)
    act(() => {
      view.api.onAccountState.mock.calls[0]![0](account(required))
      fireEvent.click(keyButton)
    })
    expect(view.keyForm().hidden).toBe(true)
    expect(view.button('sign-in').closest('[hidden]')).toBeNull()
    expect(keyButton.hidden).toBe(true)
  })

  it('retains sign-in waiting, link copying, and cancellation', async () => {
    const view = mount(account(required))
    view.api.startSignIn.mockResolvedValue(account(required, {
      id: attemptId, phase: 'waiting-browser', authorizeUrl: 'https://example.test/login',
    }))
    await act(async () => { fireEvent.click(view.button('sign-in')) })
    expect(document.querySelector('#auth-status')!.textContent).toBe(view.api.messages.welcomeAuthWaiting)
    expect(view.button('auth-cancel').disabled).toBe(false)
    await act(async () => { fireEvent.click(view.button('auth-copy')) })
    expect(view.api.copySignInLink).toHaveBeenCalledExactlyOnceWith(attemptId)
    expect(view.button('auth-copy').textContent).toBe(view.api.messages.welcomeAuthCopied)
    await act(async () => { fireEvent.click(view.button('auth-cancel')) })
    expect(view.api.cancelSignIn).toHaveBeenCalledExactlyOnceWith(attemptId)
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([view.api.messages.welcomeSignIn])
  })

  it.each([undefined, { wallet: false }, { accountRequired: false }])('retains both authentication routes when the requirement is absent or false: %j', (capabilities) => {
    const view = mount(account(capabilities))
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      view.api.messages.welcomeSignIn, view.api.messages.welcomeApiKey,
    ])
    fireEvent.click(view.button('api-key'))
    expect(view.keyForm().hidden).toBe(false)
    fireEvent.click(view.button('back-to-login'))
    view.publish(account(capabilities, { id: attemptId, phase: 'failed' }))
    expect(view.button('auth-api-key').hidden).toBe(false)
    fireEvent.click(view.button('auth-api-key'))
    expect(view.keyForm().hidden).toBe(false)
  })
})

describe('desktop welcome before the first account snapshot', () => {
  function mountDelayed() {
    const first = Promise.withResolvers<AccountView>()
    const api = {
      ...resolveDesktopLocale('en'),
      analyticsEnabled: async () => true,
      takeNotice: vi.fn<() => Promise<WelcomeNotice | undefined>>().mockResolvedValue(undefined),
      onAccountState: vi.fn((_listener: (state: AccountView) => void) => () => {}),
      readAccountState: vi.fn(() => first.promise),
      startSignIn: vi.fn<() => Promise<AccountView>>().mockRejectedValue(new Error('offline')),
      cancelSignIn: vi.fn<() => Promise<AccountView>>(),
      copySignInLink: vi.fn(async () => undefined),
      saveApiKey: vi.fn<(value: string) => Promise<WelcomeSaveResult>>().mockResolvedValue({ ok: true }),
      skip: vi.fn(async () => {}),
    }
    render(<Welcome api={api} />)
    const button = (id: string) => document.querySelector<HTMLButtonElement>(`#${id}`)!
    const keyForm = () => document.querySelector<HTMLFormElement>('#key-form')!
    return { api, first, button, keyForm }
  }

  it('hides and refuses the API-key route until the delayed snapshot allows it', async () => {
    const view = mountDelayed()
    expect(view.api.readAccountState).toHaveBeenCalledOnce()
    expect(view.button('api-key').hidden).toBe(true)
    fireEvent.click(view.button('api-key'))
    expect(view.keyForm().hidden).toBe(true)
    fireEvent.submit(view.keyForm())
    fireEvent.click(view.button('skip-key'))
    await act(async () => { fireEvent.click(view.button('sign-in')) })
    expect(view.button('auth-retry').hidden).toBe(false)
    expect(view.button('auth-api-key').hidden).toBe(true)
    fireEvent.click(view.button('auth-api-key'))
    expect(view.keyForm().hidden).toBe(true)
    expect(view.api.saveApiKey).not.toHaveBeenCalled()
    expect(view.api.skip).not.toHaveBeenCalled()
    act(() => { view.api.onAccountState.mock.calls[0]![0](account()) })
    expect(view.button('auth-api-key').hidden).toBe(false)
    fireEvent.click(view.button('auth-api-key'))
    expect(view.keyForm().hidden).toBe(false)
  })

  it.each([
    [undefined, false],
    [required, true],
  ] as const)('decides the entry from the initial read with capabilities %j', async (capabilities, hidden) => {
    const view = mountDelayed()
    await act(async () => { view.first.resolve(account(capabilities)) })
    expect(view.button('api-key').hidden).toBe(hidden)
    fireEvent.click(view.button('api-key'))
    expect(view.keyForm().hidden).toBe(hidden)
  })

  it('ignores an initial read that resolves after a streamed snapshot', async () => {
    const view = mountDelayed()
    act(() => { view.api.onAccountState.mock.calls[0]![0](account(required)) })
    await act(async () => { view.first.resolve(account()) })
    expect(view.button('api-key').hidden).toBe(true)
  })
})
