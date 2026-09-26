/**
 * The management service behind the Desktop MCP settings page. It reads the
 * same two config files the plugin mounts from, runs one `dsh-mcp-client` per
 * accepted declaration, reports every server's live connection state, and
 * writes declarations back through the approval seam.
 *
 * A write that extends what the harness can reach — adding a declaration,
 * replacing one, or deleting a declaration the other layer masks and which
 * therefore starts running — asks `user-approval` for an agent resolved from
 * the caller's live session, and changes nothing when the ask is refused or
 * no approval channel answers. A write that only reduces reach applies
 * directly. Every read is credential-free: `env` and `headers` appear as key
 * names, never as values.
 *
 * @module @deepseek-ai/dsh-mcp-project-config/mcp-servers
 */

import type { Context } from '@deepseek-ai/cordis'
import type { TrustLabel } from '@deepseek-ai/dsh-agent-kernel'
import type { McpConnectionStatusChange } from '@deepseek-ai/dsh-mcp-client'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { McpConfigFileError, readConfigDocument, writeServerEntry, type McpConfigDocument } from './config-file.ts'
import { normalizeServerName, parseMcpProjectConfig, parseTrust, type ParsedServer } from './parse.ts'
import type {
  McpMutationOutcome, McpMutationRefusal, McpServerEndpoint, McpServerLayer, McpServerRemove, McpServerState,
  McpServerUpsert, McpServerView, McpServersView,
} from './types.ts'

/** The approval ask this service performs before a reach-extending write. */
export interface McpApprovalAsk {
  /** The live session whose open turn carries the ask. */
  readonly sessionId: SessionId
  /** The operation the question is about, for presentation and audit. */
  readonly toolName: string
  /** The service's explanation of why it is asking. */
  readonly reason?: string
}

/**
 * The approval capability a reach-extending write asks through. The Host
 * wiring resolves the ask's session to the live agent `user-approval` needs;
 * a service that cannot answer rejects, which this service refuses the write
 * on.
 */
export interface McpApprovalChannel {
  /**
   * Ask the composed answerers to decide one request.
   * @param request - the session, tool identity, and reason.
   * @returns the closed outcome; only the `allowed-*` values are grants.
   */
  request(request: McpApprovalAsk): Promise<ApprovalOutcome>
}

/** Host wiring of the management service. */
export interface McpServersOptions {
  /** Absolute path of the project `.mcp.json`. */
  readonly projectPath: string
  /** Absolute path of the user-level config file. */
  readonly userPath: string
  /** Whether a configured server's failed first connection rejects its mount. */
  readonly failOnStartupError: boolean
  /** The approval channel a reach-extending write asks through; absent when the composition mounts none. */
  readonly approval: McpApprovalChannel | undefined
}

/** One declaration after the layer merge: an accepted server, or a rejected entry with its reason. */
interface Declaration {
  /** The `mcpServers` key as declared. */
  readonly name: string
  /** The layer the declaration was read from. */
  readonly layer: McpServerLayer
  /** The declared trust label, or the untrusted default when the entry is not readable. */
  readonly trust: TrustLabel
  /** The accepted declaration, absent when the entry was rejected. */
  readonly server?: ParsedServer
  /** Why the entry was rejected, absent when accepted. */
  readonly reason?: string
}

/** One running client instance and the declaration it was mounted from. */
interface MountedServer {
  /** Dispose the child plugin instance. */
  dispose(): Promise<void>
  /** The accepted declaration the instance was mounted from; a change remounts it. */
  readonly signature: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mcpServers: McpServers
  }
}

/**
 * Merged MCP server configuration, live connection state, and approval-gated writes.
 *
 * @param ctx - plugin context whose fiber owns the mounted instances.
 * @param options - the two config file paths and the seams a write asks.
 */
export class McpServers extends TypertRemoteService {
  /** Running instances, keyed by the normalized server name they registered. */
  private readonly mounted = new Map<string, MountedServer>()
  /** Last state each running instance reported, keyed by normalized server name. */
  private readonly statuses = new Map<string, McpConnectionStatusChange>()
  /** The merged declarations in view order: accepted servers, then rejected entries. */
  private declarations: Declaration[] = []

  constructor(ctx: Context, private readonly options: McpServersOptions) {
    super(ctx, 'mcpServers')
    // The instances are children of this plugin's context, so their status
    // reports arrive here; the subscription leaves with the fiber.
    ctx.effect(() => ctx.on('mcp-client/status', (change) => {
      this.statuses.set(change.serverName, change)
    }), 'mcp-servers.status')
  }

