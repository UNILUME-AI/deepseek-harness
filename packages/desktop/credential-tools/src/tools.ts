/**
 * The two model-facing tools over {@link DesktopCredentialBridge}. Both are
 * reference-only: the model names an entry id and fields, the shell shows the
 * approval UI, and results carry field names and error categories — never a
 * password, code, or page value.
 * @module @deepseek-ai/dsh-desktop-credential-tools/tools
 */

import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CredentialBridgePort, DesktopCredentialBridge } from './bridge.ts'
import { CREDENTIAL_FILL_FIELDS, credentialId, type CredentialRequestError } from './protocol.ts'

/** Model-visible name of the metadata-listing tool. */
export const CREDENTIALS_LIST_TOOL = 'credentials_list'

/** Model-visible name of the approval-gated fill tool. */
export const CREDENTIALS_FILL_TOOL = 'credentials_fill'

const LIST_DESCRIPTION =
  'List the login credential entries the user has saved in this desktop app for the site currently open '
  + 'in their browser tab. Returns entry metadata only — id, label, username, and whether a time-based '
  + 'one-time code is available. Passwords and one-time codes are never exposed to you. '
  + 'Pass an entry id to credentials_fill to fill it.'

const FILL_DESCRIPTION =
  'Fill a saved credential into the login form of the site currently open in the user\'s browser tab. '
  + 'Reference an entry by id from credentials_list and choose the fields to fill. '
  + 'The user approves every fill in a native dialog (with Touch ID where available); '
  + 'you never see the password or one-time code, and the form is never submitted automatically. '
  + 'The fill targets the exact site the entry was saved for; if the tab has navigated elsewhere the fill is refused. '
  + 'If this call is cancelled or interrupted, the outcome is unknown: the approval dialog may still be open and the '
  + 'page may or may not have been filled. Confirm with the user before assuming anything.'

const ERROR_MESSAGES: Record<CredentialRequestError, string> = {
  'unavailable': 'Credential filling is not available in this app session.',
  'no-window': 'The app window is not available.',
  'no-active-page': 'No browser tab is currently active in the user\'s sidebar; ask the user to open the login page there first.',
  'not-found': 'The credential entry no longer exists; call credentials_list again for current entries.',
  'origin-mismatch': 'The current page no longer matches the site the credential was saved for; the fill was stopped.',
  'denied': 'The user did not approve the credential fill.',
  'error': 'The credential operation failed in the desktop app.',
}

const FIELD_ITEMS = { type: 'string', enum: [...CREDENTIAL_FILL_FIELDS] } as const

/** The bridge face the tools need; tests substitute a stub without the IPC lifecycle. */
export type CredentialToolBridge = Pick<DesktopCredentialBridge, 'list' | 'fill'>

/**
 * Build both tool definitions bound to one bridge.
 * @param bridge - live credential channel requestor.
 * @returns the list and fill tool definitions, in registration order.
 */
export function createCredentialTools(bridge: CredentialToolBridge): readonly ToolDefinition[] {
  return [
    defineTool({
      name: CREDENTIALS_LIST_TOOL,
      description: LIST_DESCRIPTION,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            site: { type: 'string', description: 'Origin of the current browser tab the entries match.' },
            entries: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  label: { type: 'string', required: true },
                  username: { type: 'string', required: true },
                  hasTotp: { type: 'boolean', required: true },
                },
              },
            },
            error: { type: 'string', enum: [...Object.keys(ERROR_MESSAGES)] },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.error !== undefined
            ? ERROR_MESSAGES[value.error as CredentialRequestError]
            : (value.entries ?? []).length === 0
              ? `No saved credentials match ${value.site ?? 'the current page'}.`
              : `Credentials for ${value.site ?? 'the current page'}:\n`
                + (value.entries ?? []).map(entry =>
                  `- ${entry.label} (id: ${entry.id}, username: ${entry.username}${entry.hasTotp ? ', one-time code available' : ''})`).join('\n'),
        }],
      },
      async execute(_args, exec) {
        const result = await bridge.list(exec.signal)
        if (!result.ok) return { error: result.error }
        return {
          site: result.site,
          entries: result.entries.map(({ id, label, username, hasTotp }) => ({ id, label, username, hasTotp })),
        }
      },
      presentCall: () => ({ card: 'generic', title: 'List site credentials', kind: 'read' }),
    }),
    defineTool({
      name: CREDENTIALS_FILL_TOOL,
      description: FILL_DESCRIPTION,
      parameters: {
        credentialId: {
          type: 'string',
          required: true,
          description: 'Entry id from credentials_list.',
        },
        fields: {
          type: 'array',
          required: true,
          description: 'Non-empty subset of fields to fill: username, password, totp.',
          items: FIELD_ITEMS,
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            filled: { type: 'array', required: true, items: FIELD_ITEMS },
            notFound: { type: 'array', required: true, items: FIELD_ITEMS },
            error: { type: 'string', enum: [...Object.keys(ERROR_MESSAGES)] },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.error !== undefined
            ? ERROR_MESSAGES[value.error as CredentialRequestError]
            : [
              value.filled.length === 0 ? '' : `Filled: ${value.filled.join(', ')}.`,
              value.notFound.length === 0 ? '' : `No matching input found on the page for: ${value.notFound.join(', ')}.`,
            ].filter(part => part !== '').join(' ') || 'Nothing was filled.',
        }],
      },
      async execute(args, exec) {
        const fields = [...new Set(args.fields)]
        if (fields.length === 0) throw new Error('invalid arguments: `fields` must name at least one field')
        const result = await bridge.fill(credentialId(args.credentialId), fields, exec.signal)
        if (!result.ok) return { filled: [], notFound: [], error: result.error }
        return { filled: [...result.filled], notFound: [...result.notFound] }
      },
      presentCall: args => ({ card: 'generic', title: 'Fill credential', kind: 'other',
        rawInput: { credentialId: args.credentialId, fields: args.fields } }),
    }),
  ]
}

/** Re-export the port contract so consumers import one module. */
export type { CredentialBridgePort }
