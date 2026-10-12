/** Desktop-only user controls; secret inputs are cleared as soon as the single add IPC is dispatched. */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode, SubmitEvent } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserCredentials, CredentialEntry, CredentialFillResult, FillFieldType } from '../../types.ts'
import css from './Credentials.module.css'

interface CredentialControlsProps extends PropsLocale<'sidebarBrowser'> {
  readonly api: BrowserCredentials
  readonly url: string | undefined
}

/** @param props - desktop callbacks, observed page and localized copy. @returns a toolbar button and credential dialog. */
export function CredentialControls({ api, url, t }: CredentialControlsProps): ReactNode {
  const [open, setOpen] = useState(false)
  const [manage, setManage] = useState(false)
  const [entries, setEntries] = useState<CredentialEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<'list' | 'save' | 'fill' | 'remove'>()
  const [result, setResult] = useState<CredentialFillResult>()
  const [revision, setRevision] = useState(0)
  const form = useRef<HTMLFormElement>(null)
  const origin = url === undefined ? undefined : new URL(url).origin

  useEffect(() => {
    if (!open) return
    let current = true
    setLoaded(false)
    setError(undefined)
    if (!manage && origin === undefined) { setEntries([]); setLoaded(true); return }
    void api.list(manage ? undefined : origin).then((items) => {
      if (current) { setEntries(items); setLoaded(true) }
    }, () => { if (current) { setError('list'); setLoaded(true) } })
    return () => { current = false }
  }, [api, origin, open, manage, revision])

  const close = (): void => { form.current?.reset(); setOpen(false); setManage(false); setResult(undefined) }
  const fill = async (entry: CredentialEntry, fields: FillFieldType[]): Promise<void> => {
    setBusy(true); setError(undefined); setResult(undefined)
    try { setResult(await api.fill(entry.id, fields)) } catch (_error) { setError('fill') }
    finally { setBusy(false) }
  }
  const remove = async (entry: CredentialEntry): Promise<void> => {
    setBusy(true); setError(undefined)
    try { await api.remove(entry.id); setEntries(items => items.filter(item => item.id !== entry.id)) }
    catch (_error) { setError('remove') }
    finally { setBusy(false) }
  }
  const add = async (event: SubmitEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); event.stopPropagation()
    const element = event.currentTarget
    const input = (name: string): HTMLInputElement => element.elements.namedItem(name) as HTMLInputElement
    setBusy(true); setError(undefined)
    try {
      const pending = api.add(input('origin').value, input('label').value, input('username').value,
        input('password').value, input('totpSecret').value || undefined)
      input('password').value = ''; input('totpSecret').value = ''
      await pending
      element.reset()
      setRevision(value => value + 1)
    } catch (_error) { setError('save') }
    finally { input('password').value = ''; input('totpSecret').value = ''; setBusy(false) }
  }
  const fieldNames = (fields: readonly FillFieldType[]): string => fields.map(field => t(`credentials.${field}`)).join(', ')

  return <>
    <Button type="button" variant="toolbar" size="sm" onClick={() => { setOpen(true) }}>{t('credentials.open')}</Button>
    <Modal open={open} onClose={close} title={t(manage ? 'credentials.manage' : 'credentials.open')}
      closeLabel={t('credentials.close')} contentClassName={css.content ?? ''}
      footer={<Button type="button" size="sm" disabled={busy} onClick={() => { setManage(!manage); setResult(undefined) }}>
        {t(manage ? 'credentials.back' : 'credentials.manage')}
      </Button>}>
      <p>{t('credentials.approval')}</p>
      {!manage && <p>{origin ?? t('credentials.noSite')}</p>}
      {error !== undefined && <p role="alert">{t(`credentials.error.${error}`)}</p>}
      {error === 'list' && <Button type="button" onClick={() => { setRevision(value => value + 1) }}>{t('credentials.retry')}</Button>}
      <div aria-busy={!loaded || busy}>
        {loaded && entries.length === 0 && error !== 'list' && <p>{t('credentials.empty')}</p>}
        {entries.map(entry => <section key={entry.id} className={css.entry} aria-label={entry.label}>
          <strong>{entry.label}</strong><span>{entry.username}</span>
          {manage && <span>{entry.origin}</span>}
          <div className={css.actions}>
            {manage ? <Button type="button" size="sm" disabled={busy} onClick={() => { void remove(entry) }}>
              {t('credentials.remove')}
            </Button> : <>
              <Button type="button" size="sm" disabled={busy || !loaded || entry.origin !== origin}
                onClick={() => { void fill(entry, ['username', 'password']) }}>{t('credentials.fillLogin')}</Button>
              <Button type="button" size="sm" disabled={busy || !loaded || entry.origin !== origin || !entry.hasTotp}
                onClick={() => { void fill(entry, ['totp']) }}>{t('credentials.fillTotp')}</Button>
            </>}
          </div>
        </section>)}
      </div>
      {result !== undefined && <div role="status">
        <p>{t('credentials.filled', { fields: fieldNames(result.filled) })}</p>
        {result.notFound.length > 0 && <p>{t('credentials.notFound', { fields: fieldNames(result.notFound) })}</p>}
      </div>}
      {manage && <form ref={form} className={css.form} onSubmit={(event) => { void add(event) }} autoComplete="off">
        <label>{t('credentials.site')}<Input name="origin" type="url" defaultValue={origin} maxLength={2048} required /></label>
        <label>{t('credentials.label')}<Input name="label" maxLength={256} required /></label>
        <label>{t('credentials.username')}<Input name="username" maxLength={1024} autoComplete="off" /></label>
        <label>{t('credentials.password')}<Input name="password" type="password" maxLength={16384}
          autoComplete="new-password" required /></label>
        <label>{t('credentials.secret')}<Input name="totpSecret" type="password" maxLength={4096} autoComplete="off" /></label>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>{t('credentials.add')}</Button>
      </form>}
    </Modal>
  </>
}
