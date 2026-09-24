/**
 * Host-only workflow request and live-run handles. The browser-safe durable
 * vocabulary remains in `./types` so Client programs never import Agent or
 * host Cordis context declarations.
 *
 * @module @deepseek-ai/dsh-workflow
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  WorkflowCheckpointRef, WorkflowMeta, WorkflowResult, WorkflowRunId, WorkflowRunStatus,
} from './types.ts'

/**
 * What a caller asks for when starting a workflow run. `meta` and `args` are
 * plain JSON data by the seam contract. `parent` is required because every
 * `agent()` spawned by the script is attributed to that live Agent.
 */
export interface WorkflowStartRequest {
  /** The plain-JS script body (top-level await allowed; ends with `return <json-value>`). */
  script: string
  /** The workflow's identity block, as plain JSON data (shape-validated by the engine). */
  meta: WorkflowMeta
  /** Optional input exposed verbatim to the script as the `args` global. */
  args?: unknown
  /** Optional engine-wide child-provider override for this run. */
  subagentProvider?: string
  /** Optional per-run total-child ceiling. */
  maxTotalAgents?: number
  /** The agent on whose behalf the run executes (parent of every child). */
  parent: Agent
  /** Cancels the run when aborted. */
  signal?: AbortSignal
}

/**
 * Holder-owned live workflow. `result` never rejects; consumers may cancel
 * and must call idempotent `dispose()` to await script and child quiescence.
 */
export interface WorkflowRun {
  readonly id: WorkflowRunId
  /** The validated meta block available before the script body runs. */
  readonly meta: WorkflowMeta
  /** Where the run stands right now. */
  readonly status: WorkflowRunStatus
  readonly result: Promise<WorkflowResult>
  /**
   * Capture what this run would need to be resumed later. Safe to call while
   * the run is live: it reads the run's inputs, not its in-flight state.
   * @returns the durable checkpoint reference.
   */
  checkpoint(): Promise<WorkflowCheckpointRef>
  /** Cancel the run and its children. */
  cancel(reason?: string): void
  /** Cancel if needed and await script and child cleanup. */
  dispose(): Promise<void>
}

/** What a caller hands back to {@link WorkflowEngine} to resume a checkpointed run. */
export interface WorkflowResumeRequest {
  /** The checkpoint to resume. */
  readonly checkpoint: WorkflowCheckpointRef
  /** The agent the resumed run executes on behalf of (parent of every child). */
  readonly parent: Agent
  /** Cancels the resumed run when aborted. */
  readonly signal?: AbortSignal
}
