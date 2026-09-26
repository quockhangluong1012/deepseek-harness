/**
 * Client-capability bridge between one ACP connection's advertised client
 * capabilities and the capability-seam providers this package ships.
 *
 * The bridge owns three facts the seam providers cannot learn from their own
 * calls: whether the connected client offers `terminal/*` or the `fs/*` text
 * methods, the live `AgentContext` to reach it, and which ACP session a
 * session-less seam call belongs to. Routing is deliberately conservative: a
 * call that cannot be attributed to exactly one ACP session is left to the
 * composition's local behavior instead of being sent to the wrong session.
 *
 * @module @deepseek-ai/dsh-acp/client
 */

import { Context, Service } from '@deepseek-ai/cordis'
import {
  methods,
  type AgentContext,
  type CreateTerminalRequest,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type TerminalId,
  type TerminalOutputResponse,
  type WaitForTerminalExitResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from '@agentclientprotocol/sdk'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { DshEnvironment, DshEnvironmentKey } from '@deepseek-ai/dsh-shell'
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * The `DSH_*` session-identity key `dsh-shell-env` stamps into every managed
 * snapshot. Kept member-identical to `@deepseek-ai/dsh-shell-env` without a
 * cross-seam dependency; change both together.
 */
const DSH_SESSION_ID_KEY = 'DSH_SESSION_ID' as DshEnvironmentKey

/** The optional ACP client surfaces this package delegates through. */
export interface AcpClientCapabilities {
  /** The client accepts every `terminal/*` method (`ClientCapabilities.terminal`). */
  readonly terminal: boolean
  /** The client serves `fs/read_text_file` (`ClientCapabilities.fs.readTextFile`). */
  readonly readTextFile: boolean
  /** The client serves `fs/write_text_file` (`ClientCapabilities.fs.writeTextFile`). */
  readonly writeTextFile: boolean
}

/** The capability set of a client that advertised nothing. */
const NO_CAPABILITIES: AcpClientCapabilities = Object.freeze({
  terminal: false,
  readTextFile: false,
  writeTextFile: false,
})

/** One tracked ACP session: the identity and the workspaces a seam call routes by. */
interface TrackedSession {
  readonly id: SessionId
  /** The workspace exactly as the client declared it. */
  readonly cwd: string
  /** The same workspace as the host filesystem's canonical path. */
  readonly canonicalCwd: string
}

/** A seam call reached the provider before any client connection was bound. */
export class AcpClientUnboundError extends Error {
  override readonly name = 'AcpClientUnboundError'
}

/**
 * The surfaces of one client terminal: `terminal/create` answers with the id,
 * and these four requests address it. The SDK builds its own `TerminalHandle`
 * only inside its deprecated connection class, which the one-context
 * `AgentContext` this bridge holds does not extend.
 */
export interface AcpTerminalHandle {
  /** The terminal's output so far, and whether the client truncated it. */
  currentOutput(): Promise<TerminalOutputResponse>
  /** Wait for the command to settle; `exitCode`/`signal` are null when unreported. */
  waitForExit(): Promise<WaitForTerminalExitResponse>
  /** Stop the command, leaving the terminal readable. */
  kill(): Promise<void>
  /** Free the terminal and its process; the id is invalid afterwards. */
  release(): Promise<void>
}

/** One client terminal addressed by the `terminal/*` requests. */
class AcpTerminal implements AcpTerminalHandle {
  constructor(
    private readonly connection: AgentContext,
    private readonly sessionId: CreateTerminalRequest['sessionId'],
    private readonly terminalId: TerminalId,
  ) {}

  currentOutput(): Promise<TerminalOutputResponse> {
    return this.connection.request(methods.client.terminal.output, {
      sessionId: this.sessionId,
      terminalId: this.terminalId,
    })
  }

  waitForExit(): Promise<WaitForTerminalExitResponse> {
    return this.connection.request(methods.client.terminal.waitForExit, {
      sessionId: this.sessionId,
      terminalId: this.terminalId,
    })
  }

  async kill(): Promise<void> {
    await this.connection.request(methods.client.terminal.kill, {
      sessionId: this.sessionId,
      terminalId: this.terminalId,
    })
  }

  async release(): Promise<void> {
    await this.connection.request(methods.client.terminal.release, {
      sessionId: this.sessionId,
      terminalId: this.terminalId,
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    acpClient: AcpClient
  }
}

/**
 * Cordis service provided by the ACP plugin: the connected client's advertised
 * capabilities, its live connection, and the session routing table. Providers
 * resolve it for every call, so a reload of either side is observed
 * immediately; an unbound or uninitialized connection advertises no
 * capabilities and every provider falls back to its local behavior.
 */
export class AcpClient extends Service {
  private connection: AgentContext | undefined
  private capabilities: AcpClientCapabilities = NO_CAPABILITIES
  private readonly tracked = new Map<SessionId, TrackedSession>()

  constructor(ctx: Context) {
    super(ctx, 'acpClient')
  }

  /**
   * Publish the connection and the capability set its `initialize` advertised.
   * @param connection - the live agent-side ACP connection.
   * @param capabilities - the client capabilities observed at initialization.
   */
  bind(connection: AgentContext, capabilities: AcpClientCapabilities): void {
    this.connection = connection
    this.capabilities = Object.freeze(capabilities)
  }

  /** Drop the binding; the next `initialize` on a new transport rebinds it. */
  unbind(): void {
    this.connection = undefined
    this.capabilities = NO_CAPABILITIES
  }

  /** The client capabilities of the current binding; all false when unbound. */
  get clientCapabilities(): AcpClientCapabilities {
    return this.capabilities
  }

  /**
   * The live connection, for a provider that already checked a capability.
   * @returns the bound agent-side connection.
   * @throws {@link AcpClientUnboundError} before `initialize` ran.
   */
  requireConnection(): AgentContext {
    if (this.connection === undefined) {
      throw new AcpClientUnboundError('the ACP client connection is not initialized')
    }
    return this.connection
  }

  /**
   * Read one text file through the connected client (`fs/read_text_file`).
   * @param params - the ACP session and the absolute path to read.
   * @returns the client's own view of that file.
   * @throws {@link AcpClientUnboundError} before `initialize` ran.
   */
  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.requireConnection().request(methods.client.fs.readTextFile, params)
  }

  /**
   * Write one text file through the connected client (`fs/write_text_file`).
   * @param params - the ACP session, absolute path, and full content to store.
   * @throws {@link AcpClientUnboundError} before `initialize` ran.
   */
  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.requireConnection().request(methods.client.fs.writeTextFile, params)
  }

  /**
   * Create one terminal in the connected client (`terminal/create`).
   * @param params - the ACP session, command, argv, environment, and workspace.
   * @returns the handle addressing that terminal's output, exit, kill, and release.
   * @throws {@link AcpClientUnboundError} before `initialize` ran.
   */
  async createTerminal(params: CreateTerminalRequest): Promise<AcpTerminalHandle> {
    const connection = this.requireConnection()
    const { terminalId } = await connection.request(methods.client.terminal.create, params)
    return new AcpTerminal(connection, params.sessionId, terminalId)
  }

  /**
   * Add one published ACP session to the routing table.
   * @param id - the session's identity.
   * @param cwd - the absolute workspace the session was admitted for.
   */
  track(id: SessionId, cwd: string): void {
    // The filesystem seam reports canonical target paths, so a workspace the
    // client names through a symlink or an 8.3 short name must still route
    // there. `realpathSync.native` is the resolver that seam uses; a workspace
    // this host cannot resolve keeps its declared form.
    let canonicalCwd: string
    try {
      canonicalCwd = realpathSync.native(cwd)
    } catch {
      canonicalCwd = resolve(cwd)
    }
    this.tracked.set(id, { id, cwd, canonicalCwd })
  }

  /**
   * Remove one ACP session from the routing table.
   * @param id - the session's identity.
   */
  untrack(id: SessionId): void {
    this.tracked.delete(id)
  }

  /**
   * Route an execution to the session its managed `DSH_*` snapshot names. The
   * snapshot is the harness's own per-execution identity fact, so this is an
   * exact match rather than a heuristic; a caller outside any agent has no
   * session and stays local.
   * @param dshEnv - the resolved managed environment of one execution.
   * @returns the tracked session named by the snapshot, or undefined.
   */
  sessionForEnv(dshEnv: DshEnvironment | undefined): SessionId | undefined {
    const named = dshEnv?.[DSH_SESSION_ID_KEY]
    if (named === undefined) return undefined
    for (const session of this.tracked.values()) {
      if (session.id === named) return session.id
    }
    return undefined
  }

  /**
   * Route a path-shaped call to the unique session whose workspace contains it.
   * Zero or several candidate workspaces are both unroutable: a file outside
   * every ACP workspace is the host's, and an ambiguous one must not be
   * attributed to an arbitrary session.
   * @param path - an absolute process path.
   * @returns the single containing session, or undefined.
   */
  sessionForPath(path: string): SessionId | undefined {
    const target = resolve(path)
    let match: TrackedSession | undefined
    for (const session of this.tracked.values()) {
      const bases = [session.cwd, session.canonicalCwd].map(base => resolve(base))
      if (!bases.some(base => target === base || target.startsWith(base.endsWith(sep) ? base : base + sep))) continue
      if (match !== undefined) return undefined
      match = session
    }
    return match?.id
  }
}

export default AcpClient
