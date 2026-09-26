/**
 * Transport factory: creates the appropriate MCP transport based on the
 * plugin's resolved config. Stdio spawns a child process (with credential
 * scrubbing); Streamable HTTP and legacy SSE connect to a URL. Both URL
 * transports attach the configured headers to every request and, when the
 * server is configured with `auth`, the same OAuth 2.1 client provider.
 *
 * @module
 */

import type { OAuthClientProvider, Transport } from '@modelcontextprotocol/client'
import { SSEClientTransport, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './index.ts'

/**
 * The subprocess seam's scrubbed parent env (credential-shaped and stale
 * `DSH_*` names dropped), plus the spec's explicit env. The MCP SDK owns the
 * actual spawn, so this transport shares the scrub definition rather than the
 * spawn path.
 */
function buildChildEnv(extra: Record<string, string>): Record<string, string> {
  return { ...scrubbedParentEnv(), ...extra }
}

/**
 * The auth option object for one URL transport: absent entirely when the server
 * has no `auth` block, so an unauthenticated server never reaches an auth seam.
 * @param authProvider - the provider resolved for this plugin instance, or undefined.
 * @returns the option entry to spread into the transport options.
 */
function authOption(authProvider: OAuthClientProvider | undefined): { authProvider?: OAuthClientProvider } {
  return authProvider === undefined ? {} : { authProvider }
}

/**
 * Create an MCP transport from the resolved plugin config.
 *
 * @param config - Resolved plugin config discriminated on `transport`.
 * @param authProvider - OAuth 2.1 provider for a server configured with `auth`;
 *   omitted for every other server.
 * @returns A connected-ready MCP Transport (stdio, legacy SSE, or Streamable HTTP).
 */
export function createTransport(config: Config, authProvider?: OAuthClientProvider): Transport {
  switch (config.transport) {
    case 'stdio':
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: buildChildEnv(config.env),
        cwd: config.cwd,
      })
    case 'sse':
      // oxlint-disable-next-line typescript/no-deprecated -- legacy SSE servers need it; the SDK ships no other SSE client.
      return new SSEClientTransport(new URL(config.url), {
        ...authOption(authProvider),
        requestInit: { headers: config.headers },
      })
    case 'streamable-http':
      return new StreamableHTTPClientTransport(new URL(config.url), {
        ...authOption(authProvider),
        requestInit: { headers: config.headers },
      })
  }
}
