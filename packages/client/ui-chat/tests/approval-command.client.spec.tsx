// @vitest-environment jsdom
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ApprovalCommand, commandOf } from '../src/client/chat/ApprovalCommand.tsx'
import { en, zh } from '../src/client/locale.ts'

afterEach(() => { cleanup() })

type ApprovalDetailProps = PropsRuntime<'conversation.approval.detail'> & PropsLocale<'chat'>

type Translate = (key: string, params?: Record<string, unknown>) => string

function translator(dict: Record<string, string>): Translate {
  return (key, params) => {
    const template = dict[key] ?? key
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const value = params?.[name]
      return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
    })
  }
}

const translate = translator(zh)
const translateEn = translator(en)

function props(
  nodes: readonly unknown[],
  callId = 'call-1',
  t: Translate = translate,
): ApprovalDetailProps {
  const snapshot = {
    nodes: { values: () => nodes },
  } as unknown as ChatSnapshot
  const useChat = ((selector: (value: ChatSnapshot) => unknown) => selector(snapshot)) as UseChat
  return { callId, useChat, t } as ApprovalDetailProps
}

function callNode(args: unknown, callId = 'call-1'): unknown {
  return {
    kind: 'tool-call',
    data: { root: { phase: 'start', callId, argsRaw: JSON.stringify(args) } },
  }
}

describe('commandOf', () => {
  it('accepts only a string command from valid JSON arguments', () => {
    expect(commandOf(undefined)).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{}' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{"command":42}' })).toBeUndefined()
    expect(commandOf({ callId: 'c1', argsRaw: '{"command":"pnpm test"}' })).toBe('pnpm test')
  })
})

