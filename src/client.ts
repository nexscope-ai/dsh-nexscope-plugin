/**
 * MCP client lifecycle and tool invocation.
 *
 * One Nexscope MCP connection serves the whole plugin. Tool calls are
 * forwarded with the upstream name and arguments unchanged so the published
 * catalog stays the single source of truth for schemas and behavior.
 *
 * @module dsh-nexscope/client
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/client'
import type { ResolvedConfig } from './config.js'
import { NexscopeOAuth, SignInRequiredError, describe } from './oauth.js'

/** One opened MCP session. */
export interface McpSession {
  readonly client: Client
  readonly transport: StreamableHTTPClientTransport
  readonly tools: readonly Tool[]
}

/** Errors that need a fresh browser sign-in. */
function isAuthFailure(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  const message = describe(error).toLowerCase()
  return (
    message.includes('unauthorized') ||
    message.includes('invalid_token') ||
    message.includes('401')
  )
}

/** Lazily connected Nexscope MCP client. */
export class NexscopeClient {
  private readonly config: ResolvedConfig
  private readonly oauth: NexscopeOAuth
  private readonly log: { info(message: string): void; warn(message: string): void }
  private session?: Promise<McpSession>
  private closed = false

  constructor(ctx: Context, config: ResolvedConfig, oauth: NexscopeOAuth) {
    this.config = config
    this.oauth = oauth
    this.log = {
      info: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message),
    }
  }

  /** The configured MCP endpoint. */
  get endpoint(): string {
    return this.config.mcpUrl
  }

  /** Connect on first use and reuse the session afterwards. */
  async connect(): Promise<McpSession> {
    if (this.closed) throw new Error('The Nexscope client is closed.')
    this.session ??= this.open().catch((error: unknown) => {
      this.session = undefined
      throw error
    })
    return this.session
  }

  /** The published tool catalog. */
  async tools(): Promise<readonly Tool[]> {
    return (await this.connect()).tools
  }

  /**
   * Call one published tool.
   * @param name - the upstream tool name.
   * @param args - arguments validated by the caller against the tool schema.
   * @param signal - caller cancellation.
   * @returns the raw MCP result.
   */
  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    const session = await this.connect()
    return session.client.callTool({ name, arguments: args }, { signal, timeout: this.config.toolCallTimeoutMs })
  }

  /** Drop the session so the next call reconnects. */
  async reset(): Promise<void> {
    const pending = this.session
    this.session = undefined
    if (pending === undefined) return
    try {
      const session = await pending
      await session.transport.close()
      await session.client.close()
    } catch {
      // A failed session has nothing left to close.
    }
  }

  /** Close the client and forget the session. */
  async close(): Promise<void> {
    this.closed = true
    await this.reset()
  }

  /** Open one authenticated session. */
  private async open(): Promise<McpSession> {
    if (!(await this.oauth.hasAccessToken())) {
      throw new SignInRequiredError()
    }
    const transport = new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), {
      authProvider: this.oauth.provider,
      requestInit: { headers: { accept: 'application/json, text/event-stream' } },
    })
    const client = new Client({ name: 'dsh-nexscope', version: '0.1.0' })
    try {
      await client.connect(transport)
      const tools = await this.listAllTools(client)
      this.log.info(`nexscope: connected, ${tools.length} tools published`)
      return { client, transport, tools }
    } catch (error) {
      await transport.close().catch(() => {})
      await client.close().catch(() => {})
      if (isAuthFailure(error)) {
        await this.oauth.signOut()
        throw new SignInRequiredError()
      }
      throw error
    }
  }

  /** Walk every page of the tool catalog. */
  private async listAllTools(client: Client): Promise<readonly Tool[]> {
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor })
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor !== undefined && cursor !== '')
    return tools
  }
}
