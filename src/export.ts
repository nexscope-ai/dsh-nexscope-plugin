/**
 * Local conversion helpers for Nexscope results.
 *
 * Nexscope answers arrive as JSON. The original CLI exposed a small `export`
 * command so a JSON list could become a CSV deliverable without another paid
 * call; this module keeps that behavior available to the agent.
 *
 * @module dsh-nexscope/export
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Supported deliverable formats. */
export type ExportFormat = 'csv' | 'json' | 'jsonl'

/** One converted deliverable. */
export interface ExportResult {
  readonly text: string
  readonly rows: number
  readonly columns?: readonly string[]
}

/** Minimal filesystem surface used when the harness provides one. */
interface FsLike {
  resolve(path: string, options: Record<string, unknown>): Promise<unknown>
  readText(target: unknown, signal?: AbortSignal): Promise<string>
  writeText(
    target: unknown,
    content: string,
    intent?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<unknown>
}

/**
 * Resolve a dot or JSON-Pointer path inside a decoded JSON value.
 * @param root - decoded JSON value.
 * @param path - `data.items`, `/data/items`, `$`, or an empty string.
 * @returns the selected value.
 */
export function selectJsonPath(root: unknown, path: string): unknown {
  let expression = path.trim()
  if (expression === '' || expression === '$') return root
  if (expression.startsWith('$')) expression = expression.slice(1)
  if (expression.startsWith('.')) expression = expression.slice(1)
  const segments = expression.startsWith('/')
    ? expression
        .slice(1)
        .split('/')
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    : expression.split('.').filter((segment) => segment !== '')
  let current: unknown = root
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^\d+$/u.test(segment)) {
        throw new Error(`The path segment "${segment}" is not an array index.`)
      }
      current = current[Number(segment)]
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[segment]
    } else {
      throw new Error(`The path "${path}" does not exist in this result.`)
    }
    if (current === undefined) {
      throw new Error(`The path "${path}" does not exist in this result.`)
    }
  }
  return current
}

/** Render one CSV cell. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value)
}

/** Quote one CSV cell when it needs quoting. */
function quote(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/** Collect the union of object keys in first-seen order. */
function collectColumns(rows: readonly unknown[]): string[] {
  const seen = new Set<string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue
    for (const key of Object.keys(row)) seen.add(key)
  }
  return [...seen]
}

/**
 * Convert an array of records into CSV text.
 * @param value - the selected JSON value; must be an array.
 * @param columns - optional explicit column order.
 * @returns CSV text and the resolved column list.
 */
export function toCsv(
  value: unknown,
  columns?: readonly string[],
): { text: string; rows: number; columns: string[] } {
  if (!Array.isArray(value)) {
    throw new Error(
      'CSV export needs an array. Select the array with `path`, or export the whole result as JSON.',
    )
  }
  const rows = value as readonly unknown[]
  const objectRows = rows.some(
    (row) => typeof row === 'object' && row !== null && !Array.isArray(row),
  )
  const header = columns !== undefined && columns.length > 0
    ? [...columns]
    : objectRows
      ? collectColumns(rows)
      : ['value']
  const lines = [header.map((name) => quote(name)).join(',')]
  for (const row of rows) {
    if (objectRows && typeof row === 'object' && row !== null && !Array.isArray(row)) {
      const record = row as Record<string, unknown>
      lines.push(header.map((name) => quote(cell(record[name]))).join(','))
    } else {
      lines.push(quote(cell(row)))
    }
  }
  return { text: `${lines.join('\n')}\n`, rows: rows.length, columns: header }
}

/**
 * Convert a selected value into the requested deliverable format.
 * @param value - selected JSON value.
 * @param format - `csv`, `json`, or `jsonl`.
 * @param columns - optional CSV column order.
 * @returns serialized text and a short shape summary.
 */
export function serializeExport(
  value: unknown,
  format: ExportFormat,
  columns?: readonly string[],
): ExportResult {
  if (format === 'json') {
    const rows = Array.isArray(value) ? value.length : 1
    return { text: `${JSON.stringify(value, null, 2)}\n`, rows }
  }
  if (format === 'jsonl') {
    const rows = Array.isArray(value) ? value : [value]
    return { text: rows.map((row) => JSON.stringify(row)).join('\n') + '\n', rows: rows.length }
  }
  const csv = toCsv(value, columns)
  return { text: csv.text, rows: csv.rows, columns: csv.columns }
}

/** Read a workspace file, preferring the harness filesystem service. */
async function readSource(
  ctx: Context,
  path: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const fs = (ctx as Context & { fs?: FsLike }).fs
  if (fs !== undefined) {
    const target = await fs.resolve(path, { cwd, signal })
    return fs.readText(target, signal)
  }
  return readFile(path, 'utf8')
}

/** Write a workspace file, preferring the harness filesystem service. */
async function writeTarget(
  ctx: Context,
  path: string,
  cwd: string,
  text: string,
  signal: AbortSignal,
): Promise<void> {
  const fs = (ctx as Context & { fs?: FsLike }).fs
  if (fs !== undefined) {
    const target = await fs.resolve(path, { cwd, signal })
    await fs.writeText(target, text, undefined, signal)
    return
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

/** Reject a relative path that would escape the working directory. */
export function assertInsideWorkspace(path: string, cwd: string): string {
  if (isAbsolute(path)) return path
  const resolved = resolve(cwd, path)
  const root = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`
  if (resolved !== cwd && !resolved.startsWith(root)) {
    throw new Error(`The output path "${path}" escapes the working directory.`)
  }
  return resolved
}

/**
 * Read the source JSON, convert it, and write the deliverable.
 * @param ctx - plugin context, used for the filesystem service when present.
 * @param options - input and output description from the tool call.
 * @param signal - caller cancellation.
 * @returns the written path and a short shape summary.
 */
export async function exportDeliverable(
  ctx: Context,
  options: {
    readonly input?: string | undefined
    readonly json?: string | undefined
    readonly path?: string | undefined
    readonly output: string
    readonly format: ExportFormat
    readonly columns?: readonly string[] | undefined
    readonly cwd?: string | undefined
  },
  signal: AbortSignal,
): Promise<{ output: string; rows: number; columns?: readonly string[]; bytes: number }> {
  const cwd = options.cwd ?? process.cwd()
  if ((options.input === undefined) === (options.json === undefined)) {
    throw new Error('Provide exactly one of `input` (a JSON file path) or `json` (inline JSON).')
  }
  const raw =
    options.input !== undefined
      ? await readSource(ctx, assertInsideWorkspace(options.input, cwd), cwd, signal)
      : options.json ?? ''
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch (error) {
    throw new Error(`The source is not valid JSON: ${(error as Error).message}`)
  }
  const selected = options.path === undefined || options.path.trim() === ''
    ? decoded
    : selectJsonPath(decoded, options.path)
  const converted = serializeExport(selected, options.format, options.columns)
  const output = assertInsideWorkspace(options.output, cwd)
  await writeTarget(ctx, output, cwd, converted.text, signal)
  return {
    output: options.output,
    rows: converted.rows,
    ...(converted.columns === undefined ? {} : { columns: converted.columns }),
    bytes: Buffer.byteLength(converted.text, 'utf8'),
  }
}
