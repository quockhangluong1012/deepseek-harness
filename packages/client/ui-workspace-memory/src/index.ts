/**
 * Host face of Workspace Memory (`ctx.workspaceMemoryController`): the
 * `workspaceMemory` Remote namespace over the durable store. Reads resolve
 * the Workspace first and fail with `workspace/not-found`.
 * @module @deepseek-ai/dsh-client-ui-workspace-memory
 */

import { readdir, realpath, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { Deque } from '@deepseek-ai/dsh-deque'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace-memory'
import type { WorkspaceMemoryRecord } from '@deepseek-ai/dsh-workspace-memory/types'
import type {
  WorkspaceMemoryAddContextItemRequest,
  WorkspaceMemoryContextFilesValue,
  WorkspaceMemoryListContextFilesRequest,
  WorkspaceMemoryReadRequest,
  WorkspaceMemoryRemoveContextItemRequest,
  WorkspaceMemorySetDescriptionRequest,
  WorkspaceMemorySetInstructionsRequest,
  WorkspaceMemorySetMemoryRequest,
  WorkspaceMemoryFollowFrame,
  WorkspaceMemoryValue,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `workspaceMemory` Remote namespace. */
    workspaceMemoryController: WorkspaceMemoryController
  }
}

/**
 * Project one stored record into its Remote value.
 * @param workspaceId - owning Workspace identity.
 * @param record - stored record, or undefined when absent.
 * @param usage - capacity accounting for the Workspace.
 * @returns detached Remote projection.
 */
export function workspaceMemoryValue(
  workspaceId: WorkspaceId,
  record: WorkspaceMemoryRecord | undefined,
  usage: { usedBytes: number; capacityBytes: number },
): WorkspaceMemoryValue {
  if (record === undefined) {
    return {
      workspaceId,
      description: '',
      instructions: '',
      memory: '',
      memoryUpdatedAt: null,
      contextItems: [],
      outputs: [],
      lastExtraction: null,
      usage: { ...usage },
      updatedAt: new Date(0).toISOString(),
    }
  }
  return {
    workspaceId,
    description: record.description,
    instructions: record.instructions,
    memory: record.memory,
    memoryUpdatedAt: record.memoryUpdatedAt,
    contextItems: structuredClone([...record.contextItems]),
    outputs: structuredClone([...record.outputs]),
    lastExtraction: record.lastExtraction === null ? null : structuredClone(record.lastExtraction),
    usage: { ...usage },
    updatedAt: record.updatedAt,
  }
}

/** Owns memory follow generations. */
class WorkspaceMemoryFeed {
  private readonly followers = new Set<MemoryFollower>()

  /**
   * @param ctx - Host context carrying the registry and store.
   */
  constructor(private readonly ctx: Context) {
    ctx.on('domain/changed', (change: DomainChanged) => { this.changed(change) })
    ctx.effect(() => () => {
      for (const follower of this.followers) follower.close()
      this.followers.clear()
    }, 'workspace-memory-controller.feed')
  }

  /**
   * Read the complete current projection synchronously.
   * @returns every registered Workspace's record, absent as the empty projection.
   */
  baseline(): readonly WorkspaceMemoryValue[] {
    return this.ctx.workspaceRegistry.list().map((workspace: Workspace) => this.valueOf(workspace.id))
  }

  /**
   * Open one generation beginning with a complete baseline.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered upserts.
   */
  async *follow(signal: AbortSignal): AsyncIterable<WorkspaceMemoryFollowFrame> {
    signal.throwIfAborted()
    const follower = new MemoryFollower()
    this.followers.add(follower)
    try {
      yield { type: 'baseline', values: this.baseline() }
      yield* follower.read(signal)
    } finally {
      this.followers.delete(follower)
      follower.close()
    }
  }

  private valueOf(workspaceId: WorkspaceId): WorkspaceMemoryValue {
    return workspaceMemoryValue(
      workspaceId,
      this.ctx.workspaceMemory.read(workspaceId),
      this.ctx.workspaceMemory.usage(workspaceId),
    )
  }

  private changed(change: DomainChanged): void {
    if (change.domain !== 'workspace_memory' || change.table !== 'records') return
    if (change.operation === 'deleted') return
    const workspaceId = change.key as WorkspaceId
    if (this.ctx.workspaceRegistry.get(workspaceId) === undefined) return
    const value = this.valueOf(workspaceId)
    for (const follower of this.followers) follower.push({ type: 'upsert', value })
  }
}

class MemoryFollower {
  private readonly frames = new Deque<WorkspaceMemoryFollowFrame>()
  private waiting: (() => void) | undefined
  private closed = false

