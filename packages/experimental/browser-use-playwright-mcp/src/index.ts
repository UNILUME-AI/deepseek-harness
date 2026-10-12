/** Chromium browser tools from the pinned Playwright MCP server. @module */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'
import { createPointerCoordinatesDecorator, type PointerCoordinateSpace } from './pointer-coordinates.ts'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt']

/** Coordinate space the configured model uses for pointer tools. */
export type { PointerCoordinateSpace }

/** Extension connection to an externally owned Chrome or Edge browser. */
export interface ExtensionConfig {
  /** Exclusively connect one live Session through Playwright Extension. */
  mode: 'extension'
  /** Installed browser channel containing the extension; defaults to Chrome. */
  browser: 'chrome' | 'msedge'
  /** Credential reference resolved for each Session startup; omission requires manual approval. */
  extensionTokenEnv?: CredentialRef
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/**
 * Connection to the desktop shell's Sidebar browser tab through a shell-owned stand-in for the
 * extension browser executable. The upstream server launches `executablePath` with the extension
 * connection page URL; the stand-in hands that URL to the shell over `socketPath`.
 */
export interface SidebarConfig {
  /** Exclusively connect one live Session to the tab the desktop shell exposes. */
  mode: 'sidebar'
  /** Stand-in executable shipped with the desktop shell. */
  executablePath: string
  /** Shell-owned Unix socket that receives the connection page URL. */
  socketPath: string
  /** Per-launch shell authentication token, passed only through the child environment. */
  socketToken: string
  /** Milliseconds the stand-in waits for the shell to accept a connection before failing the browser call. */
  connectTimeoutMs: number
  /** Per-call timeout override in milliseconds; omission uses the MCP client default. */
  toolCallTimeoutMs?: number
}

/** Child environment names the Sidebar stand-in executable reads; shared with the desktop shell. */
export const SIDEBAR_ENV = {
  /** Unix socket path of the shell's connection listener. */
  socket: 'DSH_SIDEBAR_BROWSER_SOCKET',
  /** Per-launch shell authentication token. */
  token: 'DSH_SIDEBAR_BROWSER_TOKEN',
  /** Node-compatible executable that runs the stand-in's script. */
  node: 'DSH_SIDEBAR_BROWSER_NODE',
  /** Connection deadline in milliseconds. */
  connectTimeoutMs: 'DSH_SIDEBAR_BROWSER_CONNECT_TIMEOUT_MS',
} as const

/** Playwright browser selection, provider name, optional coordinate-tool capability, and the model's pointer coordinate space. */
export type Config = (BrowserMcpConfig | ExtensionConfig | SidebarConfig) & {
  /** Browser-use registration name and MCP tool namespace; distinct names let several providers coexist. Defaults to `playwright-mcp`. */
  name?: string
  /** Extra upstream tool groups; `vision` adds coordinate-based mouse tools. Defaults to none. */
  capabilities?: 'vision'[]
  /**
   * Coordinate space the configured model emits for pointer tools. Non-pixel
   * spaces rewrite the pointer tool definitions and convert model arguments to
   * viewport CSS pixels before forwarding; they require `capabilities: [vision]`. Defaults to `pixel`.
   */
  pointerCoordinates?: PointerCoordinateSpace
}

/** Validate browser selection, credential references, capabilities, and pointer space before activation. */
export const Config = Schema.intersect([
  Schema.union([
    Schema.intersect([BrowserMcpConfig, Schema.object({
      browser: Schema.never(), extensionTokenEnv: Schema.never(),
      socketPath: Schema.never(), socketToken: Schema.never(), connectTimeoutMs: Schema.never(),
    })]),
    Schema.object({
      mode: Schema.const('extension').required(),
      browser: Schema.union(['chrome', 'msedge']).default('chrome'),
      extensionTokenEnv: Schema.transform(Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u).role('credential-ref'), credentialRef),
      toolCallTimeoutMs: Schema.number().min(1),
      endpoint: Schema.never(),
      headless: Schema.never(),
      executablePath: Schema.never(),
      socketPath: Schema.never(),
      socketToken: Schema.never(),
      connectTimeoutMs: Schema.never(),
    }),
    Schema.object({
      mode: Schema.const('sidebar').required(),
      executablePath: Schema.string().pattern(/\S/u).required(),
      socketPath: Schema.string().pattern(/\S/u).required(),
      socketToken: Schema.string().pattern(/^[a-f0-9]{64}$/u).required(),
      connectTimeoutMs: Schema.number().min(1).default(10_000),
      toolCallTimeoutMs: Schema.number().min(1),
      browser: Schema.never(),
      extensionTokenEnv: Schema.never(),
      endpoint: Schema.never(),
      headless: Schema.never(),
    }),
  ]),
  Schema.object({
    name: Schema.string().pattern(/^[a-z][a-z0-9-]{0,31}$/u).default('playwright-mcp'),
    capabilities: Schema.array(Schema.const('vision')).default([]),
    pointerCoordinates: Schema.union([Schema.const('pixel'), Schema.const('normalized-1000-xy')]).default('pixel'),
  }),
]) as Schema<
  (Parameters<typeof BrowserMcpConfig>[0] | (Omit<ExtensionConfig, 'browser' | 'extensionTokenEnv'> & {
    browser?: ExtensionConfig['browser']
    extensionTokenEnv?: string
  }) | (Omit<SidebarConfig, 'connectTimeoutMs'> & { connectTimeoutMs?: number })) & {
    name?: string
    capabilities?: 'vision'[]
    pointerCoordinates?: PointerCoordinateSpace
  }, Config
