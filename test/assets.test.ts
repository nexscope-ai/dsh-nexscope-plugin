/**
 * Guard the two public artifacts that are easy to break by hand: the OAuth
 * client metadata document and the plugin market index.
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const CLIENT_ID = 'https://www.nexscope.ai/.well-known/dsh-nexscope-client.json'
const INDEX_URL = 'https://www.nexscope.ai/dsh/index.json'

describe('client metadata document', () => {
  it('matches the shipped client id and callback contract', async () => {
    const raw = await readFile(new URL('../public/dsh-nexscope-client.json', import.meta.url), 'utf8')
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    const document = JSON.parse(raw) as Record<string, unknown>
    expect(document.client_id).toBe(CLIENT_ID)
    expect(document.client_name).toBe('Nexscope for DeepSeek Harness')
    expect(document.client_uri).toBe('https://www.nexscope.ai')
    expect(document.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(document.response_types).toEqual(['code'])
    expect(document.token_endpoint_auth_method).toBe('none')
    expect(document.scope).toBe('mcp:tools')
    const redirects = document.redirect_uris as string[]
    expect(redirects).toHaveLength(3)
    expect(redirects).toContain('http://127.0.0.1:45871/callback')
    expect(redirects).toContain('http://127.0.0.1:45872/callback')
    expect(redirects).toContain('http://127.0.0.1:45873/callback')
  })
})

describe('market index', () => {
  it('parses and matches the package engines and icon', async () => {
    const raw = JSON.parse(
      await readFile(new URL('../market/index.json', import.meta.url), 'utf8'),
    ) as unknown
    const parsed = parseMarketIndex(raw, INDEX_URL)
    expect(parsed.plugins).toHaveLength(1)
    const plugin = parsed.plugins[0]!
    expect(plugin.name).toBe('@nexscope/dsh-nexscope')
    expect(plugin.icon).toBe('https://www.nexscope.ai/dsh/icons/nexscope.png')
    const version = plugin.versions[0]!
    expect(version.source.type).toBe('npm')

    const pkg = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { engines?: { dsh?: string }; version?: string }
    // The index must advertise the version the package actually ships, so a
    // release cannot publish one number and list another.
    expect(version.version).toBe(pkg.version)
    expect(version.engines?.dsh).toBe(pkg.engines?.dsh)
  })

  it('ships a PNG icon under the 32 KiB inline limit', async () => {
    const icon = await readFile(new URL('../market/icons/nexscope.png', import.meta.url))
    expect(icon.byteLength).toBeLessThanOrEqual(32 * 1024)
    expect([...icon.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })
})
