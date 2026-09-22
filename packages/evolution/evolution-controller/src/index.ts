/**
 * Host face of the evolution harness (`ctx.evolutionController`): the
 * `evolution` Remote namespace over the durable per-scope record and the
 * `/journey` read model. Every scoped verb resolves the Workspace first and
 * fails with `workspace/not-found`; `follow` publishes one baseline carrying
 * every registered scope followed by upserts driven by `domain/changed`.
 * @module @deepseek-ai/dsh-evolution-controller
 */

import { realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { Deque } from '@deepseek-ai/dsh-deque'
import { EvolutionScopeId, storageKey } from '@deepseek-ai/dsh-evolution-memory'
import type {
  EvolutionMemoryRecord,
  EvolutionMemoryUsage,
  EvolutionScopeId as EvolutionScopeIdBrand,
} from '@deepseek-ai/dsh-evolution-memory'
import { isUsageRange } from '@deepseek-ai/dsh-usage-ledger'
import { scopeTimeline } from '@deepseek-ai/dsh-command-evolution'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-evolution-reviewer'
import type {
  EvolutionAddContextItemRequest,
  EvolutionFollowFrame,
  EvolutionListStagedRequest,
  EvolutionMemoryValue,
  EvolutionRebuildMemoryRequest,
  EvolutionRemoveContextItemRequest,
  EvolutionResolveStagedRequest,
  EvolutionScopeRequest,
  EvolutionSetInstructionsRequest,
  EvolutionSetLessonsRequest,
  EvolutionSetProfileRequest,
  EvolutionStagedValue,
  EvolutionTimelineRequest,
  JourneyTimeline,
} from './types.ts'

export type * from './types.ts'

/** The domain and table whose writes drive the follow stream. */
const DOMAIN = 'evolution_memory'
const TABLE = 'records'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `evolution` Remote namespace. */
    evolutionController: EvolutionController
  }
}

/** Deployment choices for the controller. */
export interface Config {
  /** Scope-identity namespace placed before the workspace key. Required: scopes never share a default namespace. */
  profile: string
}

/**
 * Project one stored record into its Remote value.
 * @param workspaceId - owning Workspace identity.
 * @param record - stored record, or undefined when absent.
 * @param usage - capacity accounting for the scope.
 * @returns detached Remote projection.
 */
export function evolutionMemoryValue(
  workspaceId: WorkspaceId,
  record: EvolutionMemoryRecord | undefined,
  usage: EvolutionMemoryUsage,
): EvolutionMemoryValue {
  if (record === undefined) {
    return {
      workspaceId,
      instructions: '',
      lessons: [],
      profile: '',
      memoryUpdatedAt: null,
      instructionsUpdatedAt: null,
      lessonsUpdatedAt: null,
      profileUpdatedAt: null,
      contextItems: [],
      outputs: [],
      episodic: [],
      lastExtraction: null,
      staged: [],
      resolutions: [],
      usage: { ...usage },
      updatedAt: new Date(0).toISOString(),
    }
  }
  return {
    workspaceId,
    instructions: record.instructions,
    lessons: structuredClone([...record.agentLessons]),
    profile: record.userProfile,
    memoryUpdatedAt: record.memoryUpdatedAt,
    instructionsUpdatedAt: record.instructionsUpdatedAt,
    lessonsUpdatedAt: record.lessonsUpdatedAt,
    profileUpdatedAt: record.profileUpdatedAt,
    contextItems: structuredClone([...record.contextItems]),
    outputs: structuredClone([...record.outputs]),
    episodic: structuredClone([...record.episodic]),
    lastExtraction: record.lastExtraction === null ? null : structuredClone(record.lastExtraction),
    staged: structuredClone([...record.staged]),
    resolutions: structuredClone([...record.resolutions]),
    usage: { ...usage },
    updatedAt: record.updatedAt,
  }
}

/** Owns evolution follow generations. */
class EvolutionFeed {
  private readonly followers = new Set<EvolutionFollower>()