  /**
   * Read both config files and mount one client per accepted declaration.
   * @returns after every mount attempt settled.
   */
  async start(): Promise<void> {
    await this.read()
    await this.reconcile()
  }

  /**
   * Read the merged configuration and every server's live state.
   * @returns the view the management surface renders.
   */
  @Remote
  list(): McpServersView {
    return this.view()
  }

  /**
   * Write one declaration into one layer, asking the approval seam first.
   * @param request - the declaration, its layer, and the session whose open turn carries the ask.
   * @returns the outcome, with the merged view in force afterwards.
   */
  @Remote
  async upsert(request: McpServerUpsert): Promise<McpMutationOutcome> {
    const entry = this.buildEntry(request)
    if (entry === null) {
      return this.refuse('invalid-declaration', `"${request.name}" is not a mountable ${request.transport} server declaration`)
    }
    const approved = await this.approve(request.sessionId, `add or replace the MCP server "${request.name}"`)
    if (!approved.ok) return this.refuse(approved.refusal, approved.detail)
    if (request.keepStoredSecrets === true) await this.mergeStoredSecrets(entry, request)
    try {
      await writeServerEntry(this.pathOf(request.layer), request.name, entry)
    } catch (error: unknown) {
      return this.refuse('unreadable-config', describe(error))
    }
    await this.read()
    await this.reconcile()
    return { ok: true, refusal: null, detail: null, view: this.view() }
  }

  /**
   * Delete one declaration from one layer. A deletion that starts the other
   * layer's declaration of the same name asks the approval seam first.
   * @param request - the name, its layer, and the session whose open turn carries the ask.
   * @returns the outcome, with the merged view in force afterwards.
   */
  @Remote
  async remove(request: McpServerRemove): Promise<McpMutationOutcome> {
    const path = this.pathOf(request.layer)
    let document: McpConfigDocument
    try {
      document = await readConfigDocument(path)
    } catch (error: unknown) {
      return this.refuse('unreadable-config', describe(error))
    }
    if (!Object.hasOwn(document.mcpServers, request.name)) {
      return this.refuse('unknown-server', `"${request.name}" is not declared in the ${request.layer} config`)
    }
    if (await this.startsMaskedDeclaration(request.name, request.layer)) {
      const approved = await this.approve(request.sessionId, `delete the project MCP server "${request.name}", which runs the user-level declaration of the same name`)
      if (!approved.ok) return this.refuse(approved.refusal, approved.detail)
    }
    try {
      await writeServerEntry(path, request.name, null)
    } catch (error: unknown) {
      return this.refuse('unreadable-config', describe(error))
    }
    await this.read()
    await this.reconcile()
    return { ok: true, refusal: null, detail: null, view: this.view() }
  }

  /** The config file one layer writes. */
  private pathOf(layer: McpServerLayer): string {
    return layer === 'project' ? this.options.projectPath : this.options.userPath
  }

  /**
   * Whether deleting this declaration starts the other layer's declaration of
   * the same name. Only a project deletion can: a user-level declaration is
   * shadowed by the project layer while that declaration is accepted.
   * @param name - the `mcpServers` key being deleted.
   * @param layer - the layer being written.
   * @returns whether the other layer declares the same key.
   */
  private async startsMaskedDeclaration(name: string, layer: McpServerLayer): Promise<boolean> {
    if (layer !== 'project' || this.options.userPath === this.options.projectPath) return false
    try {
      const user = await readConfigDocument(this.options.userPath)
      return Object.hasOwn(user.mcpServers, name)
    } catch (error: unknown) {
      // Unreadable user config: treat the deletion as reach-changing rather
      // than removing a masked declaration nobody can inspect.
      this.ctx.logger.warn(`mcp-project-config: ${describe(error)}`)
      return true
    }
  }

  /** Read both layers and rebuild the merged declarations. */
  private async read(): Promise<void> {
    const samePath = this.options.projectPath === this.options.userPath
    const [project, user] = samePath
      ? [await this.loadLayer('project', this.options.projectPath), []]
      : await Promise.all([
        this.loadLayer('project', this.options.projectPath),
        this.loadLayer('user', this.options.userPath),
      ])

    // The project file is more specific to the current work than the user-level
    // file, so its declaration wins a normalized-name collision — in place, so
    // the mount order stays a user-file order with project overrides applied.
    const accepted = new Map<string, Declaration>()
    for (const declaration of user) {
      if (declaration.server !== undefined) accepted.set(declaration.server.serverName, declaration)
    }
    for (const declaration of project) {
      if (declaration.server !== undefined) accepted.set(declaration.server.serverName, declaration)
    }
    const rejected = [...project, ...user].filter(declaration => declaration.server === undefined)
    this.declarations = [...accepted.values(), ...rejected]
  }

