/**
 * OAuth client for the Nexscope MCP server.
 *
 * The Nexscope authorization server advertises
 * `client_id_metadata_document_supported`, so this client identifies itself
 * with a public HTTPS client-metadata document (CIMD) instead of dynamic
 * registration. Sign-in runs in the browser and returns to a loopback
 * listener, which RFC 8252 permits for native applications and which the
 * server accepts as a redirect URI.
 *
 * @module dsh-nexscope/oauth
 */
import { createServer, type Server } from 'node:http'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import {
  credentialKey,
  type CredentialKey,
  type CredentialProvider,
} from '@deepseek-ai/dsh-credentials'
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import { CALLBACK_PATH, type ResolvedConfig } from './config.js'

/** Record scope: the plugin's registered name. */
const RECORD_SCOPE = 'dsh-nexscope'

/** Record id holding the whole OAuth grant. */
const RECORD_ID = 'oauth'

/** Refuse to use an access token this close to expiry. */
const EXPIRY_SKEW_MS = 60_000

/** Durable OAuth state kept in the credential store. */
interface OAuthGrant {
  readonly tokens?: StoredOAuthTokens
  readonly savedAt?: number
  readonly client?: StoredOAuthClientInformation
  readonly verifier?: string
  readonly discovery?: OAuthDiscoveryState
  readonly resource?: string
  readonly state?: string
  readonly redirectUri?: string
}

/** Sign-in is required before this call can proceed. */
export class SignInRequiredError extends Error {
  constructor(message = 'Nexscope sign-in is required. Call nexscope_sign_in first.') {
    super(message)
    this.name = 'SignInRequiredError'
  }
}

/** The browser sign-in did not complete in time or was denied. */
export class SignInFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignInFailedError'
  }
}

/** One completed browser sign-in. */
export interface SignInResult {
  readonly status: 'signed-in' | 'already-signed-in'
  readonly redirectUri: string
}

/** Browser sign-in session state. */
interface PendingSignIn {
  readonly redirectUri: string
  readonly state: string
  readonly done: Promise<{ code: string; iss?: string }>
  readonly close: () => void
}

