import { Client, OAuthError, StreamableHTTPClientTransport, UnauthorizedError, } from '@modelcontextprotocol/client';
import { SignInRequiredError, describe } from './oauth.js';
/** Errors that need a fresh browser sign-in. */
function isAuthFailure(error) {
    if (error instanceof UnauthorizedError || error instanceof OAuthError)
        return true;
    const message = describe(error).toLowerCase();
    return (message.includes('unauthorized') ||
        message.includes('invalid_token') ||
        message.includes('invalid_grant') ||
        message.includes('invalid_client') ||
        message.includes('invalid_target') ||
        message.includes('401'));
}
/** Lazily connected Nexscope MCP client. */
export class NexscopeClient {
    config;
    oauth;
    log;
    session;
    closed = false;
    constructor(ctx, config, oauth) {
        this.config = config;
        this.oauth = oauth;
        this.log = {
            info: (message) => ctx.logger.info(message),
            warn: (message) => ctx.logger.warn(message),
        };
    }
    /** The configured MCP endpoint. */
    get endpoint() {
        return this.config.mcpUrl;
    }
    /** Connect on first use and reuse the session afterwards. */
    async connect() {
        if (this.closed)
            throw new Error('The Nexscope client is closed.');
        this.session ??= this.open().catch((error) => {
            this.session = undefined;
            throw error;
        });
        return this.session;
    }
    /** The published tool catalog. */
    async tools() {
        return (await this.connect()).tools;
    }
    /**
     * Call one published tool.
     * @param name - the upstream tool name.
     * @param args - arguments validated by the caller against the tool schema.
     * @param signal - caller cancellation.
     * @returns the raw MCP result.
     */
    async call(name, args, signal) {
        const session = await this.connect();
        return session.client.callTool({ name, arguments: args }, { signal, timeout: this.config.toolCallTimeoutMs });
    }
    /** Drop the session so the next call reconnects. */
    async reset() {
        const pending = this.session;
        this.session = undefined;
        if (pending === undefined)
            return;
        try {
            const session = await pending;
            await session.transport.close();
            await session.client.close();
        }
        catch {
            // A failed session has nothing left to close.
        }
    }
    /** Close the client and forget the session. */
    async close() {
        this.closed = true;
        await this.reset();
    }
    /** Open one authenticated session. */
    async open() {
        if (!(await this.oauth.hasAccessToken())) {
            throw new SignInRequiredError();
        }
        const transport = new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), {
            authProvider: this.oauth.provider,
            requestInit: { headers: { accept: 'application/json, text/event-stream' } },
        });
        const client = new Client({ name: 'dsh-nexscope', version: '0.1.0' });
        try {
            await client.connect(transport);
            const tools = await this.listAllTools(client);
            this.log.info(`nexscope: connected, ${tools.length} tools published`);
            return { client, transport, tools };
        }
        catch (error) {
            await transport.close().catch(() => { });
            await client.close().catch(() => { });
            if (isAuthFailure(error)) {
                await this.oauth.signOut();
                throw new SignInRequiredError();
            }
            throw error;
        }
    }
    /** Walk every page of the tool catalog. */
    async listAllTools(client) {
        const tools = [];
        let cursor;
        do {
            const page = await client.listTools(cursor === undefined ? {} : { cursor });
            tools.push(...page.tools);
            cursor = page.nextCursor;
        } while (cursor !== undefined && cursor !== '');
        return tools;
    }
}
