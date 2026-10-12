/** Chat-owned approval detail resolving a correlated Tool call's command or structured arguments. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { ApprovalArgs } from './ApprovalArgs.tsx'

interface ApprovalToolCall {
  readonly callId: string
  readonly argsRaw: string
}

/**
 * Parse a correlated Tool call's raw arguments as a non-empty JSON object.
 * @param call - Tool call arguments, when a correlated call exists.
 * @returns the argument record, or undefined for absent, malformed, non-object, or empty arguments.
 */
function parsedArgsOf(call: ApprovalToolCall | undefined): Record<string, unknown> | undefined {
  if (call === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(call.argsRaw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const args = parsed as Record<string, unknown>
  return Object.keys(args).length === 0 ? undefined : args
}

/**
 * Extract a shell command from a correlated Tool call when its arguments carry one.
 * @param call - Tool call arguments, when a correlated call exists.
 * @returns command text, or undefined for absent, malformed, or unrelated arguments.
 */
export function commandOf(call: ApprovalToolCall | undefined): string | undefined {
  const args = parsedArgsOf(call)
  return typeof args?.command === 'string' ? args.command : undefined
}

/** Composed props of the approval-detail entry: correlated call identity plus the Chat translate seat. */
type ApprovalDetailProps = PropsRuntime<'conversation.approval.detail'> & PropsLocale<'chat'>

/**
 * Render the command or structured arguments of the Chat Tool node correlated with an approval.
 * @param props - Approval identity, Session-standard Chat selector hook, and Chat translate seat.
 * @returns command text, structured argument detail, or null when the call carries neither.
 */
export function ApprovalCommand({ callId, useChat, t }: ApprovalDetailProps) {
  const argsRaw = useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      const root = node.kind === 'tool-call' ? (node as ChatNode<'tool-call'>).data.root : undefined
      if (root !== undefined && root.callId === callId && !('kind' in root) && root.phase === 'start') return root.argsRaw
    }
    return undefined
  })
  if (argsRaw === undefined) return null
  const args = parsedArgsOf({ callId, argsRaw })
  if (args === undefined) return null
  if (typeof args.command === 'string') return args.command
  return <ApprovalArgs args={args} t={t} />
}
