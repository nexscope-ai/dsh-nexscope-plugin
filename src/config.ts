/**
 * Plugin configuration schema and resolved defaults.
 *
 * @module dsh-nexscope/config
 */
import Schema from '@deepseek-ai/schemastery'

/** Default MCP endpoint used for the Nexscope v2 skill API. */
export const DEFAULT_MCP_URL = 'https://api.nexscope.ai/api/skill-api/v2/mcp'

/** Default OAuth scope required by the Nexscope MCP resource. */
export const DEFAULT_SCOPE = 'mcp:tools'

/**
 * Published CIMD document used as this client's `client_id`.
 *
 * The Nexscope authorization server advertises
 * `client_id_metadata_document_supported`, so a URL client id is resolved by
 * the server from this document instead of dynamic registration.
 */
export const DEFAULT_CLIENT_METADATA_URL =
  'https://www.nexscope.ai/.well-known/dsh-nexscope-client.json'

/** Callback path appended to the loopback redirect origin. */
export const CALLBACK_PATH = '/callback'

/** Plugin configuration accepted from the profile patch. */
export const Config = Schema.object({
  mcpUrl: Schema.string().default(DEFAULT_MCP_URL).description(
    'Streamable HTTP MCP endpoint for the Nexscope skill API.',
  ),
  scope: Schema.string().default(DEFAULT_SCOPE).description('OAuth scope requested at sign-in.'),
  clientMetadataUrl: Schema.string().default(DEFAULT_CLIENT_METADATA_URL).description(
    'Public client metadata document used as the OAuth client_id.',
  ),
  signInTimeoutMs: Schema.natural().default(300_000).description(
    'How long a pending browser sign-in stays open before it expires.',
  ),
  toolCallTimeoutMs: Schema.natural().default(120_000).description(
    'Per-call MCP timeout in milliseconds.',
  ),
  maxInlineBytes: Schema.natural().default(60_000).description(
    'Largest tool result kept inline before it is written to a file.',
  ),
  callbackPorts: Schema.array(Schema.natural()).default([45871, 45872, 45873]).description(
    'Loopback ports tried for the OAuth callback listener.',
  ),
})

/** Resolved configuration with every default applied. */
export interface ResolvedConfig {
  readonly mcpUrl: string
  readonly scope: string
  readonly clientMetadataUrl: string
  readonly signInTimeoutMs: number
  readonly toolCallTimeoutMs: number
  readonly maxInlineBytes: number
  readonly callbackPorts: readonly number[]
}

/**
 * Normalize a validated config value.
 * @param config - partially resolved configuration from the Loader.
 * @returns the configuration with every default applied.
 */
export function resolveConfig(config: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    mcpUrl: config.mcpUrl ?? DEFAULT_MCP_URL,
    scope: config.scope ?? DEFAULT_SCOPE,
    clientMetadataUrl: config.clientMetadataUrl ?? DEFAULT_CLIENT_METADATA_URL,
    signInTimeoutMs: config.signInTimeoutMs ?? 300_000,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 120_000,
    maxInlineBytes: config.maxInlineBytes ?? 60_000,
    callbackPorts:
      config.callbackPorts !== undefined && config.callbackPorts.length > 0
        ? [...config.callbackPorts]
        : [45871, 45872, 45873],
  }
}
