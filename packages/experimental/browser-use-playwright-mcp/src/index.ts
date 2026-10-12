/** Chromium browser tools from the pinned Playwright MCP server. @module */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { Context } from '@deepseek-ai/cordis'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig } from '@deepseek-ai/dsh-experimental-browser-use-runtime/mcp'

/** Cordis identity for the Playwright MCP browser provider. */
export const name = 'experimental-browser-use-playwright-mcp'

/** Services required for scoped MCP startup and prompt readiness checks. */
export const inject = ['browserUse', 'agents', 'tools', 'systemPrompt']

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

/** Playwright browser selection and optional coordinate-tool capability. */
export type Config = (BrowserMcpConfig | ExtensionConfig) & {
  /** Extra upstream tool groups; `vision` adds coordinate-based mouse tools. Defaults to none. */
  capabilities?: 'vision'[]
}

/** Validate browser selection, credential references, and upstream capabilities before activation. */
export const Config = Schema.intersect([
  Schema.union([
    Schema.intersect([BrowserMcpConfig, Schema.object({ browser: Schema.never(), extensionTokenEnv: Schema.never() })]),
    Schema.object({
      mode: Schema.const('extension').required(),
      browser: Schema.union(['chrome', 'msedge']).default('chrome'),
      extensionTokenEnv: Schema.transform(Schema.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/u).role('credential-ref'), credentialRef),
      toolCallTimeoutMs: Schema.number().min(1),
      endpoint: Schema.never(),
      headless: Schema.never(),
      executablePath: Schema.never(),
    }),
  ]),
  Schema.object({ capabilities: Schema.array(Schema.const('vision')).default([]) }),
]) as Schema<
  (Parameters<typeof BrowserMcpConfig>[0] | (Omit<ExtensionConfig, 'browser' | 'extensionTokenEnv'> & {
    browser?: ExtensionConfig['browser']
    extensionTokenEnv?: string
  })) & { capabilities?: 'vision'[] }, Config
>

/**
 * Expose Playwright's upstream tools in each live Session's scope.
 * The pinned npm server runs under the current Node executable; browser state is not persisted by DSH.
 * @param ctx - provider context supplying browser use, Agents, and tools.
 * @param config - validated browser choice and optional tool timeout.
 */
export function apply(ctx: Context, config: Config): void {
  if (config.mode !== 'extension') validateBrowserMcpConfig(config)
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  // Upstream environment options can otherwise replace the configured browser
  // mode or import an unrelated profile. Empty values mean absent to its parser.
  const env = Object.fromEntries(Object.keys(process.env)
    .filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_'))
    .map(key => [key, '']))
  const args = [cli, '--browser', config.mode === 'extension' ? config.browser : 'chromium']
  if (config.mode === 'attach') {
    args.push('--cdp-endpoint', config.endpoint)
  } else if (config.mode === 'extension') {
    args.push('--extension')
  } else {
    args.push('--isolated')
    if (config.headless) args.push('--headless')
    if (config.executablePath !== undefined) args.push('--executable-path', config.executablePath)
  }
  if (config.capabilities?.includes('vision') === true) args.push('--caps', 'vision')
  const tokenRef = config.mode === 'extension' ? config.extensionTokenEnv : undefined
  mountSessionMcp(ctx, {
    name: 'playwright-mcp',
    exclusive: config.mode !== 'launch',
    command: process.execPath,
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
          throw new Error('playwright-mcp: extension credential resolution failed')
        }
        if (value === undefined || value.length === 0) throw new Error(`playwright-mcp: extension credential ${tokenRef} is not configured`)
        return { ...env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: value }
      }
      : env,
    ...config.toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs: config.toolCallTimeoutMs },
  })
}
