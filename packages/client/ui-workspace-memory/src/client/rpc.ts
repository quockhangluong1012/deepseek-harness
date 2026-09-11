/**
 * Client Remote face for the `workspaceMemory` namespace: unary verbs with
 * result-carrying outcomes plus the follow-stream subscription over the
 * injected Remote stream service. The Host never rejects a call: failures
 * arrive as the error branch of the result, so `throw result.error` keeps
 * throw semantics for page code.
 * @module @deepseek-ai/dsh-client-ui-workspace-memory/client/rpc
 */

import type {
  RemoteStream,
  RemoteStreamOptions,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  WorkspaceMemoryContextFilesValue,
  WorkspaceMemoryFollowFrame,
  WorkspaceMemoryValue,
} from '../types.ts'

/** Baseline frame: every generation starts with the complete record set. */
export type WorkspaceMemoryBaseline = Extract<WorkspaceMemoryFollowFrame, { type: 'baseline' }>

/** Increment frame: one Workspace's record changed. */
export type WorkspaceMemoryUpsert = Extract<WorkspaceMemoryFollowFrame, { type: 'upsert' }>

/** Raw result-carrying unary verbs of the `workspaceMemory` Remote namespace. */
export interface RawVerbs {
  read(request: { readonly workspaceId: WorkspaceId }): Promise<RemoteResult<WorkspaceMemoryValue>>
  /** Replace the page blurb. */
  setDescription(
    request: { readonly workspaceId: WorkspaceId; readonly description: string },
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceMemoryValue>>
  /** Replace the instruction text. */
  setInstructions(
    request: { readonly workspaceId: WorkspaceId; readonly instructions: string },
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceMemoryValue>>
  /** Replace the memory document by hand. */
  setMemory(
    request: { readonly workspaceId: WorkspaceId; readonly memory: string },
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceMemoryValue>>
  /** Attach pasted text or a workspace file. */
  addContextItem(request: {
    readonly workspaceId: WorkspaceId
    readonly kind: 'text' | 'file'
    readonly label: string
    readonly text?: string
    readonly path?: string
  }, signal?: AbortSignal): Promise<RemoteResult<WorkspaceMemoryValue>>
  /** Detach one context item. */
  removeContextItem(
    request: { readonly workspaceId: WorkspaceId; readonly itemId: string },
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceMemoryValue>>
  /** List candidate paths for the add-file picker. */
  listContextFiles(
    request: { readonly workspaceId: WorkspaceId; readonly query: string },
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceMemoryContextFilesValue>>
  /** Rebuild the document from chat history. */
  rebuildMemory(
    request: { readonly workspaceId: WorkspaceId },
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceMemoryValue>>
}

/** Throwing unary verbs the page drives. */
export interface PageVerbs {
  /** Load one Workspace's record. */
  read(workspaceId: WorkspaceId): Promise<WorkspaceMemoryValue>
  /** Replace the page blurb. */
  setDescription(workspaceId: WorkspaceId, description: string): Promise<WorkspaceMemoryValue>
  /** Replace the instruction text. */
  setInstructions(workspaceId: WorkspaceId, instructions: string): Promise<WorkspaceMemoryValue>
  /** Replace the memory document by hand. */
  setMemory(workspaceId: WorkspaceId, memory: string): Promise<WorkspaceMemoryValue>
  /** Attach pasted text. */
  addTextItem(workspaceId: WorkspaceId, label: string, text: string): Promise<WorkspaceMemoryValue>
  /** Attach a workspace file. */
  addFileItem(workspaceId: WorkspaceId, label: string, path: string): Promise<WorkspaceMemoryValue>
  /** Detach one context item. */
  removeContextItem(workspaceId: WorkspaceId, itemId: string): Promise<WorkspaceMemoryValue>
  /** List candidate paths for the add-file picker. */
  listContextFiles(workspaceId: WorkspaceId, query: string, signal: AbortSignal): Promise<readonly string[]>
  /** Rebuild the document from chat history. */
  rebuildMemory(workspaceId: WorkspaceId, signal: AbortSignal): Promise<WorkspaceMemoryValue>
}

/** The page Remote: throwing verbs plus the follow-stream transport. */
export interface PageRemote extends PageVerbs {
  /** Open one physical follow generation. */
  follow(signal: AbortSignal): AsyncIterable<WorkspaceMemoryFollowFrame>
  /** Open the reconnecting stream over follow generations. */
  openStream(options: RemoteStreamOptions<WorkspaceMemoryFollowFrame>): RemoteStream<WorkspaceMemoryFollowFrame>
}

/**
 * Unwrap one result-carrying Remote outcome.
 * @param result - the Host outcome.
 * @returns the value; throws the Host failure when the call did not succeed.
 */
export function unwrapResult<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

/**
 * Bind the unary verbs to one Remote face, unwrapping results into values.
 * @param remote - the Client Remote carrying the `workspaceMemory` namespace.
 * @returns the throwing page verbs.
 */
export function bindPageVerbs(remote: { readonly workspaceMemory: RawVerbs }): PageVerbs {
  const verbs = remote.workspaceMemory
  return {
    read: async workspaceId => unwrapResult(await verbs.read({ workspaceId })),
    setDescription: async (workspaceId, description) => unwrapResult(await verbs.setDescription({ workspaceId, description })),
    setInstructions: async (workspaceId, instructions) => unwrapResult(await verbs.setInstructions({ workspaceId, instructions })),
    setMemory: async (workspaceId, memory) => unwrapResult(await verbs.setMemory({ workspaceId, memory })),
    addTextItem: async (workspaceId, label, text) => unwrapResult(await verbs.addContextItem({ workspaceId, kind: 'text', label, text })),
    addFileItem: async (workspaceId, label, path) => unwrapResult(await verbs.addContextItem({ workspaceId, kind: 'file', label, path })),
    removeContextItem: async (workspaceId, itemId) => unwrapResult(await verbs.removeContextItem({ workspaceId, itemId })),
    listContextFiles: async (workspaceId, query, signal) =>
      unwrapResult(await verbs.listContextFiles({ workspaceId, query }, signal)).paths,
    rebuildMemory: async (workspaceId, signal) => unwrapResult(await verbs.rebuildMemory({ workspaceId }, signal)),
  }
}

/** The generated namespace face: result-carrying verbs plus the follow stream. */
export interface NamespaceFace extends RawVerbs {
  /** Stream baselines and upserts. */
  follow(signal: AbortSignal): AsyncIterable<WorkspaceMemoryFollowFrame>
}

/** Destinations for one page follow subscription. */
export interface MemoryFollowSink {
  /** Replace the published record set from a complete baseline. */
  replace(values: readonly WorkspaceMemoryValue[]): void
  /** Apply one Workspace record change. */
  upsert(value: WorkspaceMemoryValue): void
  /** Publish a terminal stream failure. */
  failed(error: unknown): void
}

/**
 * Subscription handle for one page follow: dispose it when the page closes.
 */
export interface MemoryFollowSubscription {
  /** Stop the stream and wait for the consumer loop to quiesce. */
  dispose(): Promise<void>
}

/**
 * Subscribe to the memory follow stream through the injected Remote stream
 * service: one complete baseline, then an upsert per durable record change,
 * with a fresh baseline per reconnect generation. Reconnect stays inside
 * `RemoteStream` — this loop only applies frames in arrival order, which is
 * exact because generations serialize through the single iterator with a
 * fresh baseline each. Carrier-loss retry never reaches here; a clean end
 * (which the host follow only performs on abort) surfaces as a failure.
 * @param remote - the page Remote carrying follow and the stream factory.
 * @param sink - baseline/upsert/failure destinations owned by the page.
 * @returns the running subscription; dispose it when the page closes.
 */
export function followMemory(
  remote: Pick<PageRemote, 'follow' | 'openStream'>,
  sink: MemoryFollowSink,
): MemoryFollowSubscription {
  const stream = remote.openStream({
    name: 'Workspace memory page stream',
    open: signal => remote.follow(signal),
    ended: accepted => accepted
      ? new Error('Workspace memory page stream ended without a terminal result')
      : new Error('Workspace memory page stream ended before its opening snapshot'),
  })
  let generation = -1
  const done = (async (): Promise<void> => {
    // The page drops every sink call after unmount, so the loop needs no
    // disposed flag of its own: dispose ends the stream cleanly, and only a
    // genuine failure reaches failed.
    try {
      for await (const item of stream) {
        const frame = item.value
        if (frame.type === 'baseline') {
          if (item.generation === generation) {
            throw new Error('Workspace memory page stream published more than one opening snapshot')
          }
          generation = item.generation
          sink.replace(frame.values)
        } else sink.upsert(frame.value)
        item.accept()
      }
    } catch (error) {
      sink.failed(error)
    }
  })()
  return {
    dispose: async (): Promise<void> => {
      await stream.dispose()
      await done
    },
  }
}
