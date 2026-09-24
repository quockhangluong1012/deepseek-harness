/**
 * Workflow seam vocabulary: the request/run/result types a workflow engine
 * consumes and produces, plus the fields in the `workflow/*` event payloads.
 * Types only (plus the id-brand factory), per the package convention.
 *
 * @module @deepseek-ai/dsh-workflow/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identifies one workflow run. */
export type WorkflowRunId = Branded<'WorkflowRunId'>

/**
 * Brand a string as a {@link WorkflowRunId}.
 * @param id - the raw id string (the engine mints UUIDs; tests may pass fixtures).
 * @returns the same string, branded.
 */
export function WorkflowRunId(id: string): WorkflowRunId {
  return id as WorkflowRunId
}

/**
 * One phase declared in a script's `meta.phases` (progress vocabulary only —
 * phases group agents in observers/UIs; they impose no execution structure).
 */
export interface WorkflowPhase {
  /** The phase title; `phase()` calls match against it by exact string. */
  title: string
  /** Optional one-line description of what the phase does. */
  detail?: string
  /** Optional provider override this phase is expected to use (informational). */
  provider?: string
  /** Optional model override this phase is expected to use (informational). */
  model?: string
}

/**
 * The script's identity block, provided as plain JSON data alongside the
 * script body (the model-facing tool carries it as its `meta` parameter) and
 * validated by the engine before the body runs. `name`/`description` are
 * required; the rest is optional annotation. The field vocabulary matches the
 * Claude Code dynamic-workflows meta block.
 */
export interface WorkflowMeta {
  /** Short kebab-case workflow name (display + persistence key). */
  name: string
  /** One-line description of what the workflow does. */
  description: string
  /** Optional guidance on when this workflow applies (shown in listings). */
  whenToUse?: string
  /** Optional phase declarations matched by `phase()` calls. */
  phases?: WorkflowPhase[]
}

/**
 * Why a run settled. CLOSED union (engine-owned, consumers may exhaust):
 * `completed` = the script ran to its final `return`; `cancelled` = the run
 * was cancelled (caller `cancel()`/signal); `error` = the script threw, a
 * fatal `WorkflowError` propagated, or the result failed materialization.
 */
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'

/**
 * The outcome resolved by a live workflow run. `value` is
 * the script's materialized return value (plain host-realm JSON data; `null`
 * when the script returned `undefined`) — meaningful only for `completed`.
 * A non-`completed` reason carries the failure in `error`; the consumer maps
 * it to an `isError` tool result rather than reporting partial output.
 */
export interface WorkflowResult {
  /** The script's return value (host JSON data; `null` for no return). */
  value: unknown
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /**
   * How many `agent()` calls the run accepted over its whole lifetime. On a
   * graceful settlement this is the script-side count (calls still queued for
   * a concurrency slot included); on a termination path (cancellation or
   * process failure) it degrades to the host-observed count — calls queued
   * inside a terminated script are unknowable then.
   */
  agentsStarted: number
}

/** Identifying detail for a run, carried by every `workflow/*` event as borrowed immutable data, never the live run. */
export interface WorkflowRunInfo {
  /** The run's id. */
  id: WorkflowRunId
  /** The run's validated meta block. */
  meta: WorkflowMeta
}

/** Where one workflow run stands. */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * Everything one run needs to be resumed: its identity, where it stood when
 * the checkpoint was taken, and the inputs it was started with.
 *
 * The script is data, so a checkpoint is complete without engine state: a
 * resuming caller hands the same body and arguments back to the engine, which
 * is why a checkpoint can be persisted as plain JSON anywhere a caller keeps
 * durable records.
 */
export interface WorkflowCheckpointRef {
  /** Identity of this checkpoint, distinct from the run it describes. */
  readonly checkpointId: string
  /** The run this checkpoint was taken from. */
  readonly runId: WorkflowRunId
  /** Where the run stood when the checkpoint was taken. */
  readonly status: WorkflowRunStatus
  /** Unix epoch milliseconds the checkpoint was taken. */
  readonly createdAt: number
  /** The plain-JS script body, exactly as the start request carried it. */
  readonly script: string
  /** The run's validated meta block. */
  readonly meta: WorkflowMeta
  /** The run's input, when it had one. */
  readonly args?: unknown
  /** The child-provider override the run was started with, when it had one. */
  readonly subagentProvider?: string
  /** The per-run child ceiling the run was started with, when it had one. */
  readonly maxTotalAgents?: number
}

/** One `agent()` call's identity within a run (the `workflow/agent-start` payload). */
export interface WorkflowAgentInfo {
  /** 1-based sequence number of this `agent()` call within the run. */
  seq: number
  /** The display label (the `label` option, or a prompt snippet). */
  label: string
  /** The phase this agent belongs to (the `phase` option, else the current `phase()` title). */
  phase?: string
  /** The child agent's id on the subagent seam. */
  childId: SessionId
}

/** How one `agent()` call settled: clean result, child failure (script sees `null`), or run cancellation. */
export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'

/** One `agent()` call's settlement (the `workflow/agent-end` payload). */
export interface WorkflowAgentEndInfo extends WorkflowAgentInfo {
  /** How the call settled. */
  outcome: WorkflowAgentOutcome
}

/**
 * A settled run's outcome as event data (the `workflow/end` payload): the
 * {@link WorkflowResult} minus `value` (a listener observing outcomes must not
 * receive a mutable alias of the caller's result value; a consumer that needs
 * the value holds the run and awaits `result`).
 */
export interface WorkflowResultInfo {
  /** Why the run settled. */
  stopReason: WorkflowStopReason
  /** The failure message (present iff `stopReason` is not `completed`). */
  error?: string
  /** How many `agent()` calls the run accepted (see {@link WorkflowResult.agentsStarted}). */
  agentsStarted: number
}
