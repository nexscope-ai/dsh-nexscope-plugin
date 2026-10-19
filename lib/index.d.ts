import type { Context } from '@deepseek-ai/cordis';
import { Config, type ResolvedConfig } from './config.js';
/** Cordis plugin name, which is also the credential record scope. */
export declare const name = "nexscope";
/** Services the plugin needs before it can load. */
export declare const inject: string[];
export { Config };
/**
 * Mount the plugin.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export declare function apply(ctx: Context, config?: ResolvedConfig): void;
