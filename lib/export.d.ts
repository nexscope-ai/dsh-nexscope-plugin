import type { Context } from '@deepseek-ai/cordis';
/** Supported deliverable formats. */
export type ExportFormat = 'csv' | 'json' | 'jsonl';
/** One converted deliverable. */
export interface ExportResult {
    readonly text: string;
    readonly rows: number;
    readonly columns?: readonly string[];
}
/**
 * Resolve a dot or JSON-Pointer path inside a decoded JSON value.
 * @param root - decoded JSON value.
 * @param path - `data.items`, `/data/items`, `$`, or an empty string.
 * @returns the selected value.
 */
export declare function selectJsonPath(root: unknown, path: string): unknown;
/**
 * Convert an array of records into CSV text.
 * @param value - the selected JSON value; must be an array.
 * @param columns - optional explicit column order.
 * @returns CSV text and the resolved column list.
 */
export declare function toCsv(value: unknown, columns?: readonly string[]): {
    text: string;
    rows: number;
    columns: string[];
};
/**
 * Convert a selected value into the requested deliverable format.
 * @param value - selected JSON value.
 * @param format - `csv`, `json`, or `jsonl`.
 * @param columns - optional CSV column order.
 * @returns serialized text and a short shape summary.
 */
export declare function serializeExport(value: unknown, format: ExportFormat, columns?: readonly string[]): ExportResult;
/** Reject a relative path that would escape the working directory. */
export declare function assertInsideWorkspace(path: string, cwd: string): string;
/**
 * Read the source JSON, convert it, and write the deliverable.
 * @param ctx - plugin context, used for the filesystem service when present.
 * @param options - input and output description from the tool call.
 * @param signal - caller cancellation.
 * @returns the written path and a short shape summary.
 */
export declare function exportDeliverable(ctx: Context, options: {
    readonly input?: string | undefined;
    readonly json?: string | undefined;
    readonly path?: string | undefined;
    readonly output: string;
    readonly format: ExportFormat;
    readonly columns?: readonly string[] | undefined;
    readonly cwd?: string | undefined;
}, signal: AbortSignal): Promise<{
    output: string;
    rows: number;
    columns?: readonly string[];
    bytes: number;
}>;
