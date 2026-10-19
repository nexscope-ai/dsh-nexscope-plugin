/**
 * Unit tests for the tool surface and OAuth callback handling.
 *
 * These tests exercise the parts that decide model-visible behavior: catalog
 * search ranking, result rendering, sign-in failure paths, and credential
 * persistence. They use a fake context and never reach the network.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CallToolResult, Tool } from '@modelcontextprotocol/client'
import { NexscopeTools, renderContent, scoreTool } from '../src/tools.js'
import { stripFrontmatter } from '../src/index.js'
import {
  assertInsideWorkspace,
  exportDeliverable,
  selectJsonPath,
  serializeExport,
  toCsv,
} from '../src/export.js'
import { NexscopeOAuth, SignInFailedError, checkClientMetadata } from '../src/oauth.js'
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
    hasGrant: async () => true,
    signIn: async () => ({ status: 'signed-in', redirectUri: 'http://127.0.0.1:45871/callback' }),
    signOut: async () => {},
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stripFrontmatter', () => {
  it('removes a leading YAML block and keeps the body', () => {
    const raw = '---\nname: nexscope\ndescription: test\n---\n# Nexscope\n\nBody.\n'
    expect(stripFrontmatter(raw)).toBe('# Nexscope\n\nBody.\n')
  })

  it('drops the blank line after the closing fence', () => {
    const raw = '---\nname: nexscope\n---\n\n# Nexscope\n'
    expect(stripFrontmatter(raw)).toBe('# Nexscope\n')
  })

  it('leaves content without frontmatter untouched', () => {
    expect(stripFrontmatter('# Nexscope\n')).toBe('# Nexscope\n')
  })
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
      resolveConfig(),
    )
    tools.install(ctx.tools as never)
    expect(ctx.registered).toEqual([
      'nexscope_sign_in',
      'nexscope_sign_out',
      'nexscope_status',
      'nexscope_find_tools',
      'nexscope_describe_tool',
      'nexscope_call_tool',
      'nexscope_export',
      'nexscope_account',
    ])
  })

  it('ranks matches and caps the requested limit', async () => {
    const catalog = [
      tool('nexscope_amazon_search', 'Search Amazon products.'),
      tool('nexscope_amazon_keywords', 'Amazon keyword research.'),
      tool('nexscope_tiktok_video', 'TikTok video analytics.'),
    ]
    const ctx = fakeContext()
    const tools = new NexscopeTools(ctx as never, clientStub(catalog) as never, oauthStub() as never, resolveConfig())
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
    const tools = new NexscopeTools(ctx as never, clientStub([tool('a', 'b')]) as never, oauthStub() as never, resolveConfig())
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
    const tools = new NexscopeTools(ctx as never, client as never, oauthStub() as never, resolveConfig())
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
    const tools = new NexscopeTools(ctx as never, clientStub(catalog) as never, oauthStub() as never, resolveConfig())
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

describe('checkClientMetadata', () => {
  const url = 'https://www.nexscope.ai/.well-known/dsh-nexscope-client.json'
  const redirect = 'http://127.0.0.1:45871/callback'

  it('accepts a matching document', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json; charset=utf-8' }),
      json: async () => ({ client_id: url, redirect_uris: [redirect] }),
    })) as unknown as typeof fetch
    await expect(checkClientMetadata(url, redirect, fetchFn)).resolves.toBeUndefined()
  })

  it('rejects a missing document', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 404,
      headers: new Headers({ 'content-type': 'text/html' }),
      json: async () => ({}),
    })) as unknown as typeof fetch
    await expect(checkClientMetadata(url, redirect, fetchFn)).rejects.toThrow(/not published/)
  })

  it('rejects a client_id mismatch', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ client_id: 'https://example.test/other.json', redirect_uris: [redirect] }),
    })) as unknown as typeof fetch
    await expect(checkClientMetadata(url, redirect, fetchFn)).rejects.toThrow(/must set client_id/)
  })

  it('rejects a document that omits the callback', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ client_id: url, redirect_uris: ['http://127.0.0.1:1/callback'] }),
    })) as unknown as typeof fetch
    await expect(checkClientMetadata(url, redirect, fetchFn)).rejects.toThrow(/does not list the callback/)
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

  it('keeps an expired access token usable when a refresh token exists', async () => {
    const credentials = memoryCredentials()
    const oauth = new NexscopeOAuth(fakeContext(credentials) as never, resolveConfig())
    await oauth.patchGrant({
      tokens: {
        access_token: 'old',
        token_type: 'Bearer',
        expires_in: 60,
        refresh_token: 'refresh',
      },
      savedAt: Date.now() - 60 * 60 * 1000,
    })
    expect(await oauth.hasAccessToken()).toBe(false)
    expect(await oauth.hasGrant()).toBe(true)
  })

  it('reports no grant when the store is empty', async () => {
    const oauth = new NexscopeOAuth(fakeContext() as never, resolveConfig())
    expect(await oauth.hasGrant()).toBe(false)
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

  it('removes the grant and closes the session on sign-out', async () => {
    const ctx = fakeContext()
    let signedOut = 0
    let reset = 0
    const oauth = {
      hasGrant: async () => true,
      signOut: async () => {
        signedOut += 1
      },
    }
    const tools = new NexscopeTools(
      ctx as never,
      { ...clientStub([]), reset: async () => {
        reset += 1
      } } as never,
      oauth as never,
      resolveConfig(),
    )
    const signOut = definitionsOf(tools).find((definition) => definition.name === 'nexscope_sign_out')!
    const result = (await signOut.execute({}, fakeExec())) as { signedOut: boolean; detail: string }
    expect(result.signedOut).toBe(true)
    expect(result.detail).toContain('nexscope_sign_in')
    expect(signedOut).toBe(1)
    expect(reset).toBe(1)
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

describe('export helpers', () => {
  it('selects a dot path and a JSON pointer', () => {
    const value = { data: { items: [{ id: 1 }, { id: 2 }] } }
    expect(selectJsonPath(value, 'data.items')).toEqual([{ id: 1 }, { id: 2 }])
    expect(selectJsonPath(value, '/data/items/1')).toEqual({ id: 2 })
    expect(selectJsonPath(value, '$')).toBe(value)
  })

  it('rejects a path that does not exist', () => {
    expect(() => selectJsonPath({ data: {} }, 'data.items')).toThrow(/does not exist/)
  })

  it('writes CSV with quoting and union columns', () => {
    const csv = toCsv([
      { name: 'a,b', score: 1 },
      { name: 'say "hi"', extra: true },
    ])
    expect(csv.columns).toEqual(['name', 'score', 'extra'])
    expect(csv.text).toContain('"a,b"')
    expect(csv.text).toContain('"say ""hi"""')
    expect(csv.rows).toBe(2)
  })

  it('rejects CSV for a non-array value', () => {
    expect(() => toCsv({ a: 1 })).toThrow(/needs an array/)
  })

  it('serializes JSONL and JSON', () => {
    expect(serializeExport([{ a: 1 }, { a: 2 }], 'jsonl').text).toBe('{"a":1}\n{"a":2}\n')
    expect(serializeExport({ a: 1 }, 'json').rows).toBe(1)
  })

  it('requires exactly one JSON source', async () => {
    await expect(
      exportDeliverable(
        fakeContext() as never,
        { output: 'out.csv', format: 'csv', cwd: '/tmp' },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/exactly one/)
  })

  it('rejects an output path that escapes the workspace', () => {
    expect(() => assertInsideWorkspace('../escape.csv', '/tmp/work')).toThrow(/escapes/)
    expect(assertInsideWorkspace('out.csv', '/tmp/work')).toBe('/tmp/work/out.csv')
  })

  it('passes the session working directory to the filesystem service', async () => {
    const calls: Array<{ path: string; cwd: unknown }> = []
    const fs = {
      resolve: async (path: string, options: { cwd?: unknown }) => {
        calls.push({ path, cwd: options.cwd })
        return { targetKey: path, displayPath: path }
      },
      readText: async () => '{"items":[{"a":1}]}',
      writeText: async () => undefined,
    }
    const ctx = { ...fakeContext(), fs }
    await exportDeliverable(
      ctx as never,
      { input: 'in.json', path: 'items', output: 'out.csv', format: 'csv', cwd: '/tmp/session' },
      new AbortController().signal,
    )
    expect(calls).toEqual([
      { path: '/tmp/session/in.json', cwd: '/tmp/session' },
      { path: '/tmp/session/out.csv', cwd: '/tmp/session' },
    ])
  })

  it('writes a CSV deliverable from inline JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-export-'))
    try {
      const output = join(directory, 'items.csv')
      const result = await exportDeliverable(
        fakeContext() as never,
        {
          json: JSON.stringify({ data: { items: [{ name: 'one' }, { name: 'two' }] } }),
          path: 'data.items',
          output,
          format: 'csv',
        },
        new AbortController().signal,
      )
      expect(result.rows).toBe(2)
      expect(await readFile(output, 'utf8')).toBe('name\none\ntwo\n')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('nexscope_account', () => {
  it('explains the API-key requirement when no key is configured', async () => {
    const ctx = fakeContext()
    const tools = new NexscopeTools(ctx as never, clientStub([]) as never, oauthStub() as never, resolveConfig())
    const account = definitionsOf(tools).find((definition) => definition.name === 'nexscope_account')!
    const result = (await account.execute({}, fakeExec())) as {
      available: boolean
      source: string
      text: string
    }
    expect(result.available).toBe(false)
    expect(result.source).toBe('none')
    expect(result.text).toContain('seller/credits')
  })

  it('reads credits with a configured API key', async () => {
    const ctx = fakeContext()
    ;(ctx.credentials as Record<string, unknown>).resolve = async () => ({ value: 'nk-test' })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: { netCredit: 42, permanentCredit: 40, cycleCredit: 2, debt: 0, grossConsumedCredit: 8 },
        }),
      })),
    )
    const tools = new NexscopeTools(ctx as never, clientStub([]) as never, oauthStub() as never, resolveConfig())
    const account = definitionsOf(tools).find((definition) => definition.name === 'nexscope_account')!
    const result = (await account.execute({}, fakeExec())) as {
      available: boolean
      source: string
      text: string
    }
    expect(result.available).toBe(true)
    expect(result.source).toBe('api-key')
    expect(result.text).toContain('Net credit: 42')
  })
})
