/**
 * Nexscope for DeepSeek Harness.
 *
 * The plugin connects one Nexscope MCP session with OAuth, registers a small
 * discovery surface over the published capability catalog, and contributes a
 * bundled `nexscope` skill with the routing and credit rules.
 *
 * @module dsh-nexscope
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { Config, resolveConfig, type ResolvedConfig } from './config.js'
import { NexscopeClient } from './client.js'
import { NexscopeOAuth, describe } from './oauth.js'
import { NexscopeTools } from './tools.js'

/** Cordis plugin name, which is also the credential record scope. */
export const name = 'nexscope'

/** Services the plugin needs before it can load. */
export const inject = ['tools', 'credentials', 'skills']

export { Config }

/** The bundled skill body and its resource base. */
const SKILL_URL = new URL('../skills/nexscope/SKILL.md', import.meta.url)
const SKILL_RESOURCE_BASE = {
  kind: 'directory' as const,
  path: fileURLToPath(new URL('../skills/nexscope/', import.meta.url)),
}

/** Short routing description shown in the session skill catalog. */
const SKILL_DESCRIPTION =
  'Research ecommerce products, keywords, markets, competitors, reviews, and advertising with Nexscope. Use for Amazon, TikTok, Temu, Shopee, 1688, eBay, Etsy, and Walmart data, saved result files, and Nexscope account or credit questions. Do not use for unrelated coding, general writing, or arbitrary browser automation.'

/** The bundled skill provider. */
const skillProvider = {
  name: 'nexscope',
  list: () =>
    Promise.resolve([
      {
        name: 'nexscope',
        description: SKILL_DESCRIPTION,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'nexscope',
        source: 'bundled',
        resourceBase: SKILL_RESOURCE_BASE,
        rank: BUNDLED_SKILL_RANK,
        locator: SKILL_URL,
      },
    ]),
  async get(_candidate: unknown) {
    return {
      name: 'nexscope',
      description: SKILL_DESCRIPTION,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'nexscope',
      source: 'bundled',
      resourceBase: SKILL_RESOURCE_BASE,
      content: await readFile(SKILL_URL, 'utf8'),
    }
  },
}

/**
 * Mount the plugin.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: ResolvedConfig = resolveConfig()): void {
  const resolved = resolveConfig(config)
  const oauth = new NexscopeOAuth(ctx, resolved)
  const client = new NexscopeClient(ctx, resolved, oauth)
  const tools = new NexscopeTools(ctx, client, oauth)

  tools.install(ctx.tools)
  ctx.skills.registerProvider(() => skillProvider)

  ctx.effect(() => {
    return () => {
      tools.dispose()
      void client.close()
    }
  })

  // Warm the session in the background so the first tool call does not pay
  // for the OAuth refresh and MCP handshake. A missing grant is expected:
  // `nexscope_sign_in` is the user-visible path, so the skip is logged at
  // info level once and never as an error.
  void client
    .connect()
    .then(() => {
      tools.invalidateCatalog()
    })
    .catch((error: unknown) => {
      ctx.logger.info(`nexscope: no session yet (${describe(error)})`)
    })

  ctx.logger.info('nexscope: plugin loaded')
}