describe('ApprovalCommand', () => {
  it('renders the running correlated Tool command', () => {
    render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'other', argsRaw: '{"command":"wrong"}' } } },
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'call-1', argsRaw: '{"command":"pnpm test"}' } } },
    ] as never)} />)

    expect(screen.getByText('pnpm test')).toBeTruthy()
  })

  it('omits absent, uncorrelated, preparing, and settled Tool calls', () => {
    const { container, rerender } = render(<ApprovalCommand {...props([
      { kind: 'assistant-step', data: {} },
      { kind: 'tool-call', data: { root: undefined } },
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'other', argsRaw: '{}' } } },
      { kind: 'tool-call', data: { root: { phase: 'preparing', callId: 'call-1', name: 'bash' } } },
      {
        kind: 'tool-call',
        data: { root: { kind: 'tool-result', callId: 'call-1', argsRaw: '{"command":"ignored"}' } },
      },
    ] as never)} />)
    expect(container.textContent).toBe('')

    rerender(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'call-1', argsRaw: '{}' } } },
    ] as never)} />)
    expect(container.textContent).toBe('')
  })

  it('renders a batch job list as a table with a scalar key-value line', () => {
    render(<ApprovalCommand {...props([
      callNode({
        month: '2026-09',
        jobs: [
          {
            storeId: 's1', storeName: 'Store A', marketplaces: ['US', 'CA'],
            reports: ['transaction_view', 'statement_view'],
          },
          { storeId: 's2', storeName: 'Store B', marketplaces: ['UK'], reports: ['fba_inventory'] },
        ],
      }),
    ])} />)

    expect(screen.getByText('month')).toBeTruthy()
    expect(screen.getByText('2026-09')).toBeTruthy()
    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['storeId', 'storeName', 'marketplaces', 'reports'])
    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(3)
    expect(rows[1]?.textContent).toBe('s1Store AUS、CAtransaction_view、statement_view')
    expect(rows[2]?.textContent).toBe('s2Store BUKfba_inventory')
  })

  it('keeps command output when the arguments also carry other fields', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({ command: 'pnpm test', jobs: [{ storeId: 's1' }] }),
    ])} />)

    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
    expect(container.textContent).toBe('pnpm test')
  })

  it('truncates over-long string values in lines, arrays, and JSON text', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({
        note: 'x'.repeat(250),
        list: ['y'.repeat(260)],
        nested: { text: 'z'.repeat(230) },
      }),
    ])} />)

    expect(container.textContent).toContain(`${'x'.repeat(200)}…`)
    expect(container.textContent).toContain(`${'y'.repeat(200)}…`)
    expect(container.textContent).toContain(`{"text":"${'z'.repeat(191)}…`)
    expect(container.textContent).not.toContain('x'.repeat(201))
    expect(container.textContent).not.toContain('y'.repeat(201))
    expect(container.textContent).not.toContain('z'.repeat(201))
  })

  it('renders at most 50 table rows and reports the omitted count', () => {
    const jobs = Array.from({ length: 60 }, (_, index) => ({ storeId: `s${index}` }))
    render(<ApprovalCommand {...props([callNode({ jobs })])} />)

    expect(screen.getAllByRole('row')).toHaveLength(52)
    expect(screen.getByText('省略 10 行')).toBeTruthy()
    expect(screen.getByText('s49')).toBeTruthy()
    expect(screen.queryByText('s50')).toBeNull()
    expect(screen.queryByText('s59')).toBeNull()
  })

  it('unions table columns in first-seen order and renders nested cells as compact JSON', () => {
    render(<ApprovalCommand {...props([
      callNode({
        jobs: [
          { storeId: 's1', detail: { retries: 2 } },
          { storeName: 'Store B', storeId: 's2', tags: ['a', 'b'] },
        ],
      }),
    ])} />)

    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['storeId', 'detail', 'storeName', 'tags'])
    const rows = screen.getAllByRole('row')
    expect(rows[1]?.textContent).toBe('s1{"retries":2}')
    expect(rows[2]?.textContent).toBe('s2Store Ba、b')
  })

  it('renders scalar fields and scalar arrays inline', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({
        reports: ['transaction_view', 'statement_view'],
        enabled: true,
        retries: 2,
        missing: null,
        scope: { storeIds: ['s1'] },
      }),
    ])} />)

    expect(container.textContent).toContain('reports：transaction_view、statement_view')
    expect(container.textContent).toContain('enabled：true')
    expect(container.textContent).toContain('retries：2')
    expect(container.textContent).toContain('missing：null')
    expect(container.textContent).toContain('scope：{"storeIds":["s1"]}')
  })

  it('falls back to compact JSON for empty arrays and object arrays without columns', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({ tags: [], jobs: [{}, {}] }),
    ])} />)

    expect(container.textContent).toContain('tags：[]')
    expect(container.textContent).toContain('jobs：[{},{}]')
  })

  it('omits non-object arguments and renders mixed arrays as compact JSON', () => {
    const empty = render(<ApprovalCommand {...props([callNode({})])} />)
    expect(empty.container.textContent).toBe('')
    const malformed = render(<ApprovalCommand {...props([
      { kind: 'tool-call', data: { root: { phase: 'start', callId: 'call-1', argsRaw: '{' } } },
    ])} />)
    expect(malformed.container.textContent).toBe('')
    const array = render(<ApprovalCommand {...props([callNode([1, 2])])} />)
    expect(array.container.textContent).toBe('')
    const primitive = render(<ApprovalCommand {...props([callNode(42)])} />)
    expect(primitive.container.textContent).toBe('')
    const nullArgs = render(<ApprovalCommand {...props([callNode(null)])} />)
    expect(nullArgs.container.textContent).toBe('')
    const mixed = render(<ApprovalCommand {...props([callNode({ items: [1, { a: 2 }] })])} />)
    expect(mixed.container.textContent).toContain('items：[1,{"a":2}]')
  })
})

