import { defineTool } from '@deepseek-ai/dsh-tools';
import { SignInRequiredError, describe } from './oauth.js';
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
    disposers = [];
    catalog;
    constructor(ctx, client, oauth) {
        this.ctx = ctx;
        this.client = client;
        this.oauth = oauth;
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
        return [signIn, status, find, describeTool, callTool];
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
/** Whether a tool's metadata marks it as spending credits. */
function consumesCredits(tool) {
    const meta = tool._meta;
    const billing = meta?.['nexscope/billing'];
    return billing?.consumesCredits !== false;
}
