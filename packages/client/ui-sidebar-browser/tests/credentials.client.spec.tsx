// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import type { BrowserCredentials, CredentialEntry, CredentialId } from '../src/types.ts'
import { CredentialControls } from '../src/client/view/CredentialControls.tsx'
import { zh, en } from '../src/client/locales.ts'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'

const id = '00000000-0000-4000-8000-000000000001' as CredentialId
const entry: CredentialEntry = { id, origin: 'https://shop.example', label: 'Seller', username: 'alice', hasTotp: true }
function setup(language: 'zh' | 'en' = 'zh', url: string | undefined = 'https://shop.example/login') {
  const messages = language === 'zh' ? zh : en
  const api = {
    list: vi.fn<BrowserCredentials['list']>(async () => [entry]),
    add: vi.fn<BrowserCredentials['add']>(async () => id),
    remove: vi.fn<BrowserCredentials['remove']>(async () => {}),
    fill: vi.fn<BrowserCredentials['fill']>(async (_id, fields) => ({ filled: [...fields], notFound: [] })),
  }
  const t: PropsLocale<'sidebarBrowser'>['t'] = (key, params) => {
    const dictionary: Readonly<Record<string, string>> = messages
    const text = dictionary[key] ?? key
    return params === undefined ? text : text.replace(/\{(\w+)\}/g, (_match, name: string) => String(params[name]))
  }
  const view = render(<CredentialControls api={api} url={url} t={t} />)
  fireEvent.click(view.getByRole('button', { name: messages['credentials.open'] }))
  return { api, view, messages }
}
afterEach(cleanup)

describe('desktop credential controls', () => {
  it.each(['zh', 'en'] as const)('lists the current origin and fills only the clicked fields in %s', async (language) => {
    const { api, view, messages } = setup(language)
    await view.findByText('Seller')
    expect(api.list).toHaveBeenCalledWith('https://shop.example')
    fireEvent.click(view.getByRole('button', { name: messages['credentials.fillLogin'] }))
    await waitFor(() => { expect(api.fill).toHaveBeenCalledWith(id, ['username', 'password']) })
    await waitFor(() => { expect(view.getByRole('button', { name: messages['credentials.fillTotp'] })).toHaveProperty('disabled', false) })
    fireEvent.click(view.getByRole('button', { name: messages['credentials.fillTotp'] }))
    await waitFor(() => { expect(api.fill).toHaveBeenLastCalledWith(id, ['totp']) })
    await view.findByRole('status')
  })

  it('dispatches new secrets once, immediately clears the inputs, and lists metadata after saving', async () => {
    const { api, view, messages } = setup()
    await view.findByText('Seller')
    fireEvent.click(view.getByRole('button', { name: messages['credentials.manage'] }))
    await waitFor(() => { expect(api.list).toHaveBeenLastCalledWith(undefined) })
    fireEvent.change(view.getByLabelText(messages['credentials.label']), { target: { value: 'New account' } })
    fireEvent.change(view.getByLabelText(messages['credentials.username']), { target: { value: 'bob' } })
    const password = view.getByLabelText(messages['credentials.password'])
    const secret = view.getByLabelText(messages['credentials.secret'])
    fireEvent.change(password, { target: { value: 'synthetic-password' } })
    fireEvent.change(secret, { target: { value: 'JBSWY3DPEHPK3PXP' } })
    let resolve: (value: CredentialId) => void = () => {}
    api.add.mockImplementationOnce(() => new Promise<CredentialId>((done) => { resolve = done }))
    fireEvent.click(view.getByRole('button', { name: messages['credentials.add'] }))
    expect(api.add).toHaveBeenCalledExactlyOnceWith('https://shop.example', 'New account', 'bob', 'synthetic-password', 'JBSWY3DPEHPK3PXP')
    expect(password).toHaveProperty('value', '')
    expect(secret).toHaveProperty('value', '')
    resolve(id)
    await waitFor(() => { expect(view.getByRole('button', { name: messages['credentials.add'] })).toHaveProperty('disabled', false) })
    expect(view.queryByText('synthetic-password')).toBeNull()
  })

  it('deletes through management, retaining the row if deletion fails', async () => {
    const { api, view, messages } = setup()
    await view.findByText('Seller')
    fireEvent.click(view.getByRole('button', { name: messages['credentials.manage'] }))
    await waitFor(() => { expect(api.list).toHaveBeenLastCalledWith(undefined) })
    api.remove.mockRejectedValueOnce(new Error('failure'))
    fireEvent.click(view.getByRole('button', { name: messages['credentials.remove'] }))
    expect(await view.findByRole('alert')).toHaveProperty('textContent', messages['credentials.error.remove'])
    expect(view.getByText('Seller')).toBeDefined()
    fireEvent.click(view.getByRole('button', { name: messages['credentials.remove'] }))
    await waitFor(() => { expect(view.queryByText('Seller')).toBeNull() })
    expect(api.remove).toHaveBeenCalledWith(id)
  })

  it('reports missing fields and never renders an IPC exception that might contain a secret', async () => {
    const { api, view, messages } = setup()
    await view.findByText('Seller')
    api.fill.mockResolvedValueOnce({ filled: ['username'], notFound: ['password'] })
    fireEvent.click(view.getByRole('button', { name: messages['credentials.fillLogin'] }))
    expect(await view.findByRole('status')).toHaveProperty('textContent', '已填入：用户名未找到：密码')
    api.fill.mockRejectedValueOnce(new Error('synthetic-secret-in-error'))
    fireEvent.click(view.getByRole('button', { name: messages['credentials.fillLogin'] }))
    expect(await view.findByRole('alert')).toHaveProperty('textContent', messages['credentials.error.fill'])
    expect(view.queryByText('synthetic-secret-in-error')).toBeNull()
  })

  it('disables TOTP when absent and dismisses with the localized close action', async () => {
    const { api, view, messages } = setup()
    api.list.mockResolvedValueOnce([{ ...entry, hasTotp: false }])
    await view.findByText('Seller')
    fireEvent.click(view.getByRole('button', { name: messages['credentials.manage'] }))
    await waitFor(() => { expect(api.list).toHaveBeenCalledTimes(2) })
    api.list.mockResolvedValueOnce([{ ...entry, hasTotp: false }])
    fireEvent.click(view.getByRole('button', { name: messages['credentials.back'] }))
    await waitFor(() => { expect(view.getByRole('button', { name: messages['credentials.fillTotp'] })).toHaveProperty('disabled', true) })
    fireEvent.click(within(view.getByRole('dialog')).getByRole('button', { name: messages['credentials.close'] }))
    expect(view.queryByRole('dialog')).toBeNull()
  })
})