>

/** Upstream server process resolved from a validated configuration. */
export interface ServerSpec {
  /** Browser-use registration name and MCP tool namespace. */
  name: string
  /** Executable that runs the pinned upstream server. */
  command: string
  /** Arguments passed directly without a shell. */
  args: string[]
  /** Child environment overrides; the extension credential is added per Session startup. */
  env: Record<string, string>
}

/**
 * Resolve the upstream server process for one configuration.
 * @param config - validated browser choice, provider name, and capabilities.
 * @returns the provider name, executable, arguments, and environment overrides.
 */
export function resolveServer(config: Config): ServerSpec {
  const name = config.name ?? 'playwright-mcp'
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  // Upstream environment options can otherwise replace the configured browser
  // mode or import an unrelated profile. Empty values mean absent to its parser.
  const env: Record<string, string> = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
    .map(key => [key, '']))
  const args = [cli, '--browser', config.mode === 'extension' ? config.browser : config.mode === 'sidebar' ? 'chrome' : 'chromium']
  if (config.mode === 'attach') {
    args.push('--cdp-endpoint', config.endpoint)
  } else if (config.mode === 'extension') {
    args.push('--extension')
  } else if (config.mode === 'sidebar') {
    // Upstream waits for the extension without a deadline; the stand-in enforces connectTimeoutMs.
    args.push('--extension', '--executable-path', config.executablePath)
    Object.assign(env, {
      [SIDEBAR_ENV.socket]: config.socketPath,
      [SIDEBAR_ENV.token]: config.socketToken,
      [SIDEBAR_ENV.node]: process.execPath,
      [SIDEBAR_ENV.connectTimeoutMs]: String(config.connectTimeoutMs),
    })
  } else {
    args.push('--isolated')
    if (config.headless) args.push('--headless')
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  if (config.capabilities?.includes('vision') === true) args.push('--caps', 'vision')
  return { name, command: process.execPath, args, env }
}

