/** Structured Tool-argument detail for approvals whose correlated call carries no shell command. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ApprovalArgs.module.css'

/** Longest single displayed string, in code points, before it is cut and marked with an ellipsis. */
const MAX_TEXT_LENGTH = 200

/** Most object-array rows a table renders before the omitted-row notice. */
const MAX_TABLE_ROWS = 50

/** Most object-array columns a table renders before the omitted-column notice. */
const MAX_TABLE_COLUMNS = 20

/** Most scalar-array items one line joins before the omitted-item notice. */
const MAX_ARRAY_ITEMS = 50

/** Most top-level argument fields rendered before the omitted-field notice. */
const MAX_FIELDS = 50

/** Compact-JSON length at which nested-value serialization stops instead of materializing the full text. */
const MAX_JSON_LENGTH = 2000

/** Translate seat of the Chat namespace, as delivered to the approval-detail entry. */
type ChatTranslate = TranslateNS<'chat'>

/** Locale keys of the omission notices, each split into one/other forms. */
type OmittedKey =
  | 'approval.args.omittedRows'
  | 'approval.args.omittedItems'
  | 'approval.args.omittedFields'
  | 'approval.args.omittedColumns'

/** One keyed line of display text: a top-level scalar, scalar array, or compact JSON value. */
interface TextSection {
  readonly kind: 'text'
  readonly key: string
  readonly value: string
}

/** One keyed table whose columns are the union of the object rows' keys. */
interface TableSection {
  readonly kind: 'table'
  readonly key: string
  readonly columns: readonly string[]
  readonly rows: readonly (readonly string[])[]
  /** Object rows beyond the rendered limit. */
  readonly omitted: number
  /** Union columns beyond the rendered limit. */
  readonly omittedColumns: number
}

/** Display section of one argument field, in argument order. */
type Section = TextSection | TableSection

/**
 * Locale key of one omission notice for a count.
 * @param key - notice key base.
 * @param count - omitted count.
 * @returns the one/other dictionary key of the count.
 */
function omittedKeyOf(key: OmittedKey, count: number): `${OmittedKey}.one` | `${OmittedKey}.other` {
  return count === 1 ? `${key}.one` : `${key}.other`
}

/**
 * Cut one displayed string at the code-point limit without splitting a surrogate pair.
 * @param text - display text.
 * @returns the text unchanged, or its first code points plus an ellipsis.
 */
function displayText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text
  let cut = ''
  let count = 0
  for (const point of text) {
    if (count === MAX_TEXT_LENGTH) return `${cut}…`
    cut += point
    count += 1
  }
  return text
}

/**
 * Test whether a value is a JSON object rather than null or an array.
 * @param value - parsed argument value.
 * @returns whether the value is a plain-object record.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Escape one string character as compact-JSON text.
 * @param char - one character of a serialized string.
 * @returns the escaped form.
 */
function escapeChar(char: string): string {
  switch (char) {
    case '"': return '\\"'
    case '\\': return '\\\\'
    case '\b': return '\\b'
    case '\f': return '\\f'
    case '\n': return '\\n'
    case '\r': return '\\r'
    case '\t': return '\\t'
    default: return char < '\u0020' ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : char
  }
}

/**
 * Compact-JSON text for one nested value. Serialization stops once the output
 * reaches {@link MAX_JSON_LENGTH} instead of materializing the full text first.
 * @param value - one JSON value.
 * @returns compact JSON text, cut with an ellipsis when the bound stops it.
 */
function compactJson(value: unknown): string {
  let out = ''
  const limit = (): boolean => out.length >= MAX_JSON_LENGTH
  const writeString = (text: string): boolean => {
    out += '"'
    for (const char of text) {
      if (limit()) return false
      out += escapeChar(char)
    }
    out += '"'
    return true
  }
  const serialize = (node: unknown): boolean => {
    if (limit()) return false
    if (typeof node === 'string') return writeString(node)
    if (typeof node === 'number' || typeof node === 'boolean') {
      out += String(node)
      return true
    }
    if (node === null) {
      out += 'null'
      return true
    }
    if (Array.isArray(node)) {
      out += '['
      let first = true
      for (const item of node) {
        if (!first) out += ','
        first = false
        if (!serialize(item)) return false
      }
      out += ']'
      return true
    }
    out += '{'
    let first = true
    for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
      if (!first) out += ','
      first = false
      if (!writeString(key)) return false
      out += ':'
      if (!serialize(item)) return false
    }
    out += '}'
    return true
  }
  return serialize(value) ? out : `${out}…`
}

/**
 * Render a scalar value as display text.
 * @param value - one JSON value.
 * @param separator - locale join between scalar-array items.
 * @param omittedNotice - locale text for the scalar-array items beyond the join limit.
 * @returns display text, or undefined for values that render as compact JSON.
 */
function scalarText(
  value: unknown,
  separator: string,
  omittedNotice: (count: number) => string,
): string | undefined {
  if (typeof value === 'string') return displayText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  if (Array.isArray(value) && value.length > 0
    && value.every(item => item === null || typeof item !== 'object')) {
    const shown = value.slice(0, MAX_ARRAY_ITEMS).map(item => displayText(String(item)))
    return value.length <= MAX_ARRAY_ITEMS
      ? shown.join(separator)
      : `${shown.join(separator)}${separator}${omittedNotice(value.length - MAX_ARRAY_ITEMS)}`
  }
  return undefined
}

