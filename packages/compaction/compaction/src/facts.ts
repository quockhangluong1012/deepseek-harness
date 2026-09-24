/**
 * What one compaction checkpoint records: the facts that survived the
 * replacement, the work still open, the results it dropped, the unresolved
 * failures, and the digest of what the summary now says.
 *
 * Compaction may remove verbose tool output from the next request, but it may
 * not remove policy, task acceptance, a pending approval, the active plan
 * revision, an unresolved failure, or an evidence reference. This module
 * derives the record from the session log so a reader can tell what a
 * checkpoint kept, without the compaction package depending on the packages
 * that declare those event families: event types are compared as strings and
 * payload fields are validated structurally, because the log is a durable
 * boundary.
 *
 * @module @deepseek-ai/dsh-compaction/facts
 */

import { createHash } from 'node:crypto'

/**
 * One event as this module reads it: a log view, not the session's own union.
 * The checkpoint records facts about families this package does not declare, so
 * the type is the durable shape the log always has — an offset, a type name,
 * and a payload the reader validates structurally.
 */
export interface CompactionLogEvent {
  /** Log offset. */
  readonly seq: number
  /** Event type name. */
  readonly type: string
  /** Event payload, validated field by field where it is read. */
  readonly data: unknown
}

/** One durable fact a checkpoint kept, so the next request can still rely on it. */
export interface CompactionRetainedFact {
  /** Durable identity of the retained record. */
  readonly id: string
  /** Which family the fact belongs to. */
  readonly kind: 'task' | 'plan' | 'policy' | 'approval' | 'evidence'
  /** Human- and model-readable statement of what was kept. */
  readonly statement: string
}

/** One failure the log recorded and never resolved. */
export interface CompactionUnresolvedFailure {
  /** Failure identity. */
  readonly failureId: string
  /** Classification the failing record carries. */
  readonly kind: string
}

/** One tool call the retained log left without a result. */
export interface CompactionOpenWork {
  /** Tool call identity. */
  readonly callId: string
  /** Registered tool name that was called. */
  readonly toolName: string
}

/** The facts one compaction checkpoint records. */
export interface CompactionCheckpointFacts {
  /** Compaction transaction this checkpoint belongs to. */
  readonly checkpointId: string
  /**
   * First and last shadowed log offsets. These are the range the replacement
   * answered, not a surface-position span.
   */
  readonly sourceSeqRange: { readonly start: number; readonly end: number }
  /** Durable facts that survived the replacement. */
  readonly retainedFacts: readonly CompactionRetainedFact[]
  /** Tool results the replacement dropped. */
  readonly droppedToolResultIds: readonly string[]
  /** Tool calls still awaiting a result in the retained log. */
  readonly openWork: readonly CompactionOpenWork[]
  /** Failures the retained log records and never resolves. */
  readonly unresolvedFailures: readonly CompactionUnresolvedFailure[]
  /** Digest of the summary text the replacement carries. */
  readonly contextDigest: string
  /** Model that produced the summary. */
  readonly summarizer: { readonly provider: string; readonly model: string }
}

/** Everything the checkpoint is derived from. */
export interface CompactionCheckpointInput {
  /** Compaction transaction identity. */
  readonly checkpointId: string
  /** Log offsets the replacement shadows. */
  readonly shadowedSeqs: readonly number[]
  /** Plain text of the summary the replacement carries. */
  readonly summaryText: string
  /** Model that produced the summary. */
  readonly summarizer: { readonly provider: string; readonly model: string }
  /** The session's events, in log order. */
  readonly events: readonly CompactionLogEvent[]
  /** Tool results the compaction dropped. */
  readonly droppedToolResultIds: readonly string[]
}

/**
 * Derive one compaction checkpoint from the log it compacted.
 * @param input - the transaction identity, the shadowed offsets, the summary, the log, and the dropped results.
 * @returns the checkpoint the summary event records.
 */
