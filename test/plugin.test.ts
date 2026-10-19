/**
 * Unit tests for the tool surface and OAuth callback handling.
 *
 * These tests exercise the parts that decide model-visible behavior: catalog
 * search ranking, result rendering, sign-in failure paths, and credential
 * persistence. They use a fake context and never reach the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult, Tool } from '@modelcontextprotocol/client'
import { NexscopeTools, renderContent, scoreTool } from '../src/tools.js'
import { NexscopeOAuth, SignInFailedError, SignInRequiredError } from '../src/oauth.js'
import { resolveConfig } from '../src/config.js'

/** Minimal credential store used by the OAuth tests. */
function memoryCredentials() {
  const store = new Map<string, unknown>()
  return {
    store,
    readRecord: async (key: string) => store.get(key),
    modifyRecord: async (key: string, mutate: (current: unknown) => Promise<unknown>) => {
      const next = await mutate(store.get(key))
      store.set(key, next)
      return next
    },
    deleteRecord: async (key: string) => {
      store.delete(key)
    },
    describe: async () => ({ configured: false, writable: true }),
    resolve: async () => undefined,
    set: async () => {},
    unset: async () => {},
    listRecords: async () => [],
  }
}

/** Fake Cordis context with just the services these units touch. */
function fakeContext(credentials = memoryCredentials()) {
  const tools: string[] = []
  const providers: unknown[] = []
  const logs: string[] = []
  return {
    tools: {
      register: (definition: { name: string }) => {
        tools.push(definition.name)
        return () => {}
      },
    },
    credentials,
    skills: { registerProvider: (provider: unknown) => providers.push(provider) },
    logger: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      debug: (message: string) => logs.push(message),
    },
    effect: (fn: () => unknown) => fn(),
    registered: tools,
    providers,
    logs,
  }
}

/** One published tool. */
function tool(name: string, description: string, extra: Partial<Tool> = {}): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    ...extra,
  } as Tool
}

/** A client stub with a fixed catalog. */
function clientStub(catalog: readonly Tool[]) {
  return {
    endpoint: 'https://api.nexscope.ai/api/skill-api/v2/mcp',
    tools: async () => catalog,
    call: async (name: string): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: `ran ${name}` }],
    }),
    reset: async () => {},
    close: async () => {},
  }
}