  push(frame: WorkspaceMemoryFollowFrame): void {
    /* v8 ignore next -- closed followers leave the set in the same step that closes them. */
    if (this.closed) return
    this.frames.pushBack(frame)
    this.waiting?.()
  }

  close(): void {
    this.closed = true
    this.waiting?.()
  }

  async *read(signal: AbortSignal): AsyncIterable<WorkspaceMemoryFollowFrame> {
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
    return new Promise((resolve) => {
      const finish = (): void => {
        signal.removeEventListener('abort', finish)
        /* v8 ignore next -- one read owns the sole installed wait callback. */
        if (this.waiting === finish) this.waiting = undefined
        resolve()
      }
      this.waiting = finish
      signal.addEventListener('abort', finish, { once: true })
      /* v8 ignore next -- native signals and the private queue cannot change during this synchronous setup. */
      if (signal.aborted || this.closed || this.frames.size > 0) finish()
    })
  }
}

const CONTEXT_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json'])
const LIST_DEPTH = 3
const LIST_LIMIT = 200

/**
 * Host Remote service delegating memory verbs to the durable store.
 * @param ctx - Host context carrying the registry and store.
 */
export class WorkspaceMemoryController extends TypertRemoteService {
  static inject = ['typert', 'workspaceRegistry', 'workspaceMemory']

  private readonly feed: WorkspaceMemoryFeed

  /**
   * @param ctx - Host context carrying the registry and store.
   */
  constructor(ctx: Context) {
    super(ctx, 'workspaceMemoryController', { namespace: 'workspaceMemory' })
    this.feed = new WorkspaceMemoryFeed(ctx)
  }

  /**
   * Load one Workspace's record.
   * @param request - Workspace identity.
   * @returns the Remote projection.
   */
  @Remote('read')
  read(request: WorkspaceMemoryReadRequest): Promise<WorkspaceMemoryValue> {
    try {
      const workspace = this.requireWorkspace(request.workspaceId)
      return Promise.resolve(workspaceMemoryValue(
        workspace.id,
        this.ctx.workspaceMemory.read(workspace.id),
        this.ctx.workspaceMemory.usage(workspace.id),
      ))
    } catch (error) {
      return Promise.reject(error) // oxlint-disable-line typescript/prefer-promise-reject-errors -- lookup throws only RemoteError
    }
  }