export function deriveCompactionCheckpoint(input: CompactionCheckpointInput): CompactionCheckpointFacts {
  const shadowed = new Set(input.shadowedSeqs)
  const retained = input.events.filter(event => !shadowed.has(event.seq))
  return {
    checkpointId: input.checkpointId,
    sourceSeqRange: {
      start: input.shadowedSeqs.length === 0 ? 0 : Math.min(...input.shadowedSeqs),
      end: input.shadowedSeqs.length === 0 ? 0 : Math.max(...input.shadowedSeqs),
    },
    retainedFacts: retainedFacts(retained),
    droppedToolResultIds: [...input.droppedToolResultIds],
    openWork: openWork(retained),
    unresolvedFailures: unresolvedFailures(failureStates(retained)),
    contextDigest: createHash('sha256').update(input.summaryText).digest('hex'),
    summarizer: { ...input.summarizer },
  }
}

/** The durable facts a compaction must never remove, in log order. */
function retainedFacts(events: readonly CompactionLogEvent[]): CompactionRetainedFact[] {
  const facts: CompactionRetainedFact[] = []
  for (const event of events) {
    const data = recordOf(event.data)
    if (event.type === 'task/created' && typeof data?.objective === 'string' && typeof data.taskId === 'string') {
      facts.push({ id: data.taskId, kind: 'task', statement: data.objective })
      continue
    }
    if (event.type === 'task/plan' && typeof data?.revision === 'number' && Array.isArray(data.steps)) {
      facts.push({
        id: `plan-${String(data.revision)}`,
        kind: 'plan',
        statement: `plan revision ${String(data.revision)}: ${data.steps.map(String).join(' → ')}`,
      })
      continue
    }
    if (event.type === 'action/decided') {
      const policy = recordOf(data?.policy)
      const proposal = recordOf(data?.proposal)
      if (typeof policy?.effect === 'string' && typeof proposal?.actionId === 'string') {
        facts.push({
          id: proposal.actionId,
          kind: 'policy',
          statement: `policy ${policy.effect} for ${typeof proposal.toolName === 'string' ? proposal.toolName : 'an action'}`,
        })
      }
      continue
    }
    if (event.type === 'approval/asked' && typeof data?.id === 'string') {
      facts.push({ id: data.id, kind: 'approval', statement: 'approval requested and not yet answered' })
      continue
    }
    if (event.type === 'evidence/recorded' && typeof data?.evidenceId === 'string' && typeof data.contentRef === 'string') {
      facts.push({ id: data.evidenceId, kind: 'evidence', statement: data.contentRef })
    }
  }
  return facts
}

/**
 * Recorded failures by identity, with the resolutions the log also records.
 * One pass keeps the fold linear in the retained log.
 * @param events - the retained events, in log order.
 * @returns every recorded failure and whether something resolved it.
 */
function failureStates(events: readonly CompactionLogEvent[]): Map<string, { kind: string; actionId?: string; resolved: boolean }> {
  const states = new Map<string, { kind: string; actionId?: string; resolved: boolean }>()
  for (const event of events) {
    const data = recordOf(event.data)
    if (event.type === 'failure/recorded' && typeof data?.failureId === 'string') {
      states.set(data.failureId, {
        kind: typeof data.kind === 'string' ? data.kind : 'unknown',
        ...typeof data.actionId === 'string' ? { actionId: data.actionId } : {},
        resolved: false,
      })
      continue
    }
    if (event.type === 'verification/result' && data?.status === 'pass') {
      for (const state of states.values()) state.resolved = true
      continue
    }
    if (event.type === 'action/committed' && data?.outcome === 'succeeded' && typeof data.actionId === 'string') {
      for (const state of states.values()) {
        if (state.actionId === data.actionId) state.resolved = true
      }
    }
  }
  return states
}

/** Tool calls the retained log never answered. */
function unresolvedFailures(
  states: ReadonlyMap<string, { kind: string; resolved: boolean }>,
): CompactionUnresolvedFailure[] {
  return [...states]
    .filter(([, state]) => !state.resolved)
    .map(([failureId, state]) => ({ failureId, kind: state.kind }))
}

function openWork(events: readonly CompactionLogEvent[]): CompactionOpenWork[] {
  const answers = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const callId = recordOf(event.data)?.callId
    if (typeof callId === 'string') answers.add(callId)
  }
  const open: CompactionOpenWork[] = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = recordOf(event.data)
    if (typeof data?.callId !== 'string' || answers.has(data.callId)) continue
    open.push({ callId: data.callId, toolName: typeof data.name === 'string' ? data.name : 'unknown' })
  }
  return open
}

/** One event payload as a record, when it is one. */
function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}
