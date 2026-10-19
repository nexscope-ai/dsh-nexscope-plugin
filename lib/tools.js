import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { SignInRequiredError, describe } from './oauth.js';
import { exportDeliverable } from './export.js';
/** Default number of search matches. */
const DEFAULT_LIMIT = 10;
/** Hard cap on search matches. */
const MAX_LIMIT = 25;
/** Tools this plugin owns, which an upstream tool must never shadow. */
export const OWNED_TOOLS = [
    'nexscope_sign_in',
    'nexscope_status',
    'nexscope_find_tools',
    'nexscope_describe_tool',
    'nexscope_call_tool',
    'nexscope_export',
    'nexscope_account',
];
/** Render MCP content blocks as model text. */
export function renderContent(content) {
    const parts = [];
    for (const block of content) {
        switch (block.type) {
            case 'text':
                parts.push(block.text);
                break;
            case 'resource_link':
                parts.push(`[${block.name}](${block.uri})`);
                break;
            case 'image':
                parts.push('[image content]');
                break;
            case 'audio':
                parts.push('[audio content]');
                break;
            case 'resource':
                parts.push(`[resource] ${block.resource.uri}`);
                break;
            default:
                parts.push('[unsupported content]');
        }
    }
    return parts.join('\n\n');
}
/** Lossless JSON copy of an upstream value. */
export function jsonify(value) {
    return JSON.parse(JSON.stringify(value ?? null));
}
/** The complete value returned to the model for one upstream call. */
function canonicalValue(result) {
    return jsonify({
        ...(result.structuredContent === undefined
            ? {}
            : { structuredContent: result.structuredContent }),
        content: result.content,
        ...(result.isError === true ? { isError: true } : {}),
    });
}
/** Model-facing failure text for a plugin or transport error. */
export function failureText(error) {
    if (error instanceof SignInRequiredError) {
        return [
            'The Nexscope account is not connected.',
            'Call nexscope_sign_in to open the browser sign-in, then retry this call.',
        ].join(' ');
    }
    return `The Nexscope request failed: ${describe(error)}`;
}
/** Score one tool against query words, preferring name matches. */
export function scoreTool(tool, words) {
    const name = tool.name.toLowerCase();
    const description = (tool.description ?? '').toLowerCase();
    let score = 0;
    for (const word of words) {
        if (name.includes(word))
            score += 3;
        else if (description.includes(word))
            score += 1;
    }
    return score;
}
/** Split a query into lowercase words. */
function words(query) {
    return query
        .toLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((word) => word.length > 0);
}
/** Coerce model-supplied arguments into a plain object. */
function asArguments(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
/** Register the Nexscope tools on one registry. */
export class NexscopeTools {
    ctx;
    client;
    oauth;
    config;
    disposers = [];
    catalog;
    constructor(ctx, client, oauth, config) {
        this.ctx = ctx;
        this.client = client;
        this.oauth = oauth;
        this.config = config;
    }
    /** Register every owned tool. */
    install(tools = this.ctx.tools) {
        for (const definition of this.definitions()) {
            this.disposers.push(tools.register(definition));
        }
    }
    /** Remove every registration. */
    dispose() {
        for (const dispose of this.disposers.splice(0)) {
            try {
                dispose();
            }
            catch {
                // Disposal must not fail plugin teardown.
            }
        }
    }
    /** Re-read the published catalog on the next discovery call. */
    invalidateCatalog() {
        this.catalog = undefined;
    }
    /** The five owned tool definitions. */
    definitions() {
        const self = this;
        const signIn = defineTool({
            name: 'nexscope_sign_in',
            description: 'Connect a Nexscope account. Opens the Nexscope sign-in page in the browser and waits for the loopback callback, then stores the OAuth grant in the harness credential store. Run this when a Nexscope tool reports that sign-in is required.',
            parameters: {},
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        status: {
                            type: 'string',
                            required: true,
                            description: 'signed-in when a new grant was stored, already-signed-in when a valid token was reused.',
                        },
                        redirectUri: {
                            type: 'string',
                            required: true,
                            description: 'Loopback callback address used for this sign-in.',
                        },
                    },
                },
                render: (_args, value) => [
                    {
                        type: 'text',
                        text: value.status === 'already-signed-in'
                            ? 'The Nexscope account is already connected.'
                            : 'The Nexscope account is connected. Nexscope tools are ready.',
                    },
                ],
            },
            async execute() {
                try {
                    const result = await self.oauth.signIn();
                    self.invalidateCatalog();
                    await self.client.reset();
                    return { status: result.status, redirectUri: result.redirectUri };
                }
                catch (error) {
                    throw new Error(failureText(error));
                }
            },
        });
        const status = defineTool({
            name: 'nexscope_status',
            description: 'Report the Nexscope connection state, the MCP endpoint in use, and how many tools the server publishes. Reads only; does not spend credits.',
            parameters: {},
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        connected: { type: 'boolean', required: true },
                        endpoint: { type: 'string', required: true },
                        publishedTools: { type: 'number', required: true },
                        detail: { type: 'string', required: true },
                    },
                },
                render: (_args, value) => [{ type: 'text', text: value.detail }],
            },
            async execute() {
                const connected = await self.oauth.hasAccessToken();
                let published = 0;
                let note = '';
                if (connected) {
                    try {
                        published = (await self.catalogNow()).length;
                    }
                    catch (error) {
                        note = `\nThe catalog could not be read: ${describe(error)}`;
                    }
                }
                return {
                    connected,
                    endpoint: self.endpoint(),
                    publishedTools: published,
                    detail: [
                        connected ? 'Nexscope is connected.' : 'Nexscope is not connected. Call nexscope_sign_in.',
                        `Endpoint: ${self.endpoint()}`,
                        `Published tools: ${published}`,
                        note.trim(),
                    ]
                        .filter((line) => line !== '')
                        .join('\n'),
                };
            },
        });
        const find = defineTool({
            name: 'nexscope_find_tools',
            description: 'Search the Nexscope capability catalog by keyword and return matching tool names with short descriptions. Use this when the right tool name is unknown. Call nexscope_describe_tool for the exact input schema before calling the tool. Reads only; does not spend credits.',
            parameters: {
                query: {
                    type: 'string',
                    required: true,
                    description: 'Words to match against tool names and descriptions, such as "amazon keyword", "tiktok product", or "patent".',
                },
                limit: {
                    type: 'number',
                    description: `Maximum matches to return; defaults to ${DEFAULT_LIMIT} and caps at ${MAX_LIMIT}.`,
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        total: { type: 'number', required: true },
                        matches: {
                            type: 'array',
                            required: true,
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    name: { type: 'string', required: true },
                                    description: { type: 'string', required: true },
                                },
                            },
                        },
                    },
                },
                render: (_args, value) => [
                    {
                        type: 'text',
                        text: value.matches.length === 0
                            ? 'No Nexscope tool matched that query. Try broader words, or call nexscope_status to check the connection.'
                            : [
                                `${value.total} matching tool${value.total === 1 ? '' : 's'} (showing ${value.matches.length}):`,
                                ...value.matches.map((match) => `- ${match.name}: ${match.description}`),
                                '',
                                'Call nexscope_describe_tool with one name to read its exact input schema.',
                            ].join('\n'),
                    },
                ],
            },
            async execute(args) {
                const catalog = await self.catalogOrThrow();
                const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
                const query = words(args.query);
                const scored = catalog
                    .map((tool) => ({ tool, score: scoreTool(tool, query) }))
                    .filter((entry) => entry.score > 0)
                    .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name));
                return {
                    total: scored.length,
                    matches: scored.slice(0, limit).map(({ tool }) => ({
                        name: tool.name,
                        description: (tool.description ?? '').replaceAll(/\s+/gu, ' ').slice(0, 300),
                    })),
                };
            },
        });
        const describeTool = defineTool({
            name: 'nexscope_describe_tool',
            description: 'Return the exact input schema and description of one published Nexscope tool. Call this before nexscope_call_tool so required fields, formats, and enums come from the server instead of guesses. Reads only; does not spend credits.',
            parameters: {
                name: {
                    type: 'string',
                    required: true,
                    description: 'Exact published tool name from nexscope_find_tools.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        name: { type: 'string', required: true },
                        description: { type: 'string', required: true },
                        inputSchema: { type: 'json', required: true },
                        outputSchema: { type: 'json' },
                        inputExamples: { type: 'array', items: { type: 'string' } },
                        consumesCredits: { type: 'boolean', required: true },
                    },
                },
                render: (_args, value) => [
                    {
                        type: 'text',
                        text: [
                            `Tool: ${value.name}`,
                            '',
                            value.description,
                            '',
                            value.consumesCredits
                                ? 'This call may consume Nexscope credits. Confirm the user wants to run it.'
                                : 'This tool does not consume credits.',
                            '',
                            'Input schema:',
                            JSON.stringify(value.inputSchema, null, 2),
                            ...(value.inputExamples === undefined || value.inputExamples.length === 0
                                ? []
                                : ['', 'Illustrative input example:', ...value.inputExamples]),
                        ].join('\n'),
                    },
                ],
            },
            async execute(args) {
                const catalog = await self.catalogOrThrow();
                const tool = catalog.find((candidate) => candidate.name === args.name);
                if (tool === undefined) {
                    throw new Error(`No published Nexscope tool is named "${args.name}". Use nexscope_find_tools to search for the right name.`);
                }
                return {
                    name: tool.name,
                    description: tool.description ?? '',
                    inputSchema: jsonify(tool.inputSchema),
                    ...(tool.outputSchema === undefined ? {} : { outputSchema: jsonify(tool.outputSchema) }),
                    ...(inputExamples(tool) === undefined ? {} : { inputExamples: inputExamples(tool) }),
                    consumesCredits: consumesCredits(tool),
                };
            },
        });
        const callTool = defineTool({
            name: 'nexscope_call_tool',
            description: 'Call one published Nexscope tool by name with a JSON argument object. Read the schema with nexscope_describe_tool first. Calls may consume Nexscope credits: make one call at a time, never retry an uncertain paid call without checking status, and report the real result or error.',
            parameters: {
                name: { type: 'string', required: true, description: 'Exact published tool name.' },
                arguments: {
                    type: 'json',
                    required: true,
                    description: 'Argument object matching the tool input schema. Use {} when the tool takes no arguments.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        text: { type: 'string', required: true },
                        value: { type: 'json', required: true },
                        isError: { type: 'boolean', required: true },
                    },
                },
                render: (_args, value) => [{ type: 'text', text: value.text }],
            },
            async execute(args, exec) {
                const catalog = await self.catalogOrThrow();
                const tool = catalog.find((candidate) => candidate.name === args.name);
                if (tool === undefined) {
                    throw new Error(`No published Nexscope tool is named "${args.name}". Use nexscope_find_tools to search for the right name.`);
                }
                let result;
                try {
                    result = await self.client.call(args.name, asArguments(args.arguments), exec.signal);
                }
                catch (error) {
                    throw new Error(failureText(error));
                }
                const text = renderContent(result.content);
                return {
                    text: result.isError === true
                        ? `The Nexscope tool reported an error:\n\n${text}`
                        : text === ''
                            ? 'The Nexscope tool completed without text content. Read the structured value for details.'
                            : text,
                    value: canonicalValue(result),
                    isError: result.isError === true,
                };
            },
        });
        const exportTool = defineTool({
            name: 'nexscope_export',
            description: 'Convert a Nexscope JSON result into a CSV, JSON, or JSONL file in the workspace. Use this when the user asks for a deliverable file. Reads local JSON only and never spends credits.',
            parameters: {
                input: {
                    type: 'string',
                    description: 'Workspace path to a saved JSON result. Provide exactly one of input or json.',
                },
                json: {
                    type: 'string',
                    description: 'Inline JSON text instead of a file. Provide exactly one of input or json.',
                },
                path: {
                    type: 'string',
                    description: 'Dot or JSON-Pointer path to the array to export, such as data.items. Omit to export the whole value.',
                },
                output: {
                    type: 'string',
                    required: true,
                    description: 'Destination file path, relative to the working directory.',
                },
                format: {
                    type: 'string',
                    enum: ['csv', 'json', 'jsonl'],
                    description: 'Deliverable format. Defaults to csv.',
                },
                columns: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional CSV column order. Defaults to first-seen key order.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        output: { type: 'string', required: true },
                        rows: { type: 'number', required: true },
                        bytes: { type: 'number', required: true },
                        columns: { type: 'array', items: { type: 'string' } },
                        text: { type: 'string', required: true },
                    },
                },
                render: (_args, value) => [{ type: 'text', text: value.text }],
            },
            async execute(args, exec) {
                const format = args.format === 'json' || args.format === 'jsonl' ? args.format : 'csv';
                try {
                    const result = await exportDeliverable(self.ctx, {
                        input: args.input,
                        json: args.json,
                        path: args.path,
                        output: args.output,
                        format,
                        columns: args.columns,
                        cwd: await workingDirectoryOf(self.ctx, exec),
                    }, exec.signal);
                    return {
                        output: result.output,
                        rows: result.rows,
                        bytes: result.bytes,
                        ...(result.columns === undefined ? {} : { columns: [...result.columns] }),
                        text: `Wrote ${result.rows} row${result.rows === 1 ? '' : 's'} to ${result.output} (${result.bytes} bytes).`,
                    };
                }
                catch (error) {
                    throw new Error(`The export failed: ${describe(error)}`);
                }
            },
        });
        const account = defineTool({
            name: 'nexscope_account',
            description: 'Report the Nexscope credit balance and, optionally, recent API usage. Uses an account tool when the MCP server publishes one, otherwise a configured Nexscope API key. Never spends credits and never prints the key.',
            parameters: {
                includeUsage: {
                    type: 'boolean',
                    description: 'Also return recent usage records. Defaults to false.',
                },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                        available: { type: 'boolean', required: true },
                        source: { type: 'string', required: true },
                        text: { type: 'string', required: true },
                        data: { type: 'json' },
                    },
                },
                render: (_args, value) => [{ type: 'text', text: value.text }],
            },
            async execute(args, exec) {
                // Prefer a server-published account tool when one exists.
                let published;
                try {
                    const catalog = await self.catalogNow();
                    published = catalog.find((tool) => /^nexscope_(account|credits|balance)$/u.test(tool.name));
                }
                catch {
                    // No session or catalog: fall through to the REST path.
                }
                if (published !== undefined) {
                    try {
                        const raw = await self.client.call(published.name, {}, exec.signal);
                        const text = renderContent(raw.content);
                        return {
                            available: raw.isError !== true,
                            source: 'mcp',
                            text: text === '' ? 'The account tool returned no text.' : text,
                            data: canonicalValue(raw),
                        };
                    }
                    catch (error) {
                        return {
                            available: false,
                            source: 'mcp',
                            text: `The Nexscope account tool failed: ${describe(error)}`,
                        };
                    }
                }
                const key = await self.apiKey();
                if (key !== undefined) {
                    try {
                        const credits = await self.rest('/api/skill-api/v1/account/credits', key, exec.signal);
                        const usage = args.includeUsage === true
                            ? await self.rest('/api/skill-api/v1/account/usage', key, exec.signal)
                            : undefined;
                        const summary = summarizeCredits(credits);
                        const usageText = usage === undefined ? '' : `\n\n${summarizeUsage(usage)}`;
                        return {
                            available: true,
                            source: 'api-key',
                            text: `${summary}${usageText}\n\nSource: Nexscope API key.`,
                            data: jsonify({ credits, usage }),
                        };
                    }
                    catch (error) {
                        return {
                            available: false,
                            source: 'api-key',
                            text: `The Nexscope account query failed: ${describe(error)}\n\nCheck the balance at https://www.nexscope.ai/seller/credits.`,
                        };
                    }
                }
                return {
                    available: false,
                    source: 'none',
                    text: [
                        'Credit balance is not readable with OAuth alone: the Nexscope account endpoints accept an API key, and the MCP server does not publish an account tool yet.',
                        '',
                        'Check the balance at https://www.nexscope.ai/seller/credits.',
                        `To let this plugin report it here, set ${self.config.apiKeyEnv} to a Nexscope API key in the credential store.`,
                        'An insufficient-credits error from a paid call still returns its own recharge guidance.',
                    ].join('\n'),
                };
            },
        });
        return [signIn, status, find, describeTool, callTool, exportTool, account];
    }
    /** Resolve the optional Nexscope API key from the credential store. */
    async apiKey() {
        const credentials = this.ctx.credentials;
        if (credentials === undefined)
            return undefined;
        try {
            const resolved = await credentials.resolve(credentialRef(this.config.apiKeyEnv));
            return resolved?.value;
        }
        catch {
            return undefined;
        }
    }
    /** Call one Nexscope REST endpoint with the API key. */
    async rest(path, key, signal) {
        const response = await fetch(`${this.config.apiBase}${path}`, {
            headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        const body = (await response.json().catch(() => undefined));
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}${body?.msg === undefined ? '' : `: ${body.msg}`}`);
        }
        if (body === undefined)
            throw new Error('The server returned a non-JSON response.');
        if (typeof body.code === 'number' && body.code !== 0) {
            throw new Error(`${body.msg ?? 'The account request failed'} (code ${body.code})`);
        }
        return body.data;
    }
    /** The configured endpoint. */
    endpoint() {
        return this.client.endpoint;
    }
    /** The catalog, cached until invalidated. */
    async catalogNow() {
        this.catalog ??= await this.client.tools();
        return this.catalog;
    }
    /** The catalog, converted into model-facing failure text. */
    async catalogOrThrow() {
        try {
            return await this.catalogNow();
        }
        catch (error) {
            throw new Error(failureText(error));
        }
    }
}
/** Illustrative input examples published by the server. */
function inputExamples(tool) {
    const meta = tool._meta;
    const examples = meta?.['nexscope/inputExamples'];
    if (!Array.isArray(examples))
        return undefined;
    const values = examples.filter((value) => typeof value === 'string');
    return values.length === 0 ? undefined : values;
}
/** Resolve the session working directory when the harness provides one. */
async function workingDirectoryOf(ctx, exec) {
    const service = ctx.workingDirectory;
    if (service !== undefined && exec.agent !== undefined) {
        try {
            return await service.ensure(exec.agent, exec.signal);
        }
        catch {
            // Fall back to the host working directory.
        }
    }
    return process.cwd();
}
/** One-line credit summary from the account API. */
function summarizeCredits(value) {
    const record = (value ?? {});
    const number = (key) => typeof record[key] === 'number' ? String(record[key]) : 'unknown';
    return [
        `Net credit: ${number('netCredit')}`,
        `Permanent: ${number('permanentCredit')}`,
        `Cycle: ${number('cycleCredit')}`,
        `Debt: ${number('debt')}`,
        `Gross consumed: ${number('grossConsumedCredit')}`,
    ].join('\n');
}
/** Short usage summary from the account API. */
function summarizeUsage(value) {
    const record = (value ?? {});
    const rows = Array.isArray(record.records)
        ? record.records
        : Array.isArray(record.list)
            ? record.list
            : [];
    const total = record.total ?? rows.length;
    return `Recent usage records: ${rows.length} shown, ${String(total)} total.`;
}
/** Whether a tool's metadata marks it as spending credits. */
function consumesCredits(tool) {
    const meta = tool._meta;
    const billing = meta?.['nexscope/billing'];
    return billing?.consumesCredits !== false;
}
