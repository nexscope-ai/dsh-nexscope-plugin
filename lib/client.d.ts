/**
 * MCP client lifecycle and tool invocation.
 *
 * One Nexscope MCP connection serves the whole plugin. Tool calls are
 * forwarded with the upstream name and arguments unchanged so the published
 * catalog stays the single source of truth for schemas and behavior.
 *
 * @module dsh-nexscope/client
 */
import type { Context } from '@deepseek-ai/cordis';
import { Client, type CallToolResult, type Tool, type Transport } from '@modelcontextprotocol/client';
import type { ResolvedConfig } from './config.js';
import { NexscopeOAuth } from './oauth.js';
/** One opened MCP session. */
export interface McpSession {
    readonly client: Client;
    readonly transport: Transport;
    readonly tools: readonly Tool[];
}
/** Lazily connected Nexscope MCP client. */
export declare class NexscopeClient {
    private readonly config;
    private readonly oauth;
    private readonly log;
    private session?;
    private closed;
    private readonly transportFactory;
    constructor(ctx: Context, config: ResolvedConfig, oauth: NexscopeOAuth, transportFactory?: (url: URL) => Transport);
    /** The configured MCP endpoint. */
    get endpoint(): string;
    /** Connect on first use and reuse the session afterwards. */
    connect(): Promise<McpSession>;
    /** The published tool catalog. */
    tools(): Promise<readonly Tool[]>;
    /**
     * Call one published tool.
     * @param name - the upstream tool name.
     * @param args - arguments validated by the caller against the tool schema.
     * @param signal - caller cancellation.
     * @returns the raw MCP result.
     */
    call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>;
    /** Drop the session so the next call reconnects. */
    reset(): Promise<void>;
    /** Close the client and forget the session. */
    close(): Promise<void>;
    /** Open one authenticated session. */
    private open;
    /** Walk every page of the tool catalog. */
    private listAllTools;
}
