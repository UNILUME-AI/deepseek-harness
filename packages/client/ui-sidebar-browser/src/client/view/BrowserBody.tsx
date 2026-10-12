/** Common browser chrome; a presentation adapter attaches the page inside its content container. */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { SubmitEvent, ReactNode } from 'react'
import {
  Button,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconEllipsisOutlineMedium,
  IconLinkOutlineRegular,
  IconRefreshOutlineRegular, Tooltip,
  IconRightUpOutlineRegular,
  Menu,
  SHIELD_OUTLINE_PATH,
  ICON_REGULAR_STROKE,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserInjected } from '../browser/BrowserController.ts'
import { emptyBrowserFrame } from '../browser/BrowserFrame.ts'
import { currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import type { BrowserStore } from '../browser/store.ts'
import { CredentialControls } from './CredentialControls.tsx'
import css from './Browser.module.css'

const EMPTY_FRAME = emptyBrowserFrame()

/** Outcome of the last site sign-in clearing action; `site` names the cleared partition's site. */
type ClearNotice = { readonly kind: 'site'; readonly site: string } | { readonly kind: 'all' | 'failed' }

/** Clearing notices disappear after this many milliseconds. */
const CLEAR_NOTICE_MS = 5000

function SandboxPolicyIcon({ sandboxed }: { readonly sandboxed: boolean }): ReactNode {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d={SHIELD_OUTLINE_PATH} stroke="currentColor" strokeWidth={ICON_REGULAR_STROKE} strokeLinejoin="round" />
      {sandboxed
        ? <path d="M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z" fill="currentColor" />
        : <path d="M10.6074 4.40278L8.00975 6.99973L10.6074 9.59739L9.59736 10.6074L6.9997 8.00978L4.40274 10.6074L3.3927 9.59739L5.98966 6.99973L3.3927 4.40278L4.40274 3.39273L6.9997 5.98969L9.59736 3.39273L10.6074 4.40278Z" fill="currentColor" transform="translate(1.2 0.8)" />}
    </svg>
  )
}

/** Browser body props assembled by the tab seat. */
export type BrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'>
  & PropsStore<BrowserStore>
  & PropsLocale<'sidebarBrowser'>
  & InjectFace<BrowserInjected>

