/**
 * Public type vocabulary of the evolution trace store: the structured
 * learning trace of one session, its ranked root-cause attribution, and the
 * compressed summary row the learning loop reads. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-trace/src/types
 */

import type { VerificationResult } from '@deepseek-ai/dsh-agent-kernel'
import type { ContextCompilationRecord } from '@deepseek-ai/dsh-agent-context'
import type { FeedbackRecord } from '@deepseek-ai/dsh-command-feedback/types'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'

/** One tool invocation recorded in a trace step, its call paired with its result. */
export interface TraceToolCall {
  /** Tool identity pairing the call with its result. */
  callId: string
  /** Tool name. */
  name: string
  /** Whether the recorded result carried an error block. */
  ok: boolean
  /** Failure identity name when the tool reported one; null otherwise. */
  errorName: string | null
  /** Failure identity code when the tool reported one; null otherwise. */
  errorCode: string | null
  /** Clipped model-facing text of a failing result; null when the call succeeded. */
  message: string | null
  /**
   * Clipped model-facing text of the recorded result, whatever its outcome —
   * the snapshot a replay reconstructs the step from (§17). Null when the log
   * recorded no text for the call's result, which is what makes its step
   * unreplayable.
   */
  snapshot: string | null
  /** ISO-8601 instant of the result, the newest event that settled the call. */
  at: string
}

/** One model step inside a turn: the model call plus the tool executions it requested. */
export interface TraceStep {
  /** Owning turn number. */
  turn: number
  /** Step number inside the turn. */
  step: number
  /** ISO-8601 instant of the step open. */
  startedAt: string
  /** ISO-8601 instant of the step's newest event, or null when never settled. */
  finishedAt: string | null
  /** Whether the settled assistant message was interrupted mid-stream. */
  interrupted: boolean
  /** Model attempts that committed no surface message: the retry evidence. */
  retries: number
  /** Token accounting of the settled assistant message; null when the adapter reported none. */
  usage: TokenUsage | null
  /**
   * The compiled-context record in force when the step ran, or null when the
   * session log holds no `context/compiled` event (§3.1 context snapshot/hash).
   * The record's `digest` is the placement identity §17 reconstructs.
   */
  context: ContextCompilationRecord | null
  /** Tool calls in dispatch order, each paired with its result. */
  calls: readonly TraceToolCall[]
  /** Calls whose result carried an error block. */
  failures: number
}

/** One turn of a session trace, open or ended. */
export interface TraceTurn {
  /** Turn number. */
  turn: number
  /** ISO-8601 instant of the turn open. */
  startedAt: string
  /** ISO-8601 instant of the turn close, or null while the turn stays open. */
  endedAt: string | null
  /** `turn/end` reason kind, or null while the turn stays open. */
  endReason: string | null
  /** Milliseconds between open and close; null while the turn stays open. */
  latencyMs: number | null
  /** First user-role message gist of the turn, clipped: the request the turn answered. */
  request: string | null
  /**
   * The plan and subgoals in force in the turn, from the newest `task/plan`
   * revision or `todo/write` snapshot at or before it (§3.1 plan and subgoals);
   * null when the log recorded none. A `todo/write` snapshot supplies each
   * subgoal's status, a kernel plan revision leaves it null.
   */
  subgoals: readonly TraceSubgoal[] | null
  /**
   * Knowledge surfaces the turn consulted — retrieval tool calls in result
   * order (§3.1 retrieved memories/skills), whether or not they returned
   * anything useful.
   */
  retrievals: readonly TraceRetrieval[]
  /**
   * Clipped text of the last assistant message in the turn that carried any —
   * the answer the turn ended on (§3.1 final answer); null when none did.
   */
  finalAnswer: string | null
  /** Steps in order. */
  steps: readonly TraceStep[]
  /** Failed tool calls with their ranked root-cause candidates, in result order. */
  failures: readonly TraceFailure[]
}

/** What kind of trace step one root-cause candidate points at. */
export type TraceCauseKind = 'tool' | 'retrieval' | 'request'

/** One ranked root-cause candidate of a failure (a heuristic, never a model judgment). */
export interface TraceCause {
  /** Whether the candidate is the failing call, an earlier producer, a retrieval, or the request. */
  kind: TraceCauseKind
  /** Owning turn. */
  turn: number
  /** Step of the candidate; the request candidate carries null. */
  step: number | null
  /** Tool name for tool and retrieval candidates; null for the request candidate. */
  tool: string | null
  /** Why this candidate ranks here. */
  reason: string
}

/** One failed tool call with its ranked root-cause candidates. */
export interface TraceFailure {
  /** Tool identity of the failing call. */
  callId: string
  /** Tool name. */
  tool: string
  /** Clipped failing text as observed. */
  message: string
  /** ISO-8601 instant of the failure. */
  at: string
  /** Ranked root-cause candidates, most likely first. */
  causes: readonly TraceCause[]
}

/** One subgoal of the plan a turn ran under (§3.1 plan and subgoals). */
export interface TraceSubgoal {
  /** The subgoal text as recorded. */
  content: string
  /** Recorded lifecycle status, or null when the plan source recorded none. */
  status: TodoItem['status'] | null
}

