import type { Context } from '@deepseek-ai/cordis';
import type { OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from '@modelcontextprotocol/client';
import { type ResolvedConfig } from './config.js';
/** Durable OAuth state kept in the credential store. */
interface OAuthGrant {
    readonly tokens?: StoredOAuthTokens;
    readonly savedAt?: number;
    readonly client?: StoredOAuthClientInformation;
    readonly verifier?: string;
    readonly discovery?: OAuthDiscoveryState;
    readonly resource?: string;
    readonly state?: string;
    readonly redirectUri?: string;
}
/** Sign-in is required before this call can proceed. */
export declare class SignInRequiredError extends Error {
    constructor(message?: string);
}
/** The browser sign-in did not complete in time or was denied. */
export declare class SignInFailedError extends Error {
    constructor(message: string);
}
/** One completed browser sign-in. */
export interface SignInResult {
    readonly status: 'signed-in' | 'already-signed-in';
    readonly redirectUri: string;
}
/** Browser sign-in session state. */
interface PendingSignIn {
    readonly redirectUri: string;
    readonly state: string;
    readonly done: Promise<{
        code: string;
        iss?: string;
    }>;
    readonly close: () => void;
}
/** Loopback OAuth client backed by the DSH credential store. */
export declare class NexscopeOAuth {
    readonly config: ResolvedConfig;
    private readonly credentials;
    private readonly key;
    readonly log: {
        info(message: string): void;
        warn(message: string): void;
    };
    pending?: PendingSignIn;
    grant?: OAuthGrant;
    loaded: boolean;
    constructor(ctx: Context, config: ResolvedConfig);
    /** The SDK-facing provider. */
    readonly provider: OAuthClientProvider;
    /** Build the SDK-facing provider once configuration is known. */
    private buildProvider;
    /** Whether a usable access token is currently stored. */
    hasAccessToken(): Promise<boolean>;
    /** Read the stored access token, if any. */
    accessToken(): Promise<string | undefined>;
    /** Forget every stored OAuth artifact. */
    signOut(): Promise<void>;
    /**
     * Run a browser sign-in and wait for the loopback callback.
     * @returns the completed sign-in.
     */
    signIn(): Promise<SignInResult>;
    /** Start the loopback listener on the first free configured port. */
    startCallbackListener(): Promise<PendingSignIn>;
    /** Bind one loopback port and wire the callback handler. */
    listen(port: number, state: string): Promise<PendingSignIn>;
    /** The redirect URI currently advertised to the authorization server. */
    currentRedirectUri(): string;
    /** Load the durable grant once, then serve it from memory. */
    loadGrant(): Promise<OAuthGrant>;
    /** Merge one patch into the durable grant. */
    patchGrant(patch: Partial<OAuthGrant>): Promise<void>;
}
/** Stable, non-secret error text. */
export declare function describe(error: unknown): string;
export {};
