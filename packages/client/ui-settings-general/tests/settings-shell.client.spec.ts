// @vitest-environment jsdom
/** Settings navigation through an injected service over the assembled shell's store. */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsShell } from '@deepseek-ai/dsh-client-ui-settings/client'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { act, within } from '@testing-library/react'
import { describe, expect, vi } from 'vitest'
import type { createSettingsShellStore } from '../src/client/shell-store.ts'
import type { SettingsRootInjected } from '../src/client/shell-contract.ts'

const SELF = '@deepseek-ai/dsh-client-ui-settings-general'
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'
const it = createClientTest({ roster: webApp })
const uiIt = createClientTest({ roster: webApp }, { mount: true })
/** The first assembled boot transforms the entire web client roster. */
const COLD_BOOT_TIMEOUT_MS = 60_000

function shellStore(c: TestClient) {
  const entry = c.ctx.slots.entries('sidebar.settings')[0]!
  const handle = entry.store as ReturnType<typeof createSettingsShellStore>
  return handle.create()
}

async function consumer(c: TestClient) {
  const services: SettingsShell[] = []
  const disposed = vi.fn()
  const fiber = c.ctx.plugin({
    inject: ['settingsShell'],
    apply(ctx: Context) {
      services.push(ctx.settingsShell)
      ctx.effect(() => disposed, 'settings shell test consumer')
    },
  })
  await fiber.await()
  expect(services).toHaveLength(1)
  return { services, disposed }
}

describe('settingsShell client service', () => {
  it('injects commands that open a registered section and close the shared shell store', async ({ start }) => {
    const c = await start()
    const { services } = await consumer(c)
    const shell = services[0]!
    const store = shellStore(c)
    c.ctx.slots.register({ name: 'settings.section', id: 'service-section', order: 100, label: 'Service section' }, () => null)

    expect(store.getSnapshot()).toEqual({ open: false, activeId: undefined })
    shell.openSection('service-section')
    expect(store.getSnapshot()).toEqual({ open: true, activeId: 'service-section' })
    expect(shellStore(c)).toBe(store)

    shell.close()
    expect(store.getSnapshot()).toEqual({ open: false, activeId: undefined })
  }, COLD_BOOT_TIMEOUT_MS)

  uiIt('opens on the first section for an unregistered id and closes the rendered panel', async ({ start }) => {
    const c = await start()
    const { services } = await consumer(c)
    const store = shellStore(c)
    const entry = c.ctx.slots.entries('sidebar.settings')[0]!
    const injected = (entry.inject as () => SettingsRootInjected)()
    const first = injected.hooks.sections.getSnapshot()[0]!
    const dialog = () => document.querySelector<HTMLElement>('[role="dialog"][data-shortcut-modal="settings"]')
    expect(c.ctx.slots.entries('settings.section').some(entry => entry.options.id === 'missing-section')).toBe(false)

    expect(() => { act(() => { services[0]!.openSection('missing-section') }) }).not.toThrow()
    expect(store.getSnapshot().open).toBe(true)
    expect(dialog()).not.toBeNull()
    expect(within(dialog()!).getByRole('button', { name: first.label, current: true })).toBeTruthy()

    act(() => { services[0]!.close() })
    expect(dialog()).toBeNull()
  })

  it('rebinds injected consumers to the rebuilt shell and removes the service on unload', async ({ start }) => {
    const c = await start()
    const { services, disposed } = await consumer(c)
    const before = shellStore(c)
    services[0]!.openSection('models')

    await c.reload(SIDEBAR)
    await c.flush()
    expect(disposed).toHaveBeenCalledOnce()
    expect(services).toHaveLength(2)
    expect(services[1]).not.toBe(services[0])
    const after = shellStore(c)
    expect(after).not.toBe(before)
    expect(after.getSnapshot()).toEqual({ open: false, activeId: undefined })

    services[1]!.openSection('plugins')
    expect(after.getSnapshot()).toEqual({ open: true, activeId: 'plugins' })
    expect(before.getSnapshot()).toEqual({ open: true, activeId: 'models' })

    await c.unload(SELF)
    await c.flush()
    expect(c.ctx.get('settingsShell')).toBeUndefined()
    expect(c.ctx.slots.entries('sidebar.settings')).toHaveLength(0)
    expect(disposed).toHaveBeenCalledTimes(2)
  })
})
