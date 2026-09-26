/**
 * Wire types of the MCP server management surface: the merged view of the
 * project and user config files, the declarations a management client may
 * write, and the outcomes it reads back. A view never carries credential
 * material — server `env` and `headers` appear as key names only, because a
 * value written once is never read back through this surface.
 *
 * @module @deepseek-ai/dsh-mcp-project-config/types
 */

import type { TrustLabel } from '@deepseek-ai/dsh-agent-kernel'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * The connection states a mounted server reports. Declared as this surface's
 * own wire vocabulary: `dsh-mcp-client` is Host-only, and a Remote signature
 * references Client-safe types. The Host passes the reported state through, so
 * a state added there fails to compile until it is declared here.
 */
export type McpConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/** Which of the two config files a declaration lives in. */
export type McpServerLayer = 'project' | 'user'

/** A configured endpoint, described without its credential values. */
export type McpServerEndpoint =
  | {
    /** Start a local process over stdio. */
    readonly transport: 'stdio'
    /** The executable the client starts. */
    readonly command: string
    /** Arguments passed to the executable. */
    readonly args: readonly string[]
    /** Names of the environment variables the declaration sets; never their values. */
    readonly envKeys: readonly string[]
  }
  | {
    /** Reach a remote endpoint over Streamable HTTP. */
    readonly transport: 'http'
    /** The absolute endpoint URL. */
    readonly url: string
    /** Names of the request headers the declaration sets; never their values. */
    readonly headerNames: readonly string[]
  }

/**
 * A server's live state. `mounting` covers the window between a write and the
 * mounted client's first reported state; `not-mounted` is a declaration the
 * Host holds but does not run, with the reason it does not.
 */
export type McpServerState =
  | {
    /** A `dsh-mcp-client` instance runs for this declaration. */
    readonly kind: 'mounted'
    /** The connection state that instance last reported. */
    readonly status: McpConnectionStatus
    /** Consecutive failed attempts since its last successful connection; 0 while connected. */
    readonly attempt: number
    /** Its attempt budget for one outage; 0 when reconnect is disabled. */
    readonly maxAttempts: number
  }
  | {
    /** No instance runs for this declaration. */
    readonly kind: 'not-mounted'
    /** Why it does not run: a rejected declaration, or a write not yet mounted. */
    readonly reason: string
  }

/** One configured server as the management surface sees it. */
export interface McpServerView {
  /** The `mcpServers` key as declared in the file. */
  readonly name: string
  /** The layer whose declaration won; a project declaration overrides a user one. */
  readonly layer: McpServerLayer
  /** How far this server's content may be trusted, as declared. */
  readonly trust: TrustLabel
  /** The endpoint, or `null` when the declaration was rejected. */
  readonly endpoint: McpServerEndpoint | null
  /** The normalized tool namespace the client registers under, or `null` when rejected. */
  readonly serverName: string | null
  /** The live state. */
  readonly state: McpServerState
}

/** The merged view of both config files. */
export interface McpServersView {
  /** Every declared server: project-layer names first in file order, then user-layer names no project declaration overrides. */
  readonly servers: readonly McpServerView[]
  /** Absolute path of the project config file this view read. */
  readonly projectPath: string
  /** Absolute path of the user config file this view read. */
  readonly userPath: string
}

/**
 * One server declaration to write into one config file. A write that extends
 * what the harness can reach asks the approval seam first; a write that only
 * replaces or reduces reach does not.
 */
export interface McpServerUpsert {
  /** The `mcpServers` key to write; an existing declaration of this name in the layer is replaced. */
  readonly name: string
  /** The file to write; the other layer is left untouched. */
  readonly layer: McpServerLayer
  /** Transport the declaration selects. */
  readonly transport: 'stdio' | 'http'
  /** The executable to start; required for `stdio`, ignored otherwise. */
  readonly command?: string
  /** Arguments for the executable; absent means none. */
  readonly args?: readonly string[]
  /** Environment variables to set; values are written and never read back. */
  readonly env?: Readonly<Record<string, string>>
  /** The absolute endpoint URL; required for `http`, ignored otherwise. */
  readonly url?: string
  /** Request headers to send; values are written and never read back. */
  readonly headers?: Readonly<Record<string, string>>
  /**
   * Whether the stored `env`/`headers` values of an existing declaration are
   * kept, with the request's pairs merged over them. Set when editing a
   * declaration whose values the surface never reads, so a save cannot drop
   * them; absent or false writes exactly the pairs the request carries.
   */
  readonly keepStoredSecrets?: boolean
  /** How far the server's content may be trusted; absent keeps the untrusted default. */
  readonly trust?: TrustLabel
  /**
   * The live session whose open turn carries the approval ask. The Host asks
   * `user-approval` for an agent it resolves from this session, so a change
   * that extends reach is refused when no live agent is asking.
   */
  readonly sessionId: SessionId
}

/** One server declaration to delete from one config file. */
export interface McpServerRemove {
  /** The `mcpServers` key to delete. */
  readonly name: string
  /** The file to delete it from. */
  readonly layer: McpServerLayer
  /**
   * The live session whose open turn carries the approval ask. A deletion
   * that exposes a declaration the other layer masks needs one, because that
   * declaration starts running; deleting the last declaration of a name does not.
   */
  readonly sessionId: SessionId
}

/** Why a mutation changed nothing. Each is rendered as localized copy by the surface. */
export type McpMutationRefusal =
  /** The change extends what the harness can reach and no approval channel answered for it. */
  | 'approval-required'
  /** The approval seam reported the user declined, or ended the ask. */
  | 'approval-refused'
  /** The requested declaration is not a mountable server. */
  | 'invalid-declaration'
  /** The named layer holds no declaration of that name. */
  | 'unknown-server'
  /** The config file is not readable as a JSON object, so writing it would discard hand edits. */
  | 'unreadable-config'

/** One mutation's outcome: the merged view in force afterwards, and why it is unchanged when it is. */
export interface McpMutationOutcome {
  /** Whether the file changed. */
  readonly ok: boolean
  /** Why nothing changed; `null` when `ok`. */
  readonly refusal: McpMutationRefusal | null
  /** Detail for logs and the surface; never credential material. */
  readonly detail: string | null
  /** The view after the attempt: the fresh state on success, the unchanged state otherwise. */
  readonly view: McpServersView
}
