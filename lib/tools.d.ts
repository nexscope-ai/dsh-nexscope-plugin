/**
 * Model-facing tool surface.
 *
 * The Nexscope MCP server publishes 500+ tools. Registering every upstream
 * schema natively would cost roughly a quarter of a million prompt tokens and
 * slow every turn, so this plugin registers a small discovery surface instead:
 *
 * - `nexscope_find_tools` searches names and descriptions.
 * - `nexscope_describe_tool` returns the exact upstream input schema.
 * - `nexscope_call_tool` invokes any published tool by name.
 * - `nexscope_sign_in` and `nexscope_status` own the connection.
 *
 * Every published capability stays reachable, and no schema is paid for until
 * a call needs it.
 *
 * @module dsh-nexscope/tools
 */
import type { Context } from '@deepseek-ai/cordis';
import { type ToolRuntime } from '@deepseek-ai/dsh-tools';
import type { ContentBlock, Tool } from '@modelcontextprotocol/client';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';
import type { NexscopeClient } from './client.js';
import type { NexscopeOAuth } from './oauth.js';
import type { ResolvedConfig } from './config.js';
/** Tools this plugin owns, which an upstream tool must never shadow. */
export declare const OWNED_TOOLS: readonly ["nexscope_sign_in", "nexscope_sign_out", "nexscope_status", "nexscope_find_tools", "nexscope_describe_tool", "nexscope_call_tool", "nexscope_export", "nexscope_account"];
/** Render MCP content blocks as model text. */
export declare function renderContent(content: readonly ContentBlock[]): string;
/** Lossless JSON copy of an upstream value. */
export declare function jsonify(value: unknown): JsonValue;
/** Model-facing failure text for a plugin or transport error. */
export declare function failureText(error: unknown): string;
/** Score one tool against query words, preferring name matches. */
export declare function scoreTool(tool: Tool, words: readonly string[]): number;
/** Register the Nexscope tools on one registry. */
export declare class NexscopeTools {
    private readonly ctx;
    private readonly client;
    private readonly oauth;
    private readonly config;
    private readonly disposers;
    private catalog?;
    constructor(ctx: Context, client: NexscopeClient, oauth: NexscopeOAuth, config: ResolvedConfig);
    /** Register every owned tool. */
    install(tools?: ToolRuntime): void;
    /** Remove every registration. */
    dispose(): void;
    /** Re-read the published catalog on the next discovery call. */
    invalidateCatalog(): void;
    /** The five owned tool definitions. */
    private definitions;
    /** Resolve the optional Nexscope API key from the credential store. */
    private apiKey;
    /** Call one Nexscope REST endpoint with the API key. */
    private rest;
    /** The configured endpoint. */
    private endpoint;
    /** The catalog, cached until invalidated. */
    private catalogNow;
    /** The catalog, converted into model-facing failure text. */
    private catalogOrThrow;
}