  /**
   * @param ctx - Host context carrying the registry and store.
   * @param valueOf - projection of one registered Workspace's scope.
   * @param scopeKeyOf - durable record key for one registered Workspace's scope.
   */
  constructor(
    private readonly ctx: Context,
    private readonly valueOf: (workspaceId: WorkspaceId) => EvolutionMemoryValue,
    private readonly scopeKeyOf: (workspaceId: WorkspaceId) => string,
  ) {
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'evolution-controller.feed')
  }

  /**
   * Read every registered Workspace's current projection synchronously.
   * @returns one value per registered Workspace, absent as the empty projection.
   */
  baseline(): readonly EvolutionMemoryValue[] {
    return this.ctx.workspaceRegistry.list().map((workspace: Workspace) => this.valueOf(workspace.id))
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered upserts.
   */
  async *follow(signal: AbortSignal): AsyncIterable<EvolutionFollowFrame> {
    signal.throwIfAborted()
    const follower = new EvolutionFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', values: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== DOMAIN || change.table !== TABLE) return
    if (change.operation === 'deleted') return
    const workspace = this.workspaceOf(change.key)
    if (workspace === undefined) return
    const value = this.valueOf(workspace.id)
    for (const follower of this.followers) follower.push({ type: 'upsert', value })
  }

  /**
   * Map one durable record key back to its registered Workspace. Keys of other
   * profiles and of the global record belong to no Workspace and are ignored.
   * @param key - the changed record's storage key.
   * @returns the owning Workspace, or undefined.
   */
  private workspaceOf(key: string): Workspace | undefined {
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (this.scopeKeyOf(workspace.id) === key) return workspace
    }
    return undefined
  }
}

