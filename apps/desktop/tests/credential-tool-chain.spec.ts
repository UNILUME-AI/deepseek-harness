/**
 * End-to-end chain over the real production pieces on both sides of the Host
 * IPC boundary: the main-process request handler (real vault, real approval
 * classification, real fill script dispatch), the real DesktopCredentialBridge
 * validating wire messages, and the real model-facing tools rendering the final
 * text. Only the process boundary itself is simulated: messages cross a JSON
 * round-trip, matching Node IPC serialization.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents, WebSource } from 'electron'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  CREDENTIALS_FILL_TOOL,
  CREDENTIALS_LIST_TOOL,
  createCredentialTools,
} from '@deepseek-ai/dsh-desktop-credential-tools'
import { DesktopCredentialBridge, type CredentialBridgePort } from '@deepseek-ai/dsh-desktop-credential-tools'
import type { CredentialRequestMessage } from '@deepseek-ai/dsh-desktop-credential-tools/protocol'
import type { DesktopBrowserLeaseId } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { createCredentialRequestHandler } from '../src/credential-host.ts'
import { CredentialVault } from '../src/credential-vault.ts'

const electronMock = vi.hoisted(() => {
  const mockDialog = {
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
  }
  const mockSystemPreferences = {
    canPromptTouchID: vi.fn(() => false),
    promptTouchID: vi.fn(async () => {}),
  }
  const mockSafeStorage = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => 'gnome_libsecret'),
    encryptString: vi.fn((str: string) => Buffer.from(`encrypted:${str}`)),
    decryptString: vi.fn((buf: Buffer) => {
      const str = buf.toString('utf8')
      if (str.startsWith('encrypted:')) return str.slice('encrypted:'.length)
      throw new Error('Invalid encrypted buffer')
    }),
  }
  return { dialog: mockDialog, systemPreferences: mockSystemPreferences, safeStorage: mockSafeStorage }
})
vi.mock('electron', () => electronMock)

/** Password and TOTP seed carrying the characters most likely to escape into text or JSON. */
const SECRET = 'p"\\\n秘  c'
const TOTP_SEED = 'JBSWY3DPEHPK3PXP'
const LEASE = '00000000-0000-4000-8000-0000000000aa' as DesktopBrowserLeaseId

let directory: string
let vault: CredentialVault

beforeEach(async () => {
  vi.clearAllMocks()
  electronMock.dialog.showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })
  electronMock.systemPreferences.canPromptTouchID.mockReturnValue(false)
  directory = await mkdtemp(join(tmpdir(), 'dsh-credential-chain-'))
  vault = new CredentialVault(directory)
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/**
 * Wire the real bridge to the real handler with JSON serialization in both
 * directions, the way the Node IPC channel carries the same messages.
 * @returns the cordis context carrying the tool registry and the port for its bridge.
 */
function chainFixture(guest: WebContents): { ctx: Context; port: CredentialBridgePort } {
  const window = { webContents: { id: 1 }, isDestroyed: () => false } as BrowserWindow
  const handler = createCredentialRequestHandler({
    primary: () => window,
    guests: { getActiveGuest: () => guest, getActiveLease: () => LEASE },
    confirmVisible: async () => true,
    vault,
  })
  const listeners = new Set<(message: unknown) => void>()
  const port: CredentialBridgePort = {
    connected: true,
    send(message: CredentialRequestMessage) {
      const wire = JSON.parse(JSON.stringify(message)) as CredentialRequestMessage
      const { type, requestId } = wire
      const domain = type === 'credentials-list'
        ? { type }
        : { type, credentialId: wire.credentialId, fields: wire.fields }
      void Promise.resolve()
        .then(() => handler(domain))
        .then((response) => {
          for (const listener of [...listeners]) {
            listener(JSON.parse(JSON.stringify({ type, requestId, ...response })))
          }
        }, () => {
          for (const listener of [...listeners]) listener({ type, requestId, error: 'error' })
        })
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onDisconnect() { return () => {} },
  }
  return { ctx: new Context(), port }
}

function text(result: { content: { readonly type: string; readonly text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('credential tool chain from vault to model-visible text', () => {
  it('lists and fills through the real handler, bridge, and tools without any secret in the results', async () => {
    const id = await vault.add('https://example.com', 'Shop', 'alice', SECRET, TOTP_SEED)
    const methods: Pick<WebContents, 'getURL' | 'executeJavaScriptInIsolatedWorld'> = {
      getURL: () => 'https://example.com/login',
      executeJavaScriptInIsolatedWorld: vi.fn(async (_world: number, _scripts: WebSource[]) => true),
    }
    const guest = methods as WebContents
    const { ctx, port } = chainFixture(guest)
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const bridge = new DesktopCredentialBridge(port)
      for (const dispose of createCredentialTools(bridge).map(tool => ctx.tools.register(tool))) {
        ctx.effect(() => () => { dispose() }, 'test: chain tools')
      }

      const list = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-chain-list'),
        name: CREDENTIALS_LIST_TOOL,
        arguments: {},
      })
      expect(list.isError).toBe(false)
      expect(text(list)).toBe('Credentials for https://example.com:\n'
        + `- Shop (id: ${id}, username: alice, one-time code available)`)

      const fill = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-chain-fill'),
        name: CREDENTIALS_FILL_TOOL,
        arguments: { credentialId: id, fields: ['username', 'password'] },
      })
      expect(fill.isError).toBe(false)
      expect(text(fill)).toBe('Filled: username, password.')
      expect(electronMock.dialog.showMessageBox).toHaveBeenCalledOnce()

      // No structure returned toward the Host or the model carries the stored
      // password or the TOTP seed in any form.
      expect(JSON.stringify(list)).not.toContain(SECRET)
      expect(JSON.stringify(fill)).not.toContain(SECRET)
      expect(JSON.stringify(list)).not.toContain(TOTP_SEED)
      expect(JSON.stringify(fill)).not.toContain(TOTP_SEED)
      expect(text(list)).not.toContain(SECRET)
      expect(text(fill)).not.toContain(SECRET)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