/**
 * Display text of one table cell.
 * @param value - the row object's own value for one column; absent keys are empty.
 * @param separator - locale join between scalar-array items.
 * @param omittedNotice - locale text for the scalar-array items beyond the join limit.
 * @returns display text.
 */
function cellText(
  value: unknown,
  separator: string,
  omittedNotice: (count: number) => string,
): string {
  if (value === undefined) return ''
  return scalarText(value, separator, omittedNotice) ?? displayText(compactJson(value))
}

/**
 * Derive the object-array table of one field value.
 * @param value - one parsed argument value.
 * @param separator - locale join between scalar-array items.
 * @param omittedNotice - locale text for the scalar-array items beyond the join limit.
 * @returns rendered columns in first-seen key order plus rows and the omitted
 * row and column counts, or undefined when the value is not a non-empty object
 * array with named columns.
 */
function tableOf(
  value: unknown,
  separator: string,
  omittedNotice: (count: number) => string,
): { columns: string[]; rows: string[][]; omitted: number; omittedColumns: number } | undefined {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isPlainObject)) return undefined
  const shown = value.slice(0, MAX_TABLE_ROWS)
  const union = [...new Set(shown.flatMap(object => Object.keys(object)))]
  if (union.length === 0) return undefined
  const columns = union.slice(0, MAX_TABLE_COLUMNS)
  return {
    columns,
    rows: shown.map(object => columns.map(
      column => cellText(Object.hasOwn(object, column) ? object[column] : undefined, separator, omittedNotice),
    )),
    omitted: value.length - shown.length,
    omittedColumns: union.length - columns.length,
  }
}

/**
 * Project parsed arguments into display sections in argument order.
 * @param args - non-empty parsed argument object.
 * @param separator - locale join between scalar-array items.
 * @param omittedNotice - locale text for the scalar-array items beyond the join limit.
 * @returns one section per rendered field plus the count of fields beyond the render limit.
 */
function sectionsOf(
  args: Readonly<Record<string, unknown>>,
  separator: string,
  omittedNotice: (count: number) => string,
): { sections: Section[]; omittedFields: number } {
  const entries = Object.entries(args)
  const shown = entries.slice(0, MAX_FIELDS)
  return {
    sections: shown.map(([key, value]) => {
      const table = tableOf(value, separator, omittedNotice)
      return table !== undefined
        ? { kind: 'table', key, ...table }
        : {
          kind: 'text',
          key,
          value: scalarText(value, separator, omittedNotice) ?? displayText(compactJson(value)),
        }
    }),
    omittedFields: entries.length - shown.length,
  }
}

/**
 * Render one approval's structured Tool arguments: scalar key-value lines,
 * object-array tables, and compact JSON for nested values.
 * @param props - parsed arguments and the Chat translate seat.
 * @param props.args - non-empty parsed argument object.
 * @param props.t - Chat dictionary translate.
 * @returns The structured argument detail.
 */
export function ApprovalArgs({ args, t }: {
  args: Readonly<Record<string, unknown>>
  t: ChatTranslate
}) {
  const separator = t('approval.args.separator')
  const omitted = (key: OmittedKey, count: number): string =>
    t(omittedKeyOf(key, count), { count })
  const { sections, omittedFields } = sectionsOf(
    args,
    separator,
    count => omitted('approval.args.omittedItems', count),
  )
  return (
    <div className={css.root}>
      {sections.map(section => section.kind === 'table'
        ? (
          <div key={section.key} className={css.tableBlock}>
            <div className={css.fieldName}>{displayText(section.key)}</div>
            <div className={css.tableScroll}>
              <table className={css.table}>
                <thead>
                  <tr>
                    {section.columns.map(column => <th key={column} scope="col">{displayText(column)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {section.rows.map((row, index) => (
                    <tr key={index}>
                      {row.map((cell, cellIndex) => <td key={section.columns[cellIndex]}>{cell}</td>)}
                    </tr>
                  ))}
                  {section.omitted > 0 && (
                    <tr>
                      <td className={css.omitted} colSpan={section.columns.length}>
                        {omitted('approval.args.omittedRows', section.omitted)}
                      </td>
                    </tr>
                  )}
                  {section.omittedColumns > 0 && (
                    <tr>
                      <td className={css.omitted} colSpan={section.columns.length}>
                        {omitted('approval.args.omittedColumns', section.omittedColumns)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
        : (
          <div key={section.key} className={css.line}>
            <span className={css.fieldName}>{displayText(section.key)}</span>
            <span className={css.pairSeparator}>{t('approval.args.pairSeparator')}</span>
            <span className={css.value}>{section.value}</span>
          </div>
        ))}
      {omittedFields > 0 && (
        <div className={css.line}>
          <span className={css.value}>{omitted('approval.args.omittedFields', omittedFields)}</span>
        </div>
      )}
    </div>
  )
}
