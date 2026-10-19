/**
 * Local conversion helpers for Nexscope results.
 *
 * Nexscope answers arrive as JSON. The original CLI exposed a small `export`
 * command so a JSON list could become a CSV deliverable without another paid
 * call; this module keeps that behavior available to the agent.
 *
 * @module dsh-nexscope/export
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
/**
 * Resolve a dot or JSON-Pointer path inside a decoded JSON value.
 * @param root - decoded JSON value.
 * @param path - `data.items`, `/data/items`, `$`, or an empty string.
 * @returns the selected value.
 */
export function selectJsonPath(root, path) {
    let expression = path.trim();
    if (expression === '' || expression === '$')
        return root;
    if (expression.startsWith('$'))
        expression = expression.slice(1);
    if (expression.startsWith('.'))
        expression = expression.slice(1);
    const segments = expression.startsWith('/')
        ? expression
            .slice(1)
            .split('/')
            .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
        : expression.split('.').filter((segment) => segment !== '');
    let current = root;
    for (const segment of segments) {
        if (Array.isArray(current)) {
            if (!/^\d+$/u.test(segment)) {
                throw new Error(`The path segment "${segment}" is not an array index.`);
            }
            current = current[Number(segment)];
        }
        else if (typeof current === 'object' && current !== null) {
            current = current[segment];
        }
        else {
            throw new Error(`The path "${path}" does not exist in this result.`);
        }
        if (current === undefined) {
            throw new Error(`The path "${path}" does not exist in this result.`);
        }
    }
    return current;
}
/** Render one CSV cell. */
function cell(value) {
    if (value === null || value === undefined)
        return '';
    if (typeof value === 'string')
        return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return String(value);
    }
    return JSON.stringify(value);
}
/** Quote one CSV cell when it needs quoting. */
function quote(value) {
    return /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
/** Collect the union of object keys in first-seen order. */
function collectColumns(rows) {
    const seen = new Set();
    for (const row of rows) {
        if (typeof row !== 'object' || row === null || Array.isArray(row))
            continue;
        for (const key of Object.keys(row))
            seen.add(key);
    }
    return [...seen];
}
/**
 * Convert an array of records into CSV text.
 * @param value - the selected JSON value; must be an array.
 * @param columns - optional explicit column order.
 * @returns CSV text and the resolved column list.
 */
export function toCsv(value, columns) {
    if (!Array.isArray(value)) {
        throw new Error('CSV export needs an array. Select the array with `path`, or export the whole result as JSON.');
    }
    const rows = value;
    const objectRows = rows.some((row) => typeof row === 'object' && row !== null && !Array.isArray(row));
    const header = columns !== undefined && columns.length > 0
        ? [...columns]
        : objectRows
            ? collectColumns(rows)
            : ['value'];
    const lines = [header.map((name) => quote(name)).join(',')];
    for (const row of rows) {
        if (objectRows && typeof row === 'object' && row !== null && !Array.isArray(row)) {
            const record = row;
            lines.push(header.map((name) => quote(cell(record[name]))).join(','));
        }
        else {
            lines.push(quote(cell(row)));
        }
    }
    return { text: `${lines.join('\n')}\n`, rows: rows.length, columns: header };
}
/**
 * Convert a selected value into the requested deliverable format.
 * @param value - selected JSON value.
 * @param format - `csv`, `json`, or `jsonl`.
 * @param columns - optional CSV column order.
 * @returns serialized text and a short shape summary.
 */
export function serializeExport(value, format, columns) {
    if (format === 'json') {
        const rows = Array.isArray(value) ? value.length : 1;
        return { text: `${JSON.stringify(value, null, 2)}\n`, rows };
    }
    if (format === 'jsonl') {
        const rows = Array.isArray(value) ? value : [value];
        return { text: rows.map((row) => JSON.stringify(row)).join('\n') + '\n', rows: rows.length };
    }
    const csv = toCsv(value, columns);
    return { text: csv.text, rows: csv.rows, columns: csv.columns };
}
/** Read a workspace file, preferring the harness filesystem service. */
async function readSource(ctx, path, cwd, signal) {
    const fs = ctx.fs;
    if (fs !== undefined) {
        const target = await fs.resolve(path, { cwd, signal });
        return fs.readText(target, signal);
    }
    return readFile(path, 'utf8');
}
/** Write a workspace file, preferring the harness filesystem service. */
async function writeTarget(ctx, path, cwd, text, signal) {
    const fs = ctx.fs;
    if (fs !== undefined) {
        const target = await fs.resolve(path, { cwd, signal });
        await fs.writeText(target, text, undefined, signal);
        return;
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
}
/** Reject a relative path that would escape the working directory. */
export function assertInsideWorkspace(path, cwd) {
    if (isAbsolute(path))
        return path;
    const resolved = resolve(cwd, path);
    const root = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`;
    if (resolved !== cwd && !resolved.startsWith(root)) {
        throw new Error(`The output path "${path}" escapes the working directory.`);
    }
    return resolved;
}
/**
 * Read the source JSON, convert it, and write the deliverable.
 * @param ctx - plugin context, used for the filesystem service when present.
 * @param options - input and output description from the tool call.
 * @param signal - caller cancellation.
 * @returns the written path and a short shape summary.
 */
export async function exportDeliverable(ctx, options, signal) {
    const cwd = options.cwd ?? process.cwd();
    if ((options.input === undefined) === (options.json === undefined)) {
        throw new Error('Provide exactly one of `input` (a JSON file path) or `json` (inline JSON).');
    }
    const raw = options.input !== undefined
        ? await readSource(ctx, assertInsideWorkspace(options.input, cwd), cwd, signal)
        : options.json ?? '';
    let decoded;
    try {
        decoded = JSON.parse(raw);
    }
    catch (error) {
        throw new Error(`The source is not valid JSON: ${error.message}`);
    }
    const selected = options.path === undefined || options.path.trim() === ''
        ? decoded
        : selectJsonPath(decoded, options.path);
    const converted = serializeExport(selected, options.format, options.columns);
    const output = assertInsideWorkspace(options.output, cwd);
    await writeTarget(ctx, output, cwd, converted.text, signal);
    return {
        output: options.output,
        rows: converted.rows,
        ...(converted.columns === undefined ? {} : { columns: converted.columns }),
        bytes: Buffer.byteLength(converted.text, 'utf8'),
    };
}
