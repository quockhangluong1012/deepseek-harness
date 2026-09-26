/**
 * OAuth 2.1 authorization-code (PKCE) support for one MCP server.
 *
 * The SDK owns discovery, dynamic client registration, the S256 challenge, and
 * the token exchange; this module supplies the two ends it cannot own: an
 * {@link OAuthClientProvider} whose tokens, client registration, PKCE verifier,
 * and `state` live in a credential record of the credentials seam (never a
 * file this plugin writes), and the human-facing authorization flow a
 * configuration surface runs to hand the callback back.
 *
 * @module @deepseek-ai/dsh-mcp-client
 */

import { createHash, randomBytes } from 'node:crypto'
import { auth } from '@modelcontextprotocol/client'
import type {
  OAuthClientMetadata, OAuthClientProvider, StoredOAuthClientInformation, StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { Config } from './index.ts'

/** Credential-record scope owning every MCP server's OAuth grant. */
const CREDENTIAL_SCOPE = 'mcp-client'

/** The plugin's display name in an authorization server's consent screen. */
const CLIENT_NAME = 'DeepSeek Harness'

/** Random bytes behind one `state` parameter (RFC 6749 §10.12). */
const STATE_BYTES = 16

/** Hex characters of the record-id digest appended when a server name is not already a record id. */
const ID_HASH_LENGTH = 8

/**
 * Settings the SDK's authorization-code flow needs from plugin config.
 * Resolved once at plugin load so a misconfigured `auth` block fails loud.
 */
export interface McpOAuthSettings {
  /** The protected resource the flow authorizes against. */
  readonly serverUrl: URL
  /** Redirect URI registered with the authorization server. */
  readonly redirectUrl: string
  /** Scope to request; omitted lets the authorization server decide. */
  readonly scope: string | undefined
}

/** Fields one server's credential record payload carries, written only here. */
interface McpOAuthRecord {
  tokens?: StoredOAuthTokens
  clientInformation?: StoredOAuthClientInformation
  codeVerifier?: string
  state?: string
}

/**
 * Resolve the OAuth settings of one URL-transported server.
 *
 * @param config - resolved plugin config.
 * @param path - diagnostic prefix naming the config location in thrown messages.
 * @returns the resolved settings, or undefined when the server configures no `auth`.
 * @throws When `redirectUrl` is not an absolute HTTP(S) URL.
 */
export function resolveOAuthSettings(config: Config, path: string): McpOAuthSettings | undefined {
  if (config.transport === 'stdio' || config.auth === undefined) return undefined
  const redirect = new URL(config.auth.redirectUrl, 'invalid:')
  if (redirect.protocol !== 'http:' && redirect.protocol !== 'https:') {
    throw new Error(`${path}.auth.redirectUrl must be an absolute HTTP(S) URL`)
  }
  return { serverUrl: new URL(config.url), redirectUrl: redirect.href, scope: config.auth.scope }
}

/**
 * Derive one server's credential-record id from its `serverName`. The seam's id
 * grammar is a lowercase hyphenated identifier, so a name that is not already
 * one is case-folded and hashed — two servers never share one grant.
 * @param serverName - the plugin's configured namespace.
 * @returns the record id under the `mcp-client` scope.
 */
export function oauthRecordId(serverName: string): string {
  const normalized = serverName.toLowerCase().replace(/_/g, '-')
  if (normalized === serverName) return `server-${normalized}`
  const digest = createHash('sha256').update(serverName).digest('hex').slice(0, ID_HASH_LENGTH)
  return `server-${normalized}-${digest}`
}

/** Read the record payload this module owns, tolerating a foreign or absent record. */
function payloadOf(record: CredentialRecord | undefined): McpOAuthRecord {
  if (record === undefined || record.kind !== 'grant') return {}
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {}
  return payload
}

/** One field removed from a stored payload. */
function omit(current: McpOAuthRecord, field: keyof McpOAuthRecord): McpOAuthRecord {
  const { [field]: _removed, ...rest } = current
  return rest
}

/**
 * Read the callback the human pasted. A full callback URL must carry the
 * `state` this provider issued, which is the mix-up check the SDK leaves to the
 * caller; a bare code carries no state and is bound to the stored verifier instead.
 * @param input - the pasted code or callback URL.
 * @param record - the stored payload holding the issued `state`.
 * @param label - diagnostic prefix.
 * @returns the exchange parameters.
 * @throws When the URL carries no code, or its `state` does not match.
 */
function callbackOf(input: string, record: McpOAuthRecord, label: string): { authorizationCode: string; iss?: string } {
  let callback: URL
  try {
    callback = new URL(input)
  } catch {
    return { authorizationCode: input }
  }
  const code = callback.searchParams.get('code')
  if (code === null) throw new Error(`${label}: the callback URL carries no authorization code`)
  if (callback.searchParams.get('state') !== record.state) {
    throw new Error(`${label}: the callback state does not match the authorization this client started`)
  }
  const iss = callback.searchParams.get('iss')
  return { authorizationCode: code, ...iss === null ? {} : { iss } }
}

/**
 * Start OAuth support for one MCP server: build the provider over the
 * credentials seam and register the interactive authorization flow.
 *
 * @param ctx - the server plugin's registration scope and effect owner.
 * @param serverName - the plugin's configured namespace, used in the flow label.
 * @param settings - resolved settings from {@link resolveOAuthSettings}.
 * @returns the provider every transport generation of this server authenticates through.
 * @throws When no credentials service is mounted — an `auth` block cannot store tokens without one.
 */
export function startOAuth(ctx: Context, serverName: string, settings: McpOAuthSettings): OAuthClientProvider {
  const label = `mcp-client(${serverName})`
  const flowName = `MCP server "${serverName}"`
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error(`${label}: auth requires the credentials service (ctx.credentials) to store tokens`)
  }
  const key: CredentialKey = credentialKey(CREDENTIAL_SCOPE, oauthRecordId(serverName))
  const flowOptions = {
    serverUrl: settings.serverUrl,
    ...settings.scope === undefined ? {} : { scope: settings.scope },
  }

  const read = async (): Promise<McpOAuthRecord> => payloadOf(await credentials.readRecord(key))
  /** Read-decide-replace through the seam's only write path. */
  const update = async (mutate: (current: McpOAuthRecord) => McpOAuthRecord): Promise<void> => {
    await credentials.modifyRecord(key, (record) => {
      const next = mutate(payloadOf(record))
      return Promise.resolve(Object.keys(next).length === 0 ? undefined : { kind: 'grant', payload: next })
    })
  }
  /** The seam requires a flow to own a record written during its attempt. */
  const commit = async (session: AuthorizationSession, record: McpOAuthRecord): Promise<void> => {
    if (Object.keys(record).length === 0) {
      throw new Error(`${label}: the authorization exchange stored no credential record`)
    }
    await session.commit({ kind: 'grant', payload: record })
  }

  /** The authorization page the last discovery or 401 challenge produced. */
  let pendingAuthorizationUrl: URL | undefined
  const provider: OAuthClientProvider = {
    get redirectUrl(): string {
      return settings.redirectUrl
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [settings.redirectUrl],
        client_name: CLIENT_NAME,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        // A public client with no secret: PKCE is the proof of possession.
        token_endpoint_auth_method: 'none',
        ...settings.scope === undefined ? {} : { scope: settings.scope },
      }
    },
    async state(): Promise<string> {
      const state = randomBytes(STATE_BYTES).toString('hex')
      await update(current => ({ ...current, state }))
      return state
    },
    async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
      return (await read()).clientInformation
    },
    async saveClientInformation(clientInformation: StoredOAuthClientInformation): Promise<void> {
      await update(current => ({ ...current, clientInformation }))
    },
    async tokens(): Promise<StoredOAuthTokens | undefined> {
      return (await read()).tokens
    },
    async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
      await update(current => ({ ...current, tokens }))
    },
    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      await update(current => ({ ...current, codeVerifier }))
    },
    async codeVerifier(): Promise<string> {
      const verifier = (await read()).codeVerifier
      if (verifier === undefined) {
        throw new Error(`${label}: no PKCE code verifier is stored — start the authorization flow again`)
      }
      return verifier
    },
    redirectToAuthorization(url: URL): void {
      pendingAuthorizationUrl = url
      ctx.logger.warn(`${label}: authorization required; run the "${flowName}" authorization flow, or open ${url.href}`)
    },
    async invalidateCredentials(scope): Promise<void> {
      await update((current) => {
        switch (scope) {
          case 'client': return omit(current, 'clientInformation')
          case 'tokens': return omit(current, 'tokens')
          case 'verifier': return omit(current, 'codeVerifier')
          case 'all': return omit(omit(omit(current, 'tokens'), 'clientInformation'), 'codeVerifier')
          // Discovery state is never stored: nothing to invalidate.
          case 'discovery': return current
        }
      })
    },
  }

  // The flow's fiber follows this plugin instance; a surface lists it from
  // `ctx.authorization.list()` and runs it from `begin()`, which is the whole
  // interactive half of the authorization-code exchange.
  ctx.inject(['authorization'], (authorized) => {
    authorized.authorization.registerFlow({
      key,
      label: flowName,
      methods: [{ id: 'oauth', label: 'Sign in through a browser' }],
      run: async (session) => {
        session.signal.throwIfAborted()
        if (await auth(provider, flowOptions) === 'AUTHORIZED') {
          // Stored tokens were already valid (or the SDK just refreshed them);
          // committing what the provider holds satisfies the seam's requirement
          // that this attempt wrote the record.
          await commit(session, await read())
          return
        }
        if (pendingAuthorizationUrl === undefined) {
          /* v8 ignore next 3 -- the SDK always calls redirectToAuthorization before returning REDIRECT */
          throw new Error(`${label}: the authorization server returned no authorization URL`)
        }
        session.notify({
          message: `Authorize the MCP server "${serverName}" in your browser, then paste the code it returns`,
          url: pendingAuthorizationUrl.href,
        })
        const input = (await session.prompt({
          kind: 'text',
          message: 'Authorization code, or the full callback URL',
          placeholder: 'code or https://…/callback?code=…&state=…',
        })).trim()
        if (input === '') throw new Error(`${label}: no authorization code was entered`)
        await auth(provider, { ...flowOptions, ...callbackOf(input, await read(), label) })
        await commit(session, await read())
      },
    })
  })
  return provider
}
