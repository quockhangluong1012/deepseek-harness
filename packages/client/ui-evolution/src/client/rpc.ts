/**
 * Client Remote face for the journey page: the throwing `evolution` verbs the
 * cards drive, the `evolutionCurator` status read, and the follow-stream
 * subscription over the injected Remote stream service. The Host never rejects
 * a call: failures arrive as the error branch of the result, so
 * `throw result.error` keeps throw semantics for page code.
 * @module @deepseek-ai/dsh-client-ui-evolution/client/rpc
 */

import type {
  RemoteStream,
  RemoteStreamOptions,
} from '@deepseek-ai/dsh-api-gateway/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  EvolutionCuratorStatus,
  EvolutionFollowFrame,
  EvolutionMemoryValue,
  JourneyTimeline,
  UsageRange,
  WorkspaceId,
} from '../types.ts'

/** Baseline frame: every generation starts with the complete Scope set. */
export type EvolutionBaseline = Extract<EvolutionFollowFrame, { type: 'baseline' }>

/** Increment frame: one Scope's record changed. */
export type EvolutionUpsert = Extract<EvolutionFollowFrame, { type: 'upsert' }>

// Every verb here mirrors the generated `evolution` / `evolutionCurator` faces
// exactly, cancellation included: the Client API counts arguments against the
// Host contract, so a Hand-written face that declares a trailing AbortSignal
// the Host method does not take fails at the call, not at the type.

/** Raw result-carrying unary verbs of the `evolution` Remote namespace. */
export interface RawVerbs {
  /** Load one Scope's record. */
  read(request: { readonly scopeId: WorkspaceId }): Promise<RemoteResult<EvolutionMemoryValue>>
  /** Render one Scope's journey over a window. */
  timeline(
    request: { readonly scopeId: WorkspaceId; readonly range: UsageRange },
  ): Promise<RemoteResult<JourneyTimeline>>
  /** Apply one staged write. */
  approveStaged(
    request: { readonly scopeId: WorkspaceId; readonly stagedId: string },
  ): Promise<RemoteResult<EvolutionMemoryValue>>
  /** Drop one staged write without applying it. */
  rejectStaged(
    request: { readonly scopeId: WorkspaceId; readonly stagedId: string },
  ): Promise<RemoteResult<EvolutionMemoryValue>>
}

/** Raw result-carrying face of the `evolutionCurator` Remote namespace. */
export interface CuratorRawVerbs {
  /** Read the curator's recorded status. */
  status(): Promise<RemoteResult<EvolutionCuratorStatus>>
}

/** Throwing verbs the page drives. */
export interface PageVerbs {
  /** Load one Scope's record. */
  read: (scopeId: WorkspaceId) => Promise<EvolutionMemoryValue>
  /** Render one Scope's journey over a window. */
  timeline: (scopeId: WorkspaceId, range: UsageRange) => Promise<JourneyTimeline>
  /** Apply one staged write. */
  approveStaged: (scopeId: WorkspaceId, stagedId: string) => Promise<EvolutionMemoryValue>
  /** Drop one staged write without applying it. */
  rejectStaged: (scopeId: WorkspaceId, stagedId: string) => Promise<EvolutionMemoryValue>
  /** Read the curator's recorded status. */
  curatorStatus: () => Promise<EvolutionCuratorStatus>
}

/** The page Remote: throwing verbs plus the follow-stream transport. */
export interface PageRemote extends PageVerbs {
  /** Open one physical follow generation. */
  follow: (signal: AbortSignal) => AsyncIterable<EvolutionFollowFrame>
  /** Open the reconnecting stream over follow generations. */
  openStream: (options: RemoteStreamOptions<EvolutionFollowFrame>) => RemoteStream<EvolutionFollowFrame>
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
 * Bind the page verbs to the mounted Remote faces, unwrapping results into
 * values.
 * @param remote - the Client Remote carrying both namespaces.
 * @returns the throwing page verbs.
 */
export function bindPageVerbs(
  remote: { readonly evolution: RawVerbs; readonly evolutionCurator: CuratorRawVerbs },
): PageVerbs {
  const verbs = remote.evolution
  const curator = remote.evolutionCurator
  return {
    read: async scopeId => unwrapResult(await verbs.read({ scopeId })),
    timeline: async (scopeId, range) => unwrapResult(await verbs.timeline({ scopeId, range })),
    approveStaged: async (scopeId, stagedId) => unwrapResult(await verbs.approveStaged({ scopeId, stagedId })),
    rejectStaged: async (scopeId, stagedId) => unwrapResult(await verbs.rejectStaged({ scopeId, stagedId })),
    curatorStatus: async () => unwrapResult(await curator.status()),
  }
}

/** The generated namespace face: result-carrying verbs plus the follow stream. */
export interface NamespaceFace extends RawVerbs {
  /** Stream baselines and upserts. */
  follow(signal: AbortSignal): AsyncIterable<EvolutionFollowFrame>
}

/** Destinations for one page follow subscription. */
export interface EvolutionFollowSink {
  /** Replace the published Scope set from a complete baseline. */
  replace(values: readonly EvolutionMemoryValue[]): void
  /** Apply one Scope record change. */
  upsert(value: EvolutionMemoryValue): void
  /** Publish a terminal stream failure. */
  failed(error: unknown): void
}

/** Subscription handle for one page follow: dispose it when the page closes. */
export interface EvolutionFollowSubscription {
  /** Stop the stream and wait for the consumer loop to quiesce. */
  dispose(): Promise<void>
}

/**
 * Subscribe to the evolution follow stream through the injected Remote stream
 * service: one complete baseline, then an upsert per durable Scope change, with
 * a fresh baseline per reconnect generation. Reconnect stays inside
 * `RemoteStream` — this loop only applies frames in arrival order, which is
 * exact because generations serialize through the single iterator with a fresh
 * baseline each. Carrier-loss retry never reaches here; a clean end (which the
 * Host follow only performs on abort) surfaces as a failure.
 * @param remote - the page Remote carrying follow and the stream factory.
 * @param sink - baseline/upsert/failure destinations owned by the page.
 * @returns the running subscription; dispose it when the page closes.
 */
export function followEvolution(
  remote: Pick<PageRemote, 'follow' | 'openStream'>,
  sink: EvolutionFollowSink,
): EvolutionFollowSubscription {
  const stream = remote.openStream({
    name: 'Evolution journey page stream',
    open: signal => remote.follow(signal),
    ended: accepted => accepted
      ? new Error('Evolution journey page stream ended without a terminal result')
      : new Error('Evolution journey page stream ended before its opening snapshot'),
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
            throw new Error('Evolution journey page stream published more than one opening snapshot')
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