/** Queues frames for one live generation. */
class EvolutionFollower {
  private readonly frames = new Deque<EvolutionFollowFrame>()
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: EvolutionFollowFrame): void {
    /* v8 ignore next -- closed followers leave the set in the same step that closes them. */
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  close(): void {
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<EvolutionFollowFrame> {
    while (!this.closed && !signal.aborted) {
      const frame = this.frames.popFront()
      if (frame !== undefined) {
        yield frame
        continue
      }
      await this.wait(signal)
    }
  }

  private wait(signal: AbortSignal): Promise<void> {
    const { promise, resolve: resolveWait } = Promise.withResolvers<void>()
    const finish = (): void => {
      signal.removeEventListener('abort', finish)
      /* v8 ignore next -- one read owns the sole installed wait callback. */
      if (this.waiting === finish) this.waiting = undefined
      resolveWait()
    }
    this.waiting = finish
    signal.addEventListener('abort', finish, { once: true })
    /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
    if (signal.aborted || this.closed || this.frames.size > 0) finish()
    return promise
  }
}

/**
 * Host Remote service over the durable evolution record. The stream is owned
 * by the feed; reconnect generations belong to the client transport
 * (`RemoteStream`), which opens a fresh `follow` call per generation, so this
 * service never buffers across a transport loss.
 * @param ctx - Host context carrying the registry and store.
 * @param config - the scope-identity namespace.
 */
export class EvolutionController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'evolutionMemory']

  private readonly profile: string
  private readonly feed: EvolutionFeed

  /**
   * @param ctx - Host context carrying the registry and store.
   * @param config - the scope-identity namespace.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'evolutionController', { namespace: 'evolution' })
    this.profile = checkProfile(config.profile)
    const scopeKeyOf = (workspaceId: WorkspaceId): string => storageKey(this.scopeOf(workspaceId))
    this.feed = new EvolutionFeed(ctx, workspaceId => this.projectValue(workspaceId), scopeKeyOf)
  }

  /**
   * Load one scope's record.
   * @param request - scope identity.
   * @returns the Remote projection.
   */
  @Remote('read')
  read(request: EvolutionScopeRequest): Promise<EvolutionMemoryValue> {
    return this.settleStep(() => this.projectValue(this.requireWorkspace(request.scopeId).id))
  }

  /**
   * Replace the instruction text.
   * @param request - scope identity and new rules.
   * @returns the updated projection.
   */
  @Remote('setInstructions')
  async setInstructions(request: EvolutionSetInstructionsRequest): Promise<EvolutionMemoryValue> {
    const workspace = this.requireWorkspace(request.scopeId)
    await this.ctx.evolutionMemory.setInstructions(this.scopeOf(workspace.id), request.instructions)
    return this.projectValue(workspace.id)
  }

  /**
   * Replace the scope's lesson artifacts wholesale. This is the document-level
   * verb the editor drives: the supplied list becomes the whole lessons
   * document, so an artifact the caller omits is dropped rather than kept
   * beside the new ones.
   * @param request - scope identity and the complete artifact list.
   * @returns the updated projection.
   */
  @Remote('setLessons')
  async setLessons(request: EvolutionSetLessonsRequest): Promise<EvolutionMemoryValue> {
    const workspace = this.requireWorkspace(request.scopeId)
    await this.ctx.evolutionMemory.replaceArtifacts(this.scopeOf(workspace.id), request.artifacts)
    return this.projectValue(workspace.id)
  }

  /**
   * Replace the user-profile document by hand.
   * @param request - scope identity and new document.
   * @returns the updated projection.
   */
  @Remote('setProfile')
  async setProfile(request: EvolutionSetProfileRequest): Promise<EvolutionMemoryValue> {
    const workspace = this.requireWorkspace(request.scopeId)
    await this.ctx.evolutionMemory.setUserProfile(this.scopeOf(workspace.id), request.profile)
    return this.projectValue(workspace.id)
  }

  /**
   * Attach pasted text or a file inside the Workspace.
   * @param request - scope identity, kind, label, and text or path.
   * @returns the updated projection.
   */
  @Remote('addContextItem')
  async addContextItem(request: EvolutionAddContextItemRequest): Promise<EvolutionMemoryValue> {
    const workspace = this.requireWorkspace(request.scopeId)
    const scope = this.scopeOf(workspace.id)
    if (request.kind === 'text') {
      if (request.text === undefined) {
        throw new RemoteError('gateway/bad-request', 'text context item requires text', {})
      }
      await this.ctx.evolutionMemory.addContextItem(scope, { kind: 'text', label: request.label, text: request.text })
      return this.projectValue(workspace.id)
    }
    if (request.path === undefined) {
      throw new RemoteError('gateway/bad-request', 'file context item requires path', {})
    }
    const file = await this.resolveWorkspaceFile(workspace, request.path)
    await this.ctx.evolutionMemory.addContextItem(scope, { kind: 'file', label: request.label, path: file.path, sizeBytes: file.sizeBytes })
    return this.projectValue(workspace.id)
  }

  /**
   * Detach one context item.
   * @param request - scope identity and item identity.
   * @returns the updated projection.
   */
  @Remote('removeContextItem')
  async removeContextItem(request: EvolutionRemoveContextItemRequest): Promise<EvolutionMemoryValue> {
    const workspace = this.requireWorkspace(request.scopeId)
    await this.ctx.evolutionMemory.removeContextItem(this.scopeOf(workspace.id), request.itemId)
    return this.projectValue(workspace.id)
  }

  /**
   * Rebuild the lessons document from the scope's sessions.
   * @param request - scope identity.
   * @param signal - caller cancellation.
   * @returns the updated projection.
   */
  @Remote('rebuildMemory')
  async rebuildMemory(request: EvolutionRebuildMemoryRequest, signal: AbortSignal): Promise<EvolutionMemoryValue> {
    const workspace = this.requireWorkspace(request.scopeId)
    const scope = this.scopeOf(workspace.id)
    const reviewer = this.ctx.get('evolutionReviewer')
    if (reviewer === undefined) {
      throw new RemoteError(
        'evolution/extraction-failed',
        `evolution rebuild for '${String(scope)}' has no reviewer`,
        { scopeId: String(scope) },
      )
    }
    try {
      await reviewer.rebuild(scope, signal)
    } catch (error) {
      if (error instanceof RemoteError) throw error
      throw new RemoteError(
        'evolution/extraction-failed',
        `evolution rebuild for '${String(scope)}' failed: ${error instanceof Error ? error.message : String(error)}`,
        { scopeId: String(scope) },
      )
    }
    return this.projectValue(workspace.id)
  }

  /**
   * List the scope's pending staged writes.
   * @param request - scope identity.
   * @returns the pending entries in record order.
   */
  @Remote('listStaged')
  listStaged(request: EvolutionListStagedRequest): Promise<EvolutionStagedValue> {
    return this.settleStep(() => {
      const workspace = this.requireWorkspace(request.scopeId)
      return { staged: structuredClone([...this.recordOf(workspace.id)?.staged ?? []]) }
    })
  }

  /**
   * Apply one staged write and drop it from the pending list.
   * @param request - scope identity and staged entry identity.
   * @returns the updated projection.
   */
  @Remote('approveStaged')
  async approveStaged(request: EvolutionResolveStagedRequest): Promise<EvolutionMemoryValue> {
    const workspace = this.requireWorkspace(request.scopeId)
    this.requireStaged(workspace.id, request.stagedId)
    await this.ctx.evolutionMemory.approveStaged(request.stagedId)
    return this.projectValue(workspace.id)
  }

  /**
   * Drop one staged write without applying it.
   * @param request - scope identity and staged entry identity.
   * @returns the updated projection.
   */
  @Remote('rejectStaged')
  async rejectStaged(request: EvolutionResolveStagedRequest): Promise<EvolutionMemoryValue> {
    const workspace = this.requireWorkspace(request.scopeId)
    this.requireStaged(workspace.id, request.stagedId)
    await this.ctx.evolutionMemory.rejectStaged(request.stagedId)
    return this.projectValue(workspace.id)
  }

  /**
   * Render one scope's journey over a window from the record it already keeps.
   * @param request - scope identity and requested window.
   * @returns the timeline.
   */
  @Remote('timeline')
  timeline(request: EvolutionTimelineRequest): Promise<JourneyTimeline> {
    return this.settleStep(() => {
      const workspace = this.requireWorkspace(request.scopeId)
      if (!isUsageRange(request.range)) {
        throw new RemoteError('gateway/bad-request', `unknown timeline range ${JSON.stringify(request.range)}`, {})
      }
      const usage = this.ctx.evolutionMemory.usage(this.scopeOf(workspace.id))
      return scopeTimeline({
        record: this.recordOf(workspace.id),
        usedBytes: usage.usedBytes,
        capacityBytes: usage.capacityBytes,
        digest: this.ctx.evolutionMemory.digest(this.scopeOf(workspace.id)),
        range: request.range,
        now: Date.now(),
      })
    })
  }

  /**
   * Stream a complete baseline followed by ordered upserts.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered scope increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<EvolutionFollowFrame> {
    return this.feed.follow(signal)
  }

  private scopeOf(workspaceId: WorkspaceId): EvolutionScopeIdBrand {
    return EvolutionScopeId(this.profile, String(workspaceId))
  }

  private projectValue(workspaceId: WorkspaceId): EvolutionMemoryValue {
    return evolutionMemoryValue(
      workspaceId,
      this.recordOf(workspaceId),
      this.ctx.evolutionMemory.usage(this.scopeOf(workspaceId)),
    )
  }

  private recordOf(workspaceId: WorkspaceId): EvolutionMemoryRecord | undefined {
    return this.ctx.evolutionMemory.read(this.scopeOf(workspaceId))
  }

  /**
   * Settle one synchronous projection into the promise a Remote method answers
   * with. The lookup inside the step throws a RemoteError, which a Remote
   * caller must observe as a rejection rather than a synchronous throw, so the
   * outcome always leaves through the returned promise. A non-Error throw is
   * wrapped, so every rejection still carries an Error.
   * @param step - the synchronous projection step.
   * @returns the step's result, or its rejection.
   */
  private settleStep<T>(step: () => T): Promise<T> {
    try {
      return Promise.resolve(step())
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error), { cause: error }))
    }
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new RemoteError('workspace/not-found', `Workspace "${String(workspaceId)}" not found`, {
        workspaceId: workspaceId,
      })
    }
    return workspace
  }

  /**
   * Locate one staged entry inside this scope. The store locates entries by
   * identity alone, so the scope check runs here: another scope's entry is
   * reported as absent rather than decided.
   * @param workspaceId - resolved Workspace identity.
   * @param stagedId - staged entry identity.
   */
  private requireStaged(workspaceId: WorkspaceId, stagedId: string): void {
    if (!(this.recordOf(workspaceId)?.staged ?? []).some(entry => entry.id === stagedId)) {
      throw new RemoteError('evolution/staged-not-found', `no staged evolution write '${stagedId}'`, { stagedId })
    }
  }

  /**
   * Resolve one Workspace-relative path to a real file inside the Workspace.
   * @param workspace - resolved Workspace.
   * @param path - workspace-relative or absolute candidate.
   * @returns the canonical path and its observed size.
   */
  private async resolveWorkspaceFile(workspace: Workspace, path: string): Promise<{ path: string; sizeBytes: number }> {
    const absolute = path.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(path)
      ? resolve(path)
      : resolve(workspace.path, path)
    const canonical = await realpath(absolute).catch((error: unknown) => {
      throw new RemoteError('evolution/context-unreadable', `context path '${path}' is unreadable`, { path }, { cause: error })
    })
    const root = await realpath(workspace.path).catch(() => workspace.path)
    const rootWithSep = root.endsWith(sep) ? root : root + sep
    if (canonical !== root && !canonical.startsWith(rootWithSep)) {
      throw new RemoteError('evolution/context-unreadable', `context path '${path}' is not a regular file inside the Workspace`, { path })
    }
    let info: { isFile(): boolean; size: number }
    try {
      info = await stat(canonical)
    } catch (error) {
      /* v8 ignore next -- the realpath above already observed the path, so only a concurrent
      deletion in this synchronous window could fail the stat here. */
      throw new RemoteError('evolution/context-unreadable', `context path '${path}' is unreadable`, { path }, { cause: error })
    }
    if (!info.isFile()) {
      throw new RemoteError('evolution/context-unreadable', `context path '${path}' is not a regular file`, { path })
    }
    return { path: canonical, sizeBytes: info.size }
  }
}

/**
 * Validate the scope namespace loudly at load.
 * @param profile - configured namespace.
 * @returns the accepted namespace.
 */
export function checkProfile(profile: string): string {
  if (profile.length === 0) throw new Error('evolution-controller: profile must be non-empty')
  if (profile.includes(':')) {
    throw new Error(`evolution-controller: profile must not contain ':', got ${JSON.stringify(profile)}`)
  }
  return profile
}

export default EvolutionController

// Remote error codes the controller owns but the session vocabulary does not.
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Trajectory export failed for the given reason. */
    'evolution/export-failed': { sessionId?: string; reason: string }
  }
}