/** Render one small HTML page for the loopback result. */
function resultPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | Nexscope</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f8fafc;color:#0f172a;font:16px/1.6 system-ui,-apple-system,sans-serif}
main{width:min(420px,calc(100% - 32px));background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;text-align:center}
.mark{display:grid;place-items:center;width:48px;height:48px;margin:0 auto 16px;border-radius:10px;background:#ede9fe;color:#7c3aed;font-weight:700}
h1{margin:0;font-size:19px}p{margin:8px 0 0;color:#64748b;font-size:14px}</style></head>
<body><main><div class="mark">N</div><h1>${title}</h1><p>${message}</p></main></body></html>`
}

/** Open a URL with the platform's default handler. */
async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === 'darwin'
      ? { file: 'open', args: [url] }
      : process.platform === 'win32'
        ? { file: 'cmd', args: ['/c', 'start', '', url] }
        : { file: 'xdg-open', args: [url] }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.file, command.args, { stdio: 'ignore', detached: true })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Loopback OAuth client backed by the DSH credential store. */
export class NexscopeOAuth {
  readonly config: ResolvedConfig
  private readonly credentials: CredentialProvider
  private readonly key: CredentialKey
  readonly log: { info(message: string): void; warn(message: string): void }
  pending?: PendingSignIn
  /** Opens the authorization URL; tests replace the system browser. */
  openAuthorization: (url: string) => void | Promise<void> = openBrowser
  grant?: OAuthGrant
  loaded = false

  constructor(ctx: Context, config: ResolvedConfig) {
    this.config = config
    this.credentials = ctx.credentials
    this.key = credentialKey(RECORD_SCOPE, RECORD_ID)
    this.log = {
      info: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message),
    }
    this.provider = this.buildProvider(this)
  }

  /** The SDK-facing provider. */
  readonly provider: OAuthClientProvider

  /** Build the SDK-facing provider once configuration is known. */
  private buildProvider(self: NexscopeOAuth): OAuthClientProvider {
    return {
      get redirectUrl(): string {
        return self.currentRedirectUri()
      },
      clientMetadataUrl: self.config.clientMetadataUrl,
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: 'Nexscope for DeepSeek Harness',
          client_uri: 'https://www.nexscope.ai',
          redirect_uris: self.config.callbackPorts.map(
            (port) => `http://127.0.0.1:${port}${CALLBACK_PATH}`,
          ),
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: self.config.scope,
        }
      },
      state: () => self.pending?.state ?? self.grant?.state ?? newState(),
      clientInformation: (_ctx?: OAuthClientInformationContext) =>
        self.loadGrant().then((g) => g.client),
      saveClientInformation: async (information: StoredOAuthClientInformation) => {
        await self.patchGrant({ client: information })
      },
      tokens: (_ctx?: OAuthClientInformationContext) => self.loadGrant().then((g) => g.tokens),
      saveTokens: async (tokens: StoredOAuthTokens) => {
        await self.patchGrant({ tokens, savedAt: Date.now() })
        self.log.info('nexscope: OAuth tokens updated')
      },
      redirectToAuthorization: async (authorizationUrl: URL) => {
        if (self.pending === undefined) throw new SignInRequiredError()
        await self.openAuthorization(authorizationUrl.toString())
      },
      saveCodeVerifier: async (verifier: string) => {
        await self.patchGrant({ verifier })
      },
      codeVerifier: async () => {
        const grant = await self.loadGrant()
        if (grant.verifier === undefined) {
          throw new SignInFailedError('The OAuth code verifier is missing.')
        }
        return grant.verifier
      },
      saveDiscoveryState: async (state: OAuthDiscoveryState) => {
        await self.patchGrant({ discovery: state })
      },
      discoveryState: () => self.loadGrant().then((g) => g.discovery),
      saveResourceUrl: async (resource: string) => {
        await self.patchGrant({ resource })
      },
      invalidateCredentials: async (scope) => {
        if (
          scope === 'all' ||
          scope === 'tokens' ||
          scope === 'verifier' ||
          scope === 'discovery'
        ) {
          await self.patchGrant({
            tokens: undefined,
            savedAt: undefined,
            verifier: undefined,
            discovery: undefined,
          })
        }
        if (scope === 'all' || scope === 'client') {
          await self.patchGrant({ client: undefined })
        }
      },
    }
  }

  /** Whether a usable access token is currently stored. */
  async hasAccessToken(): Promise<boolean> {
    const grant = await this.loadGrant()
    const token = grant.tokens
    if (token === undefined || token.access_token === '') return false
    const expiresAt = tokenExpiry(grant)
    return expiresAt === undefined || expiresAt - EXPIRY_SKEW_MS > Date.now()
  }

  /** Read the stored access token, if any. */
  async accessToken(): Promise<string | undefined> {
    const grant = await this.loadGrant()
    return grant.tokens?.access_token
  }

  /** Forget every stored OAuth artifact. */
  async signOut(): Promise<void> {
    await this.credentials.deleteRecord(this.key)
    this.grant = {}
    this.loaded = true
  }

  /**
   * Run a browser sign-in and wait for the loopback callback.
   * @returns the completed sign-in.
   */
  async signIn(
    options: { openBrowser?: (url: string) => void | Promise<void> } = {},
  ): Promise<SignInResult> {
    this.openAuthorization = options.openBrowser ?? openBrowser
    if (await this.hasAccessToken()) {
      return { status: 'already-signed-in', redirectUri: this.currentRedirectUri() }
    }
    const { auth } = await import('@modelcontextprotocol/client')
    // A stored refresh token can renew the grant without any browser step.
    try {
      const refreshed = await auth(this.provider, { serverUrl: this.config.mcpUrl })
      if (refreshed === 'AUTHORIZED') {
        return { status: 'already-signed-in', redirectUri: this.currentRedirectUri() }
      }
    } catch (error) {
      // A missing, expired, or rejected grant is exactly what the browser
      // sign-in below is for; only an unexpected failure is worth surfacing.
      if (!(error instanceof SignInRequiredError)) {
        this.log.info(`nexscope: silent refresh unavailable: ${describe(error)}`)
      }
    }
    const pending = await this.startCallbackListener()
    this.pending = pending
    try {
      await auth(this.provider, { serverUrl: this.config.mcpUrl })
      const callback = await pending.done
      const result = await auth(this.provider, {
        serverUrl: this.config.mcpUrl,
        authorizationCode: callback.code,
        ...(callback.iss === undefined ? {} : { iss: callback.iss }),
      })
      if (result !== 'AUTHORIZED') {
        throw new SignInFailedError('The authorization code could not be exchanged for tokens.')
      }
      return { status: 'signed-in', redirectUri: pending.redirectUri }
    } finally {
      pending.close()
      this.pending = undefined
    }
  }

  /** Start the loopback listener on the first free configured port. */
  async startCallbackListener(): Promise<PendingSignIn> {
    const state = newState()
    let lastError: unknown
    for (const port of this.config.callbackPorts) {
      try {
        return await this.listen(port, state)
      } catch (error) {
        lastError = error
      }
    }
    throw new SignInFailedError(
      `No loopback port was available for the sign-in callback (${this.config.callbackPorts.join(', ')}): ${describe(lastError)}`,
    )
  }

  /** Bind one loopback port and wire the callback handler. */
  async listen(port: number, state: string): Promise<PendingSignIn> {
    let settle: (value: { code: string; iss?: string } | Error) => void = () => {}
    const done = new Promise<{ code: string; iss?: string }>((resolve, reject) => {
      settle = (value) => (value instanceof Error ? reject(value) : resolve(value))
    })
    // The callback can fail before the caller reaches its `await`; keep that
    // rejection observed so it surfaces at the await instead of as an
    // unhandled rejection in the Host process.
    void done.catch(() => {})
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        response.end('Not found')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      const iss = url.searchParams.get('iss') ?? undefined
      const html = (title: string, message: string): void => {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'referrer-policy': 'no-referrer',
        })
        response.end(resultPage(title, message))
      }
      if (error !== null) {
        html('Connection cancelled', 'Return to DeepSeek Harness and start the connection again.')
        settle(new SignInFailedError(`Authorization was not granted: ${error}`))
        return
      }
      if (returnedState !== state) {
        html('Connection rejected', 'The authorization response did not match this request.')
        settle(new SignInFailedError('The OAuth state did not match the pending sign-in.'))
        return
      }
      if (code === null || code === '') {
        html('Connection rejected', 'The authorization code was missing.')
        settle(new SignInFailedError('The authorization code was missing from the callback.'))
        return
      }
      html('Connected', 'You can close this tab and return to DeepSeek Harness.')
      settle({ code, ...(iss === undefined ? {} : { iss }) })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
    await this.patchGrant({ redirectUri, state })
    const timeout = setTimeout(() => {
      settle(new SignInFailedError('The Nexscope sign-in did not complete in time.'))
    }, this.config.signInTimeoutMs)
    timeout.unref?.()
    const close = (): void => {
      clearTimeout(timeout)
      server.close()
    }
    return { redirectUri, state, done, close }
  }

  /** The redirect URI currently advertised to the authorization server. */
  currentRedirectUri(): string {
    if (this.pending !== undefined) return this.pending.redirectUri
    if (this.grant?.redirectUri !== undefined) return this.grant.redirectUri
    return `http://127.0.0.1:${this.config.callbackPorts[0] ?? 45871}${CALLBACK_PATH}`
  }

  /** Load the durable grant once, then serve it from memory. */
  async loadGrant(): Promise<OAuthGrant> {
    if (this.loaded) return this.grant ?? {}
    const record = await this.credentials.readRecord(this.key)
    this.grant =
      record !== undefined && record.kind === 'grant' && isGrant(record.payload)
        ? record.payload
        : {}
    this.loaded = true
    return this.grant
  }

  /** Merge one patch into the durable grant. */
  async patchGrant(patch: Partial<OAuthGrant>): Promise<void> {
    const next = { ...(await this.loadGrant()), ...patch }
    this.grant = next
    this.loaded = true
    await this.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload: next }))
  }
}

/** Narrow an opaque credential payload to a stored grant. */
function isGrant(value: unknown): value is OAuthGrant {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Compute an access-token expiry from the save time the server reported. */
function tokenExpiry(grant: OAuthGrant): number | undefined {
  const tokens = grant.tokens
  if (tokens === undefined) return undefined
  if (typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in)) return undefined
  if (typeof grant.savedAt !== 'number') return undefined
  return grant.savedAt + tokens.expires_in * 1000
}

/** A URL-safe random state value. */
function newState(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/** Stable, non-secret error text. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
