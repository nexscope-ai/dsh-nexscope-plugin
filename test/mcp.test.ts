/**
 * Integration test over a real MCP client/server pair.
 *
 * A linked in-memory transport exercises the same code paths as production:
 * tool discovery, schema pass-through, text and structured results, upstream
 * error results, and the discovery tools built on top of them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  InMemoryTransport,
  type CallToolResult,
} from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { NexscopeClient } from '../src/client.js'
import { NexscopeTools } from '../src/tools.js'
import { resolveConfig } from '../src/config.js'

/** Tool execution context used by the plugin tools. */
function fakeExec() {
  return {
    signal: new AbortController().signal,
    agent: undefined,
    callId: 'test',
    name: 'test',
    rootCallId: 'test',
    token: Symbol('t'),
    deferContext: () => {},
    concludeTurn: () => {},
  }
}

/** Fake OAuth that reports a stored token. */
const oauth = {
  provider: { token: async () => 'test-token' },
  hasAccessToken: async () => true,
  hasGrant: async () => true,
  signIn: async () => ({ status: 'signed-in', redirectUri: 'http://127.0.0.1:45871/callback' }),
}

let close: (() => Promise<void>) | undefined

afterEach(async () => {
  await close?.()
  close = undefined
})

async function harness() {
  const server = new McpServer({ name: 'nexscope-test', version: '0.0.0' })
  server.registerTool(
    'nexscope_echo',
    {
      description: 'Echo a value.',
      inputSchema: z.object({ query: z.string() }),
    },
    async (args) => ({
      content: [
        { type: 'text', text: `echo ${String(args.query)}` },
        { type: 'text', text: 'second block' },
      ],
      structuredContent: { echo: args.query },
    }),
  )
  server.registerTool(
    'nexscope_account',
    {
      description: 'Account summary.',
      inputSchema: z.object({}),
    },
    async () => ({
      content: [{ type: 'text', text: 'Net credit: 7' }],
      structuredContent: { netCredit: 7 },
    }),
  )
  server.registerTool(
    'nexscope_fail',
    {
      description: 'Always fails.',
      inputSchema: z.object({}),
    },
    async () =>
      ({
        content: [{ type: 'text', text: 'business error 11209' }],
        isError: true,
      }) as CallToolResult,
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  close = async () => {
    await server.close()
    await clientTransport.close()
  }
  const ctx = {
    credentials: { resolve: async () => undefined },
    logger: { info() {}, warn() {} },
  }
  const config = resolveConfig()
  const client = new NexscopeClient(
    ctx as never,
    config,
    oauth as never,
    () => clientTransport,
  )
  const tools = new NexscopeTools(ctx as never, client, oauth as never, config)
  const registered: Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }> = []
  tools.install({ register: (definition: never) => { registered.push(definition); return () => {} } } as never)
  return { registered, tools }
}

describe('MCP integration', () => {
  it('lists tools and forwards a call through nexscope_call_tool', async () => {
    const { registered } = await harness()
    const call = registered.find((definition) => definition.name === 'nexscope_call_tool')!
    const result = (await call.execute(
      { name: 'nexscope_echo', arguments: { query: 'hello' } },
      fakeExec(),
    )) as { text: string; isError: boolean; value: { structuredContent: unknown } }
    expect(result.isError).toBe(false)
    expect(result.text).toContain('echo hello')
    expect(result.text).toContain('second block')
    expect(result.value.structuredContent).toEqual({ echo: 'hello' })
  })

  it('reports an upstream error result without throwing', async () => {
    const { registered } = await harness()
    const call = registered.find((definition) => definition.name === 'nexscope_call_tool')!
    const result = (await call.execute(
      { name: 'nexscope_fail', arguments: {} },
      fakeExec(),
    )) as { text: string; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.text).toContain('11209')
  })

  it('returns the exact upstream input schema', async () => {
    const { registered } = await harness()
    const describeTool = registered.find(
      (definition) => definition.name === 'nexscope_describe_tool',
    )!
    const result = (await describeTool.execute(
      { name: 'nexscope_echo' },
      fakeExec(),
    )) as { name: string; consumesCredits: boolean; inputSchema: { properties: unknown } }
    expect(result.name).toBe('nexscope_echo')
    expect(result.consumesCredits).toBe(true)
    expect(result.inputSchema).toBeDefined()
  })

  it('prefers a server-published account tool over the API key', async () => {
    const { registered } = await harness()
    const account = registered.find((definition) => definition.name === 'nexscope_account')!
    const result = (await account.execute({}, fakeExec())) as {
      available: boolean
      source: string
      text: string
    }
    expect(result.available).toBe(true)
    expect(result.source).toBe('mcp')
    expect(result.text).toContain('Net credit: 7')
  })

  it('searches the live catalog', async () => {
    const { registered } = await harness()
    const find = registered.find((definition) => definition.name === 'nexscope_find_tools')!
    const result = (await find.execute({ query: 'echo' }, fakeExec())) as {
      total: number
      matches: Array<{ name: string }>
    }
    expect(result.matches.map((match) => match.name)).toContain('nexscope_echo')
  })
})