/** An OAuth stub that is never actually used by these tests. */
function oauthStub() {
  return {
    hasAccessToken: async () => true,
    signIn: async () => ({ status: 'signed-in', redirectUri: 'http://127.0.0.1:45871/callback' }),
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('renderContent', () => {
  it('keeps text and marks non-text blocks', () => {
    const text = renderContent([
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
      { type: 'resource_link', uri: 'https://example.test/a', name: 'a' },
    ])
    expect(text).toContain('hello')
    expect(text).toContain('[image content]')
    expect(text).toContain('[a](https://example.test/a)')
  })

  it('returns an empty string for no content', () => {
    expect(renderContent([])).toBe('')
  })
})

describe('scoreTool', () => {
  it('ranks a name match above a description match', () => {
    const byName = scoreTool(tool('nexscope_amazon_search', 'Search.'), ['amazon'])
    const byDescription = scoreTool(tool('nexscope_other', 'Amazon search.'), ['amazon'])
    expect(byName).toBeGreaterThan(byDescription)
  })

  it('scores zero when no word matches', () => {
    expect(scoreTool(tool('nexscope_amazon_search', 'Search.'), ['tiktok'])).toBe(0)
  })
})

describe('NexscopeTools', () => {
  it('registers exactly the five owned tools', () => {
    const ctx = fakeContext()
    const tools = new NexscopeTools(
      ctx as never,
      clientStub([]) as never,
      oauthStub() as never,
    )
    tools.install(ctx.tools as never)
    expect(ctx.registered).toEqual([
      'nexscope_sign_in',
      'nexscope_status',
      'nexscope_find_tools',
      'nexscope_describe_tool',
      'nexscope_call_tool',
    ])
  })

  it('ranks matches and caps the requested limit', async () => {
    const catalog = [
      tool('nexscope_amazon_search', 'Search Amazon products.'),
      tool('nexscope_amazon_keywords', 'Amazon keyword research.'),
      tool('nexscope_tiktok_video', 'TikTok video analytics.'),
    ]
    const ctx = fakeContext()
    const tools = new NexscopeTools(ctx as never, clientStub(catalog) as never, oauthStub() as never)
    const definitions = definitionsOf(tools)
    const find = definitions.find((definition) => definition.name === 'nexscope_find_tools')!
    const result = (await find.execute({ query: 'amazon', limit: 1 }, fakeExec())) as {
      total: number
      matches: Array<{ name: string }>
    }
    expect(result.total).toBe(2)
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.name).toMatch(/^nexscope_amazon_/)
  })

  it('reports an unknown tool name with a search hint', async () => {
    const ctx = fakeContext()
    const tools = new NexscopeTools(ctx as never, clientStub([tool('a', 'b')]) as never, oauthStub() as never)
    const describeTool = definitionsOf(tools).find(
      (definition) => definition.name === 'nexscope_describe_tool',
    )!
    await expect(describeTool.execute({ name: 'missing' }, fakeExec())).rejects.toThrow(
      /nexscope_find_tools/,
    )
  })

  it('surfaces an upstream error result as a tool error', async () => {
    const ctx = fakeContext()
    const client = clientStub([tool('nexscope_x', 'X.')])
    client.call = async () => ({
      content: [{ type: 'text', text: 'not enough credits' }],
      isError: true,
    })
    const tools = new NexscopeTools(ctx as never, client as never, oauthStub() as never)
    const callTool = definitionsOf(tools).find(
      (definition) => definition.name === 'nexscope_call_tool',
    )!
    const result = (await callTool.execute(
      { name: 'nexscope_x', arguments: {} },
      fakeExec(),
    )) as { isError: boolean; text: string }
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not enough credits')
  })

  it('marks credit-spending tools from server metadata', async () => {
    const ctx = fakeContext()
    const catalog = [
      tool('nexscope_paid', 'Paid.', {
        _meta: { 'nexscope/billing': { consumesCredits: true } },
      } as Partial<Tool>),
      tool('nexscope_free', 'Free.', {
        _meta: { 'nexscope/billing': { consumesCredits: false } },
      } as Partial<Tool>),
    ]
    const tools = new NexscopeTools(ctx as never, clientStub(catalog) as never, oauthStub() as never)
    const describeTool = definitionsOf(tools).find(
      (definition) => definition.name === 'nexscope_describe_tool',
    )!
    const paid = (await describeTool.execute({ name: 'nexscope_paid' }, fakeExec())) as {
      consumesCredits: boolean
    }
    const free = (await describeTool.execute({ name: 'nexscope_free' }, fakeExec())) as {
      consumesCredits: boolean
    }
    expect(paid.consumesCredits).toBe(true)
    expect(free.consumesCredits).toBe(false)
  })
})

describe('NexscopeOAuth', () => {
  it('reports no token before sign-in', async () => {
    const oauth = new NexscopeOAuth(fakeContext() as never, resolveConfig())
    expect(await oauth.hasAccessToken()).toBe(false)
  })

  it('stores and reloads the OAuth grant', async () => {
    const credentials = memoryCredentials()
    const oauth = new NexscopeOAuth(fakeContext(credentials) as never, resolveConfig())
    await oauth.patchGrant({ redirectUri: 'http://127.0.0.1:45871/callback', state: 'abc' })
    const reloaded = new NexscopeOAuth(fakeContext(credentials) as never, resolveConfig())
    expect(await reloaded.accessToken()).toBeUndefined()
    expect((await reloaded.loadGrant()).state).toBe('abc')
  })

  it('treats an expired access token as needing sign-in', async () => {
    const credentials = memoryCredentials()
    const oauth = new NexscopeOAuth(fakeContext(credentials) as never, resolveConfig())
    await oauth.patchGrant({
      tokens: { access_token: 't', token_type: 'Bearer', expires_in: 60 },
      savedAt: Date.now() - 10 * 60 * 1000,
    })
    expect(await oauth.hasAccessToken()).toBe(false)
  })

  it('rejects a callback whose state does not match', async () => {
    const oauth = new NexscopeOAuth(fakeContext() as never, resolveConfig())
    const pending = await oauth.startCallbackListener()
    try {
      const response = await fetch(`${pending.redirectUri}?code=abc&state=wrong`)
      expect(await response.text()).toContain('Connection rejected')
      await expect(pending.done).rejects.toBeInstanceOf(SignInFailedError)
    } finally {
      pending.close()
    }
  })

  it('rejects a callback carrying an error', async () => {
    const oauth = new NexscopeOAuth(fakeContext() as never, resolveConfig())
    const pending = await oauth.startCallbackListener()
    try {
      const response = await fetch(`${pending.redirectUri}?error=access_denied`)
      expect(await response.text()).toContain('Connection cancelled')
      await expect(pending.done).rejects.toThrow(/access_denied/)
    } finally {
      pending.close()
    }
  })

  it('accepts a valid callback and returns the code', async () => {
    const oauth = new NexscopeOAuth(fakeContext() as never, resolveConfig())
    const pending = await oauth.startCallbackListener()
    try {
      const response = await fetch(`${pending.redirectUri}?code=good&state=${pending.state}`)
      expect(await response.text()).toContain('Connected')
      await expect(pending.done).resolves.toMatchObject({ code: 'good' })
    } finally {
      pending.close()
    }
  })

  it('clears the stored grant on sign-out', async () => {
    const credentials = memoryCredentials()
    const oauth = new NexscopeOAuth(fakeContext(credentials) as never, resolveConfig())
    await oauth.patchGrant({ state: 'abc' })
    await oauth.signOut()
    expect(credentials.store.size).toBe(0)
    expect((await oauth.loadGrant()).state).toBeUndefined()
  })
})

/** Read the private definitions list through the public installer. */
function definitionsOf(tools: NexscopeTools) {
  const captured: Array<{
    name: string
    execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
  }> = []
  const registry = {
    register: (definition: never) => {
      captured.push(definition)
      return () => {}
    },
  }
  tools.install(registry as never)
  return captured
}

/** Minimal tool execution context. */
function fakeExec() {
  return {
    signal: new AbortController().signal,
    callId: 'test',
    name: 'test',
    rootCallId: 'test',
    token: Symbol('t'),
    deferContext: () => {},
    concludeTurn: () => {},
  }
}