  /**
   * Parse one layer file into declarations, in file order.
   * @param layer - which layer this file is.
   * @param path - absolute path of the file.
   * @returns accepted servers first, then rejected entries with their reasons.
   */
  private async loadLayer(layer: McpServerLayer, path: string): Promise<Declaration[]> {
    let document: McpConfigDocument
    try {
      document = await readConfigDocument(path)
    } catch (error: unknown) {
      // A broken file is reported rather than fatal: the other layer still mounts.
      const reason = error instanceof Error ? error.message : String(error)
      this.ctx.logger.warn(`mcp-project-config: could not load "${path}": ${reason} — no servers from this file`)
      return []
    }
    const parsed = parseMcpProjectConfig(document.present ? document.root : undefined)
    const rawNameOf = new Map<string, string>()
    for (const rawName of Object.keys(document.mcpServers)) rawNameOf.set(normalizeServerName(rawName), rawName)
    const declarations: Declaration[] = []
    for (const server of parsed.servers.values()) {
      declarations.push({ name: rawNameOf.get(server.serverName) ?? server.serverName, layer, trust: server.trust, server })
    }
    for (const skipped of parsed.skipped) {
      this.ctx.logger.warn(`mcp-project-config: skipping "${skipped.rawName}": ${skipped.reason}`)
      declarations.push({
        name: skipped.rawName,
        layer,
        trust: declaredTrust(document.mcpServers[skipped.rawName]),
        reason: skipped.reason,
      })
    }
    return declarations
  }

  /**
   * Bring the running instances in line with the merged declarations: dispose
   * what a write removed or changed, then mount what is new. Sequential, so a
   * mount attempt cannot interleave with another's namespace reservation.
   */
  private async reconcile(): Promise<void> {
    const wanted = new Map<string, { signature: string; config: McpClient.Config }>()
    for (const declaration of this.declarations) {
      const server = declaration.server
      if (server === undefined) continue
      wanted.set(server.serverName, { signature: JSON.stringify(server), config: clientConfigFor(server, this.options.failOnStartupError) })
    }
    for (const [serverName, running] of [...this.mounted]) {
      const next = wanted.get(serverName)
      if (next !== undefined && next.signature === running.signature) continue
      this.mounted.delete(serverName)
      this.statuses.delete(serverName)
      await running.dispose()
    }
    for (const [serverName, entry] of wanted) {
      if (this.mounted.has(serverName)) continue
      const fiber = await this.ctx.plugin(McpClient, entry.config)
      this.mounted.set(serverName, { signature: entry.signature, dispose: async () => { await fiber.dispose() } })
    }
  }

  /** The view of the merged declarations right now. */
  private view(): McpServersView {
    return {
      servers: this.declarations.map(declaration => this.viewOf(declaration)),
      projectPath: this.options.projectPath,
      userPath: this.options.userPath,
    }
  }

  /** The view of one declaration, rejected or accepted. */
  private viewOf(declaration: Declaration): McpServerView {
    const server = declaration.server
    if (server === undefined) {
      return {
        name: declaration.name,
        layer: declaration.layer,
        trust: declaration.trust,
        endpoint: null,
        serverName: null,
        state: { kind: 'not-mounted', reason: declaration.reason ?? 'rejected' },
      }
    }
    return {
      name: declaration.name,
      layer: declaration.layer,
      trust: declaration.trust,
      endpoint: endpointOf(server),
      serverName: server.serverName,
      state: this.stateOf(server.serverName),
    }
  }

  /** The live state of one normalized server name. */
  private stateOf(serverName: string): McpServerState {
    const status = this.statuses.get(serverName)
    if (status === undefined) {
      return {
        kind: 'not-mounted',
        reason: this.mounted.has(serverName) ? 'the mounted client has reported no state yet' : 'no client instance runs for this declaration',
      }
    }
    return { kind: 'mounted', status: status.status, attempt: status.attempt, maxAttempts: status.maxAttempts }
  }

  /**
   * Build the JSON entry one request describes.
   * @param request - the declaration to write.
   * @returns the entry, or `null` when it is not a mountable server declaration.
   */
  private buildEntry(request: McpServerUpsert): Record<string, unknown> | null {
    const entry: Record<string, unknown> = {
      type: request.transport === 'http' ? 'http' : 'stdio',
      trust: request.trust ?? 'untrusted',
    }
    if (request.transport === 'stdio') {
      entry.command = request.command ?? ''
      entry.args = [...request.args ?? []]
      entry.env = { ...request.env ?? {} }
    } else {
      entry.url = request.url ?? ''
      entry.headers = { ...request.headers ?? {} }
    }
    // The parser is the one validator of a declaration: an entry it would skip
    // is never written.
    const parsed = parseMcpProjectConfig({ mcpServers: { [request.name]: entry } })
    return parsed.servers.size === 1 && parsed.skipped.length === 0 ? entry : null
  }