describe('approval argument bounds', () => {
  it('reads table cells from own properties only, so prototype-named columns cannot crash rendering', () => {
    const jobs = JSON.parse(`[
      {"storeId":"s1","constructor":"C","toString":"T","__proto__":"P"},
      {"storeId":"s2"}
    ]`) as unknown
    render(<ApprovalCommand {...props([callNode({ jobs })])} />)

    expect(screen.getAllByRole('columnheader').map(cell => cell.textContent))
      .toEqual(['storeId', 'constructor', 'toString', '__proto__'])
    const rows = screen.getAllByRole('row')
    expect(rows[1]?.textContent).toBe('s1CTP')
    expect(rows[2]?.textContent).toBe('s2')
  })

  it('joins at most 50 scalar-array items and reports the omitted count', () => {
    const tags = Array.from({ length: 60 }, (_, index) => `t${index}`)
    const { container } = render(<ApprovalCommand {...props([callNode({ tags })])} />)

    expect(container.textContent).toContain('t0、')
    expect(container.textContent).toContain('t49、省略 10 项')
    expect(container.textContent).not.toContain('t50')
  })

  it('renders at most 50 top-level fields and reports the omitted count', () => {
    const args = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${index}`, index]))
    const { container } = render(<ApprovalCommand {...props([callNode(args)])} />)

    expect(container.textContent).toContain('f49：49')
    expect(container.textContent).toContain('省略 10 个字段')
    expect(container.textContent).not.toContain('f50')
  })

  it('renders at most 20 table columns and reports the omitted count', () => {
    const job = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`c${index}`, index]))
    render(<ApprovalCommand {...props([callNode({ jobs: [job] })])} />)

    expect(screen.getAllByRole('columnheader')).toHaveLength(20)
    expect(screen.getByText('省略 5 列')).toBeTruthy()
    expect(screen.queryByText('c20')).toBeNull()
  })

  it('truncates over-long field names and column names', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({ ['k'.repeat(250)]: 'v', jobs: [{ ['c'.repeat(250)]: 1 }] }),
    ])} />)

    expect(container.textContent).toContain(`${'k'.repeat(200)}…`)
    expect(container.textContent).not.toContain('k'.repeat(201))
    expect(container.textContent).toContain(`${'c'.repeat(200)}…`)
    expect(container.textContent).not.toContain('c'.repeat(201))
  })

  it('stops compact-JSON serialization at the length bound for objects and arrays', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({
        nested: { a: 'x'.repeat(1500), b: 'y'.repeat(1500) },
        list: [['p'.repeat(1500)], ['q'.repeat(1500)]],
      }),
    ])} />)

    expect(container.textContent).toContain(`{"a":"${'x'.repeat(194)}…`)
    expect(container.textContent).toContain(`[["${'p'.repeat(197)}…`)
    expect(container.textContent).not.toContain('y')
    expect(container.textContent).not.toContain('q')
  })

  it('escapes nested JSON strings and serializes nested nulls', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({ nested: { s: 'a"b\\c\bd\fe\nf\rr\ti\u0001z', n: null } }),
    ])} />)

    expect(container.textContent).toContain('"a\\"b\\\\c\\bd\\fe\\nf\\rr\\ti\\u0001z"')
    expect(container.textContent).toContain('"n":null')
  })

  it('keeps strings whose code-point count is within the limit untruncated', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({ emoji: '😀'.repeat(150) }),
    ])} />)

    expect(container.textContent).toContain('😀'.repeat(150))
    expect(container.textContent).not.toContain('…')
  })

  it('stops serialization when a key or a later value overruns the length bound', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({
        nested: { a: 'x'.repeat(1500), b: 'y'.repeat(1500), c: 'z'.repeat(1500) },
        keyed: { ['w'.repeat(2500)]: 1 },
      }),
    ])} />)

    expect(container.textContent).toContain(`{"a":"${'x'.repeat(194)}…`)
    expect(container.textContent).toContain(`{"${'w'.repeat(198)}…`)
    expect(container.textContent).not.toContain('z')
  })

  it('short-circuits serialization of elements after the length bound is reached', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({ list: [['x'.repeat(1997)], ['z']] }),
    ])} />)

    expect(container.textContent).toContain(`[["${'x'.repeat(197)}…`)
    expect(container.textContent).not.toContain('"z"')
  })

  it('cuts truncation at code-point boundaries without splitting surrogate pairs', () => {
    const { container } = render(<ApprovalCommand {...props([
      callNode({ emoji: '😀'.repeat(250) }),
    ])} />)

    expect(container.textContent).toContain(`${'😀'.repeat(200)}…`)
    expect(container.textContent).not.toContain('\uFFFD')
  })

  it('selects the one/other plural key of an omission notice by count', () => {
    const keys: string[] = []
    const recording: Translate = (key, params) => {
      keys.push(key)
      return translate(key, params)
    }
    const jobs = Array.from({ length: 51 }, (_, index) => ({ storeId: `s${index}` }))
    render(<ApprovalCommand {...props([callNode({ jobs })], 'call-1', recording)} />)

    expect(keys).toContain('approval.args.omittedRows.one')
    expect(screen.getByText('省略 1 行')).toBeTruthy()
  })

  it('renders the English omission notices in singular and plural forms', () => {
    const job = render(<ApprovalCommand {...props([callNode({
      jobs: Array.from({ length: 51 }, (_, index) => ({ storeId: `s${index}` })),
      tags: ['a'],
    })], 'call-1', translateEn)} />)

    expect(job.container.textContent).toContain('1 row omitted')
    const many = render(<ApprovalCommand {...props([callNode({
      jobs: Array.from({ length: 60 }, (_, index) => ({ storeId: `s${index}` })),
    })], 'call-1', translateEn)} />)

    expect(many.container.textContent).toContain('10 rows omitted')
  })
})
