/**
 * ShareGPT trajectory export (`ctx.evolutionTrajectory`): one finished Session,
 * or every non-archived Session of one Workspace scope, is read from session
 * persistence and written as a ShareGPT conversation file under the harness
 * home, for evals and outer-loop training. Exports never land inside a project
 * directory, and nothing here reaches a model request.
 *
 * @module @deepseek-ai/dsh-evolution-trajectory
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { toShareGpt as shapeShareGpt } from './sharegpt.ts'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import type {
  ShareGptConversation,
  ShareGptInput,
  TrajectoryExportOptions,
  TrajectoryExportResult,
} from './types.ts'

export type {
  ShareGptConversation,
  ShareGptInput,
  ShareGptMessage,
  ShareGptRole,
  TrajectoryExportOptions,
  TrajectoryExportResult,
} from './types.ts'
export { toShareGpt } from './sharegpt.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** ShareGPT trajectory export owner. */
    evolutionTrajectory: EvolutionTrajectoryExporter
  }
}

/** Directory under the harness home that exports land in unless configured otherwise. */
const EXPORT_DIRECTORY = 'evolution-trajectories'

/** Deployment choices for trajectory export. */
export interface Config {
  /** Export directory used when a call names none. @default `$DSH_HOME/evolution-trajectories` */
  outDir?: string
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  outDir: z.string().min(1),
})

/** Normalized configuration. */
export interface ResolvedConfig {
  /** Configured export directory, or undefined when the harness home resolves it. */
  outDir: string | undefined
}

/**
 * Resolve deployment choices. An unconfigured export directory stays
 * unresolved here: `$DSH_HOME` is read when an export runs, so one mounted
 * plugin honors an environment the process sets after load.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  return { outDir: config.outDir }
}

/**
 * File name for one Session's export. Session ids arrive from callers, so
 * separators and dot segments are neutralized before they can shape a path.
 * @param sessionId - the Session identity.
 * @returns a single filesystem-safe file name.
 */
function trajectoryFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/gu, '_')
  return `${/^\.{0,2}$/u.test(safe) ? 'session' : safe}.sharegpt.json`
}

/** Host-side ShareGPT exporter over session persistence and the Workspace roster. */
export class EvolutionTrajectoryExporter extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'sessionPersistence']

  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - Host context carrying the Workspace registry and session persistence.
   * @param config - deployment export-directory choice.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionTrajectory', { namespace: 'evolutionTrajectory' })
    this.resolved = resolveConfig(config)
  }

  /**
   * Shape one Session's committed events into ShareGPT conversations. Pure: it
   * reads no service and writes nothing.
   * @param input - the Session identity and its committed events.
   * @returns conversations in turn order, empty when no turn produced a message.
   */
  toShareGpt(input: ShareGptInput): ShareGptConversation[] {
    return shapeShareGpt(input)
  }

  /**
   * Write one Session's conversations as a ShareGPT JSON file: one file per
   * call, an empty array when the Session produced no admitted message.
   * @param sessionId - stored or live Session to export.
   * @param options - destination file override.
   * @returns the written path, its conversation count, and its UTF-8 byte size.
   * @throws RemoteError with `session/not-found` when storage holds no such Session.
   */
  @Remote
  async exportSession(sessionId: string, options: TrajectoryExportOptions = {}): Promise<TrajectoryExportResult> {
    const id = brandString<SessionId>(sessionId)
    const events = await this.readEvents(id)
    if (events === undefined) {
      throw new RemoteError('session/not-found', `Session "${sessionId}" not found`, { sessionId: id })
    }
    const conversations = shapeShareGpt({ sessionId, events })
    return this.write(options.out ?? join(this.outDir(), trajectoryFileName(sessionId)), conversations)
  }

  /**
   * Write one file per non-archived Session of a Workspace scope. Archived
   * sessions are skipped, and a roster entry whose log is gone is skipped with
   * a warning rather than voiding the export.
   * @param scopeId - opaque scope identity naming the Workspace.
   * @param options - destination directory override.
   * @returns the written directory, the summed conversation count, and the summed UTF-8 byte size.
   * @throws RemoteError with `workspace/not-found` when the scope names no registered Workspace.
   */
  @Remote
  async exportScope(scopeId: string, options: TrajectoryExportOptions = {}): Promise<TrajectoryExportResult> {
    // The scope identity is opaque `profile:workspaceId`; profiles never
    // contain a separator, so the first one divides the key.
    const separator = scopeId.indexOf(':')
    const workspaceKey = separator === -1 ? scopeId : scopeId.slice(separator + 1)
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceKey))
    if (workspace === undefined) {
      throw new RemoteError('workspace/not-found', `Workspace "${workspaceKey}" not found`, {
        workspaceId: WorkspaceId(workspaceKey),
      })
    }
    const directory = options.out ?? this.outDir()
    await mkdir(directory, { recursive: true })
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds.map(id => String(id)))
    let conversations = 0
    let bytes = 0
    for (const id of workspace.sessionIds) {
      if (archived.has(String(id))) continue
      const events = await this.readEvents(id)
      if (events === undefined) {
        this.ctx.logger.warn(`evolution trajectory skipped session '${String(id)}': storage holds no log`)
        continue
      }
      const written = await this.write(
        join(directory, trajectoryFileName(String(id))),
        shapeShareGpt({ sessionId: String(id), events }),
      )
      conversations += written.conversations
      bytes += written.bytes
    }
    return { path: directory, conversations, bytes }
  }

  /** Resolve the export directory: the configured one, else the harness home. */
  private outDir(): string {
    return this.resolved.outDir ?? dshHomePath(EXPORT_DIRECTORY)
  }

  /**
   * Read one Session's committed events, flushing a live Session first so the
   * export sees the turns that reached the model.
   * @param id - Session to read.
   * @returns the committed events, or undefined when storage holds no such Session.
   */
  private async readEvents(id: SessionId): Promise<readonly SessionEvent[] | undefined> {
    const sessions = this.ctx.get('sessions')
    if (sessions !== undefined) {
      const live = sessions.get(id)
      if (live !== undefined) await sessions.flush(live)
    }
    let handle: SessionHandle
    try {
      handle = await this.ctx.sessionPersistence.open(id, 'read')
    } catch (error) {
      // Absence is the backend's decision; every other failure (corruption,
      // unsupported format, I/O) stays fail-loud.
      if (error instanceof SessionPersistenceNotFoundError) return undefined
      throw error
    }
    try {
      return (await handle.read(0)).events
    } finally {
      await handle.close()
    }
  }

  /**
   * Write one export file and report what landed on disk.
   * @param path - destination file path.
   * @param conversations - shaped conversations to serialize.
   * @returns the path, the conversation count, and the UTF-8 byte size.
   */
  private async write(path: string, conversations: readonly ShareGptConversation[]): Promise<TrajectoryExportResult> {
    const text = `${JSON.stringify(conversations, null, 2)}\n`
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text, 'utf8')
    return { path, conversations: conversations.length, bytes: Buffer.byteLength(text, 'utf8') }
  }
}

export default EvolutionTrajectoryExporter