  /**
   * Merge the stored declaration's `env`/`headers` values under this request's
   * pairs, so editing a declaration whose values the surface never reads keeps
   * them. A request pair of the same name wins.
   * @param entry - the declaration about to be written; updated in place.
   * @param request - the request naming the layer and the server.
   */
  private async mergeStoredSecrets(entry: Record<string, unknown>, request: McpServerUpsert): Promise<void> {
    let stored: Record<string, unknown> | undefined
    try {
      const document = await readConfigDocument(this.pathOf(request.layer))
      const raw = document.mcpServers[request.name]
      stored = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
    } catch (error: unknown) {
      // The write below reports the unreadable document; nothing to merge from.
      this.ctx.logger.warn(`mcp-project-config: ${describe(error)}`)
      return
    }
    const field = request.transport === 'stdio' ? 'env' : 'headers'
    const previous = stored?.[field]
    if (typeof previous !== 'object' || previous === null || Array.isArray(previous)) return
    entry[field] = { ...previous as Record<string, string>, ...entry[field] as Record<string, string> }
  }

  /**
   * Ask the approval seam for a reach-extending write.
   * @param sessionId - the live session whose open turn carries the ask.
   * @param action - what the write does, for the prompt and the audit pair.
   * @returns the grant, or the refusal to report without writing anything.
   */
  private async approve(
    sessionId: SessionId,
    action: string,
  ): Promise<{ ok: true } | { ok: false; refusal: McpMutationRefusal; detail: string }> {
    const { approval } = this.options
    if (approval === undefined) {
      return {
        ok: false,
        refusal: 'approval-required',
        detail: 'this composition mounts no approval channel, and the change extends what MCP servers the model can reach',
      }
    }
    let outcome: ApprovalOutcome
    try {
      outcome = await approval.request({
        sessionId,
        toolName: 'mcp_server_config',
        reason: `the user asked to ${action}; a configured MCP server runs its own code outside the workspace sandbox`,
      })
    } catch (error: unknown) {
      // The channel rejects when no live agent holds the session or when
      // `user-approval` cannot ask outside an open turn; refuse rather than
      // write unreviewed.
      return { ok: false, refusal: 'approval-required', detail: `the approval ask was refused: ${describe(error)}` }
    }
    return outcome === 'allowed-once' || outcome === 'allowed-session' || outcome === 'allowed-always'
      ? { ok: true }
      : { ok: false, refusal: 'approval-refused', detail: `the approval ask resolved "${outcome}"` }
  }

  /** A refused outcome carrying the unchanged view. */
  private refuse(refusal: McpMutationRefusal, detail: string): McpMutationOutcome {
    return { ok: false, refusal, detail, view: this.view() }
  }
}

/** The `dsh-mcp-client` config input one accepted declaration mounts. */
function clientConfigFor(server: ParsedServer, failOnStartupError: boolean): McpClient.Config {
  return server.transport === 'stdio'
    ? McpClient.Config({
      transport: 'stdio',
      serverName: server.serverName,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: process.cwd(),
      failOnStartupError,
      trust: server.trust,
    })
    : McpClient.Config({
      transport: 'streamable-http',
      serverName: server.serverName,
      url: server.url,
      headers: server.headers,
      failOnStartupError,
      trust: server.trust,
    })
}

/** One accepted declaration's endpoint, without its credential values. */
function endpointOf(server: ParsedServer): McpServerEndpoint {
  return server.transport === 'stdio'
    ? { transport: 'stdio', command: server.command, args: server.args, envKeys: Object.keys(server.env) }
    : { transport: 'http', url: server.url, headerNames: Object.keys(server.headers) }
}

/** The trust one raw entry declares, defaulting the way the parser does. */
function declaredTrust(rawEntry: unknown): TrustLabel {
  const entry = typeof rawEntry === 'object' && rawEntry !== null && !Array.isArray(rawEntry)
    ? rawEntry as Record<string, unknown>
    : undefined
  return parseTrust(entry?.trust) ?? 'untrusted'
}

/** One error's text, for a refusal detail or a log line. */
function describe(error: unknown): string {
  if (error instanceof McpConfigFileError) return `${error.path}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}