/** The clearing actions a desktop bridge supplies; rendered as one toolbar menu. */
function SiteClearingMenu({ site, busy, onAction, t }: {
  readonly site: string | undefined
  readonly busy: boolean
  readonly onAction: (action: 'site' | 'all') => void
  readonly t: PropsLocale<'sidebarBrowser'>['t']
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <Menu open={open} align="end" side="bottom" portal compact autoFocus onClose={() => { setOpen(false) }}
    anchor={<button type="button" className={css.tool} aria-label={t('clear.menu')} title={t('clear.menu')}
      aria-haspopup="menu" aria-expanded={open} onClick={() => { setOpen(value => !value) }}
    ><IconEllipsisOutlineMedium size={14} /></button>}
    items={[
      { id: 'site', label: site === undefined ? t('clear.site.none') : t('clear.site', { site }),
        disabled: busy || site === undefined },
      { id: 'all', label: t('clear.all'), disabled: busy, danger: true },
    ]}
    onSelect={(id) => { setOpen(false); onAction(id as 'site' | 'all') }}
  />
}

function useBrowserDraft(url: string | undefined, revision: number): readonly [string, (value: string) => void] {
  const [edit, setEdit] = useState<{ readonly revision: number; readonly value: string }>()
  return [edit?.revision === revision ? edit.value : url ?? '',
    (value) => { setEdit({ revision, value }) }]
}

/** Render provider-neutral navigation state and optional controls. */
export function BrowserBody(props: BrowserBodyProps): ReactNode {
  const { mount, loadUrl, restore, goBack, goForward, reload, setSandbox, useBrowserState, useStore, useTabInfo, t } = props
  const { tab } = useTabInfo()
  useEffect(() => tab.actions.bindCommands({ refresh: () => { reload(tab.id) } }), [tab.actions, tab.id, reload])
  const saved = useStore(state => state.byTab[tab.id])
  const initial = useRef(saved)
  const initialUrl = useRef(tab.navigation.params?.url)
  const viewportId = useId()
  const [mountEpoch, setMountEpoch] = useState(0)
  const state = useBrowserState(tab.id)
  const frame = state?.frame ?? EMPTY_FRAME
  const restoreTarget = state === undefined ? currentBrowserTarget(initial.current) : state.restoreTarget
  const target = frame.target ?? restoreTarget
  const [draft, setDraft] = useBrowserDraft(target?.url ?? initialUrl.current, state?.addressRevision ?? 0)

  useLayoutEffect(() => {
    const hide = mount({
      tabId: tab.id, signal: tab.signal, viewportId, applicationOrigin: window.location.origin,
      initial: initial.current, initialUrl: initialUrl.current,
      openTab: (url) => { tab.actions.openTab('browser', { params: { url }, revealIfOpened: false }) },
    })
    setMountEpoch(value => value + 1)
    return hide
  }, [mount, tab.id, tab.signal, tab.actions, viewportId, props.actions])

  const credentials = props.getCredentials?.(tab.id)
  const visible = tab.visible
  useEffect(() => {
    // Main tracks the most recently visible browser guest for the credential
    // tools; a hidden or collapsed tab must withdraw its activation.
    if (visible) credentials?.reportActive()
    else credentials?.reportInactive()
  }, [credentials, visible])
  const unknown = frame.address === 'unknown'
  const externalUrl = unknown ? undefined : target?.url
  const sandboxed = frame.sandboxEnabled
  const failure = state?.addressFailure
  const error = frame.error
  const { clearSite, clearAllSites } = props
  const site = frame.site
  const [clearNotice, setClearNotice] = useState<ClearNotice>()
  const [clearBusy, setClearBusy] = useState(false)
  useEffect(() => {
    if (clearNotice === undefined) return
    const timer = setTimeout(() => { setClearNotice(undefined) }, CLEAR_NOTICE_MS)
    return () => { clearTimeout(timer) }
  }, [clearNotice])
  const runClear = (action: 'site' | 'all'): void => {
    if (clearBusy || clearSite === undefined || clearAllSites === undefined) return
    // The partition's site may have gone between rendering and selection; never widen to clearing all.
    if (action === 'site' && site === undefined) return
    const done: ClearNotice = action === 'site' && site !== undefined ? { kind: 'site', site } : { kind: 'all' }
    setClearBusy(true); setClearNotice(undefined)
    void (action === 'site' ? clearSite(tab.id) : clearAllSites())
      .then(() => { setClearNotice(done) }, () => { setClearNotice({ kind: 'failed' }) })
      .finally(() => { setClearBusy(false) })
  }
  const submit = (event: SubmitEvent<HTMLFormElement>): void => { event.preventDefault(); loadUrl(tab.id, draft) }

  return (
    <div className={css.root}>
      <form className={css.toolbar} onSubmit={submit}>
        <button type="button" className={css.tool} aria-label={t('back')} title={t('back')} disabled={!frame.canGoBack} onClick={() => { goBack(tab.id) }}><IconChevronLeftOutlineRegular /></button>
        <button type="button" className={css.tool} aria-label={t('forward')} title={t('forward')} disabled={!frame.canGoForward} onClick={() => { goForward(tab.id) }}><IconChevronRightOutlineRegular /></button>
        <Tooltip label={t('reload')} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('reload')} aria-keyshortcuts={tab.refreshShortcut?.aria} disabled={target === undefined || mountEpoch === 0} onClick={() => { reload(tab.id) }}><IconRefreshOutlineRegular /></button>
        </Tooltip>
        <div className={css.addressBox}>
          <input
            className={[css.address, unknown ? css.addressUnknown : ''].join(' ')}
            value={draft}
            aria-label={t('address.placeholder')}
            placeholder={t('address.placeholder')}
            spellCheck={false}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
          />
          {unknown && <span className={css.addressChanged}>{t('address.changed')}</span>}
          <button type="submit" className={[css.tool, css.addressGo].join(' ')} aria-label={t('go')} title={t('go')}><IconLinkOutlineRegular /></button>
        </div>
        <button type="button" className={css.tool} aria-label={t('external')} title={t('external')} disabled={externalUrl === undefined}
          onClick={externalUrl === undefined ? undefined : () => { window.open(externalUrl, '_blank', 'noopener,noreferrer') }}
        ><IconRightUpOutlineRegular size={14} /></button>
        {credentials !== undefined && <CredentialControls key={frame.target?.url ?? ''} api={credentials}
          url={frame.address === 'observed' ? frame.target?.url : undefined} t={t} />}
        {sandboxed !== undefined && <button
          type="button"
          className={[css.tool, sandboxed ? '' : css.sandboxOff].join(' ')}
          aria-label={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          title={t(sandboxed ? 'sandbox.disable' : 'sandbox.enable')}
          aria-pressed={!sandboxed}
          onClick={() => { setSandbox(tab.id, !sandboxed) }}
        ><SandboxPolicyIcon sandboxed={sandboxed} /></button>}
        {clearSite !== undefined && clearAllSites !== undefined
          && <SiteClearingMenu site={site} busy={clearBusy} onAction={runClear} t={t} />}
      </form>
      {clearNotice !== undefined && <div className={css.notice} role="status">
        {clearNotice.kind === 'site' ? t('clear.done.site', { site: clearNotice.site })
          : t(clearNotice.kind === 'all' ? 'clear.done.all' : 'clear.failed')}
      </div>}
      {sandboxed === false && <div className={css.sandboxWarning} role="status">{t('sandbox.warning')}</div>}
      {error !== undefined && <div className={css.failure} role="status">{error.code !== undefined && error.description !== undefined
        ? t('load.failed.detail', { code: String(error.code), description: error.description })
        : t('load.failed')}</div>}
      {failure !== undefined && <div className={css.failure} role="alert">{t(`error.${failure}`)}</div>}
      <div className={css.content} aria-busy={frame.loading}>
        <div id={viewportId} className={css.viewport} aria-label={t('type.label')} />
        {restoreTarget !== undefined && <section className={css.restore} aria-label={t('restore.previous')}>
          <p className={css.restoreLabel}>{t('restore.previous')}</p>
          <p className={css.restoreTitle}>{restoreTarget.title}</p>
          <p className={css.restoreUrl}>{restoreTarget.url}</p>
          <Button variant="primary" size="sm" disabled={mountEpoch === 0} onClick={() => { restore(tab.id) }}>
            {t('restore.action')}
          </Button>
        </section>}
        {restoreTarget === undefined && (target === undefined || frame.loading) && error === undefined && <div className={css.placeholder}>
          <div className={css.start}>{t(target === undefined ? 'start' : 'loading')}</div>
        </div>}
      </div>
      {unknown && <p className={css.limit}>{t('address.unknown')}</p>}
    </div>
  )
}