/**
 * Expose Playwright's upstream tools in each live Session's scope.
 * The pinned npm server runs under the current Node executable; browser state is not persisted by DSH.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice, optional tool timeout, and pointer coordinate space.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode !== 'extension' && config.mode !== 'sidebar') validateBrowserMcpConfig(config)
  const { name, command, args, env } = resolveServer(config)
  const pointerCoordinates = config.pointerCoordinates ?? 'pixel'
  if (pointerCoordinates !== 'pixel' && config.capabilities?.includes('vision') !== true) {
    throw new Error(`${name}: pointerCoordinates ${pointerCoordinates} requires capabilities [vision]`)
  }
  const tokenRef = config.mode === 'extension' ? config.extensionTokenEnv : undefined
  const decoratePointer = createPointerCoordinatesDecorator(pointerCoordinates)
  if (config.mode === 'sidebar') {
    const prefix = `mcp__${name}__`
    ctx.on('tools/execute', async (exec, next) => {
      if (!exec.name.startsWith(prefix)) return next()
      assertSidebarTool(exec.name.slice(prefix.length), exec.arguments)
      return next()
    })
  }
  mountSessionMcp(ctx, {
    name,
    exclusive: config.mode !== 'launch',
    command,
    args,
    env: tokenRef !== undefined
      ? async () => {
        let value: string | undefined
        try {
          const credentials = ctx.get('credentials')
          value = credentials === undefined
            ? launchEnvironmentOf(ctx).get(tokenRef)?.value
            : (await credentials.resolve(tokenRef))?.value
        } catch (_error) {
          // Credential-provider diagnostics may contain secret values.
          throw new Error(`${name}: extension credential resolution failed`)
        }
        if (value === undefined || value.length === 0) throw new Error(`${name}: extension credential ${tokenRef} is not configured`)
        return { ...env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: value }
      }
      : env,
    decorateTool: (tool, callSibling) => {
      if (config.mode !== 'sidebar') return decoratePointer(tool, callSibling)
      if (!SIDEBAR_TOOLS.has(tool.rawName)) return undefined
      return {
        ...tool,
        ...tool.rawName === 'browser_tabs' ? {
          inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list'] } }, required: ['action'], additionalProperties: false },
        } : { inputSchema: sidebarInputSchema(tool.rawName, tool.inputSchema) },
        call: (args, execution) => {
          assertSidebarTool(tool.rawName, args)
          return tool.call(args, execution)
        },
      }
    },
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}

// These upstream tools use the shell's read and navigation CDP allowlist. New upstream tools
// remain hidden until their operations have been checked against that list.
const SIDEBAR_TOOLS: ReadonlySet<string> = new Set([
  'browser_snapshot', 'browser_take_screenshot', 'browser_navigate', 'browser_navigate_back',
  'browser_navigate_forward', 'browser_tabs',
])

function sidebarInputSchema(rawName: string, inputSchema: Record<string, unknown>): Record<string, unknown> {
  if (rawName !== 'browser_snapshot' && rawName !== 'browser_take_screenshot') return inputSchema
  const properties = inputSchema.properties
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    throw new Error(`sidebar browser: ${rawName} requires object schema properties`)
  }
  return {
    ...inputSchema,
    properties: Object.fromEntries(Object.entries(properties).filter(([key]) => key !== 'filename')),
    ...Array.isArray(inputSchema.required) ? { required: inputSchema.required.filter((key: unknown) => key !== 'filename') } : {},
    additionalProperties: false,
  }
}

function assertSidebarTool(rawName: string, args: unknown): void {
  if (!SIDEBAR_TOOLS.has(rawName) || (rawName === 'browser_tabs'
    && (typeof args !== 'object' || args === null || !('action' in args) || args.action !== 'list'))) {
    throw new Error('sidebar browser: tool is refused; only reading and navigation are allowed')
  }
  if ((rawName === 'browser_snapshot' || rawName === 'browser_take_screenshot')
    && typeof args === 'object' && args !== null && 'filename' in args) {
    throw new Error('sidebar browser: filename is refused; use the default output directory')
  }
  if (rawName === 'browser_navigate' && (typeof args !== 'object' || args === null || !('url' in args)
    || typeof args.url !== 'string' || !URL.canParse(args.url)
    || !['http:', 'https:'].includes(new URL(args.url).protocol))) {
    throw new Error('sidebar browser: navigation requires an HTTP(S) URL')
  }
}