/** One knowledge surface a turn consulted: a retrieval call with the target it named. */
export interface TraceRetrieval {
  /** Tool identity of the retrieval call. */
  callId: string
  /** Tool name, e.g. `skill`. */
  tool: string
  /**
   * Target the call named — the recorded arguments' `name`, else their `query`,
   * clipped; null when the recorded arguments carried neither as a string.
   */
  target: string | null
  /** Whether the retrieval's result settled without an error block. */
  ok: boolean
}

/** One human remark recorded against the session (§3.1 user feedback). */
export interface TraceFeedback extends FeedbackRecord {
  /** ISO-8601 instant the remark was recorded. */
  at: string
}

/** The structured event trace of one session: the machine-readable learning form. */
export interface TraceRecord {
  /** Session identity. */
  sessionId: string
  /** ISO-8601 instant of the newest event, or null for an empty log. */
  updatedAt: string | null
  /** Turn count. */
  turnCount: number
  /** Turns in order. */
  turns: readonly TraceTurn[]
  /** Summed token accounting across settled assistant messages; null when none reported. */
  usage: TokenUsage | null
  /** Recorded evaluations of the session's task revisions (§3.1 evaluator results), in log order. */
  evaluations: readonly VerificationResult[]
  /** Human remarks recorded against the session (§3.1 user feedback), in log order. */
  feedback: readonly TraceFeedback[]
}

/** The compressed learning-trace row one session contributes. */
export interface LearningTraceRow {
  /** Session identity. */
  sessionId: string
  /** Distinct turns. */
  turns: number
  /** Tool calls across the session. */
  calls: number
  /** Failed tool calls. */
  failures: number
  /** Model attempts that committed no surface message: the retry evidence. */
  retries: number
  /** Summed billed input+output tokens when any step reported usage. */
  tokens: number
  /** Total latency of ended turns, in milliseconds. */
  latencyMs: number
  /** Distinct failure gists, clipped at projection time, in first-occurrence order. */
  failureGists: readonly string[]
  /** ISO-8601 instant of the newest event, or null for an empty log. */
  updatedAt: string | null
}

/** One artifact revision a replay restores and compares (§16, §17). */
export interface ReplayArtifact {
  /** Artifact identity: the target a retrieval call of the trace names. */
  id: string
  /** Revision label the caller stamps; the session log records no artifact version. */
  version: string
  /** Body the replay restores where the trace recorded a retrieval of `id`. */
  body: string
}

/** One tool call as the replay resolved it. */
export interface ReplayCallOutcome {
  /** Tool name. */
  tool: string
  /** Where the call's output came from. */
  source: 'snapshot' | 'artifact' | 'missing'
  /** The output the replay used; null when the log recorded none for the call. */
  output: string | null
}

/** One step's counterfactual comparison under one artifact revision. */
export interface ReplayStepReport {
  /** Owning turn. */
  turn: number
  /** Step number inside the turn. */
  step: number
  /** Digest of the context the step ran under; null when the log recorded no compilation. */
  context: string | null
  /**
   * `replayed` when every call resolved from recorded evidence, `unreplayable`
   * when at least one call has no recorded output to stand on.
   */
  status: 'replayed' | 'unreplayable'
  /** Tools whose recorded result carried no model-facing text, in call order. */
  unreplayableTools: readonly string[]
  /** Baseline resolution per call, in call order. */
  baseline: readonly ReplayCallOutcome[]
  /** Candidate resolution per call, in call order. */
  candidate: readonly ReplayCallOutcome[]
  /**
   * Whether the candidate changes what the step produced. False for a step that
   * could not be replayed: an unreconstructed step is not evidence of parity.
   */
  differs: boolean
}

/** One replay of a recorded trace: the two artifacts' per-step counterfactual (§16, §17). */
export interface ReplayReport {
  /** Session the replayed trace belongs to. */
  sessionId: string
  /** Artifact identity both revisions carry. */
  artifact: string
  /** Revision label of the baseline. */
  baseline: string
  /** Revision label of the candidate. */
  candidate: string
  /** Per-step comparison in trace order. */
  steps: readonly ReplayStepReport[]
  /**
   * Steps the replay reconstructed from recorded tool output alone — the
   * subset of `replayed` steps where neither revision's body replaced a call,
   * so their output is exactly the recorded run's. Named `turn.step`.
   */
  snapshotSteps: readonly string[]
  /** Steps the candidate changes, named `turn.step` in trace order. */
  changedSteps: readonly string[]
  /** Steps the replay could not reconstruct, named `turn.step` in trace order. */
  unreplayableSteps: readonly string[]
}

/** One replay request: the recorded trace plus the two artifact revisions to run over it. */
export interface ReplayRequest {
  /** The trace to replay. */
  trace: TraceRecord
  /** The artifact revision the recorded run used. */
  baseline: ReplayArtifact
  /** The artifact revision under consideration. */
  candidate: ReplayArtifact
}