  /**
   * Replace the page blurb.
   * @param request - Workspace identity and new blurb.
   * @returns the updated projection.
   */
  @Remote('setDescription')
  async setDescription(request: WorkspaceMemorySetDescriptionRequest): Promise<WorkspaceMemoryValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    const record = await this.ctx.workspaceMemory.setDescription(workspace.id, request.description)
    return workspaceMemoryValue(workspace.id, record, this.ctx.workspaceMemory.usage(workspace.id))
  }

  /**
   * Replace the instruction text.
   * @param request - Workspace identity and new rules.
   * @returns the updated projection.
   */
  @Remote('setInstructions')
  async setInstructions(request: WorkspaceMemorySetInstructionsRequest): Promise<WorkspaceMemoryValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    const record = await this.ctx.workspaceMemory.setInstructions(workspace.id, request.instructions)
    return workspaceMemoryValue(workspace.id, record, this.ctx.workspaceMemory.usage(workspace.id))
  }

  /**
   * Replace the memory document by hand.
   * @param request - Workspace identity and new document.
   * @returns the updated projection.
   */
  @Remote('setMemory')
  async setMemory(request: WorkspaceMemorySetMemoryRequest): Promise<WorkspaceMemoryValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    const record = await this.ctx.workspaceMemory.setMemory(workspace.id, request.memory)
    return workspaceMemoryValue(workspace.id, record, this.ctx.workspaceMemory.usage(workspace.id))
  }

  /**
   * Attach pasted text or a workspace file.
   * @param request - Workspace identity, kind, label, and text or path.
   * @returns the updated projection.
   */
  @Remote('addContextItem')
  async addContextItem(request: WorkspaceMemoryAddContextItemRequest): Promise<WorkspaceMemoryValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    if (request.kind === 'text') {
      if (request.text === undefined) {
        throw new RemoteError('gateway/bad-request', 'text context item requires text', {})
      }
      const record = await this.ctx.workspaceMemory.addContextItem(workspace.id, {
        kind: 'text',
        label: request.label,
        text: request.text,
      })
      return workspaceMemoryValue(workspace.id, record, this.ctx.workspaceMemory.usage(workspace.id))
    }
    if (request.path === undefined) {
      throw new RemoteError('gateway/bad-request', 'file context item requires path', {})
    }
    const resolved = await this.resolveWorkspaceFile(workspace, request.path)
    const record = await this.ctx.workspaceMemory.addContextItem(workspace.id, {
      kind: 'file',
      label: request.label,
      path: resolved.path,
      sizeBytes: resolved.sizeBytes,
    })
    return workspaceMemoryValue(workspace.id, record, this.ctx.workspaceMemory.usage(workspace.id))
  }

  /**
   * Detach one context item.
   * @param request - Workspace identity and item identity.
   * @returns the updated projection.
   */
  @Remote('removeContextItem')
  async removeContextItem(request: WorkspaceMemoryRemoveContextItemRequest): Promise<WorkspaceMemoryValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    const record = await this.ctx.workspaceMemory.removeContextItem(workspace.id, request.itemId)
    return workspaceMemoryValue(workspace.id, record, this.ctx.workspaceMemory.usage(workspace.id))
  }

  /**
   * List candidate paths under the Workspace root for the add-file picker.
   * @param request - Workspace identity and case-insensitive query.
   * @param signal - caller cancellation for the directory walk.
   * @returns workspace-relative paths, sorted, capped at 200.
   */
  @Remote('listContextFiles')
  async listContextFiles(request: WorkspaceMemoryListContextFilesRequest, signal: AbortSignal): Promise<WorkspaceMemoryContextFilesValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    const paths = await listWorkspaceFiles(workspace.path, request.query, signal)
    return { paths }
  }

  /**
   * Stream a complete memory baseline followed by ordered upserts.
   * @param signal - generation cancellation.
   * @returns baseline followed by ordered memory increments.
   */
  @Remote({ mode: 'stream' })
  follow(signal: AbortSignal): AsyncIterable<WorkspaceMemoryFollowFrame> {
    return this.feed.follow(signal)
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

  private async resolveWorkspaceFile(workspace: Workspace, path: string): Promise<{ path: string; sizeBytes: number }> {
    const absolute = path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) ? resolve(path) : resolve(workspace.path, path)
    let canonical: string
    try {
      canonical = await realpath(absolute)
    } catch (error) {
      throw new RemoteError('workspace-memory/context-unreadable', `context path '${path}' is unreadable`, {
        path,
      }, { cause: error })
    }
    const root = await realpath(workspace.path).catch(() => workspace.path)
    const rootWithSep = root.endsWith(sep) ? root : root + sep
    if (canonical !== root && !canonical.startsWith(rootWithSep)) {
      throw new RemoteError('workspace-memory/context-unreadable', `context path '${path}' is not a regular file inside the Workspace`, { path })
    }
    let info: { isFile(): boolean; size: number }
    try {
      info = await stat(canonical)
    } catch (error) {
      /* v8 ignore next -- the realpath above already observed the path, so only a concurrent
      deletion in this synchronous window could fail the stat here. */
      throw new RemoteError('workspace-memory/context-unreadable', `context path '${path}' is unreadable`, {
        path,
      }, { cause: error })
    }
    if (!info.isFile()) {
      throw new RemoteError('workspace-memory/context-unreadable', `context path '${path}' is not a regular file`, { path })
    }
    return { path: canonical, sizeBytes: info.size }
  }
}

/**
 * Walk the Workspace directory depth-limited to 3, skipping node_modules,
 * .git, and dot-directories, keeping markdown/text/json files.
 * @param root - canonical Workspace path.
 * @param query - case-insensitive substring filter.
 * @param signal - optional caller cancellation for the walk.
 * @returns sorted workspace-relative paths capped at 200.
 */
export async function listWorkspaceFiles(root: string, query: string, signal?: AbortSignal): Promise<readonly string[]> {
  const needle = query.toLowerCase()
  const found: string[] = []
  const visit = async (dir: string, depth: number): Promise<void> => {
    signal?.throwIfAborted()
    if (depth > LIST_DEPTH) return
    let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= LIST_LIMIT) return
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue
      const absolute = join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(absolute, depth + 1)
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase()
        const dot = lower.lastIndexOf('.')
        const ext = dot < 0 ? '' : lower.slice(dot)
        if (!CONTEXT_FILE_EXTENSIONS.has(ext)) continue
        const rel = relative(root, absolute)
        if (needle.length > 0 && !rel.toLowerCase().includes(needle)) continue
        found.push(rel)
      }
    }
  }
  await visit(root, 0)
  found.sort()
  return found.slice(0, LIST_LIMIT)
}

export default WorkspaceMemoryController
