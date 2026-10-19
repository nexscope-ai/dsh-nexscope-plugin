/**
 * Plugin configuration schema and resolved defaults.
 *
 * @module dsh-nexscope/config
 */
import Schema from '@deepseek-ai/schemastery';
/** Default MCP endpoint used for the Nexscope v2 skill API. */
export declare const DEFAULT_MCP_URL = "https://api.nexscope.ai/api/skill-api/v2/mcp";
/** Default OAuth scope required by the Nexscope MCP resource. */
export declare const DEFAULT_SCOPE = "mcp:tools";
/**
 * Published CIMD document used as this client's `client_id`.
 *
 * The Nexscope authorization server advertises
 * `client_id_metadata_document_supported`, so a URL client id is resolved by
 * the server from this document instead of dynamic registration.
 */
export declare const DEFAULT_CLIENT_METADATA_URL = "https://www.nexscope.ai/.well-known/dsh-nexscope-client.json";
/** Callback path appended to the loopback redirect origin. */
export declare const CALLBACK_PATH = "/callback";
/** Plugin configuration accepted from the profile patch. */
export declare const Config: Schema<Schemastery.ObjectS<NoInfer<{
    mcpUrl: Schema<string, string, "defined">;
    scope: Schema<string, string, "defined">;
    clientMetadataUrl: Schema<string, string, "defined">;
    signInTimeoutMs: Schema<number, number, "defined">;
    toolCallTimeoutMs: Schema<number, number, "defined">;
    maxInlineBytes: Schema<number, number, "defined">;
    callbackPorts: Schema<number[], number[], "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    mcpUrl: Schema<string, string, "defined">;
    scope: Schema<string, string, "defined">;
    clientMetadataUrl: Schema<string, string, "defined">;
    signInTimeoutMs: Schema<number, number, "defined">;
    toolCallTimeoutMs: Schema<number, number, "defined">;
    maxInlineBytes: Schema<number, number, "defined">;
    callbackPorts: Schema<number[], number[], "defined">;
}>>, "plain">;
/** Resolved configuration with every default applied. */
export interface ResolvedConfig {
    readonly mcpUrl: string;
    readonly scope: string;
    readonly clientMetadataUrl: string;
    readonly signInTimeoutMs: number;
    readonly toolCallTimeoutMs: number;
    readonly maxInlineBytes: number;
    readonly callbackPorts: readonly number[];
}
/**
 * Normalize a validated config value.
 * @param config - partially resolved configuration from the Loader.
 * @returns the configuration with every default applied.
 */
export declare function resolveConfig(config?: Partial<ResolvedConfig>): ResolvedConfig;
