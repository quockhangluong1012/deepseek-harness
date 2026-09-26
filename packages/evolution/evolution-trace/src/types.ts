/**
 * Public type vocabulary of the evolution trace store: the structured
 * learning trace of one session, its ranked root-cause attribution, and the
 * compressed summary row the learning loop reads. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-trace/src/types
 */

import type {
  Capability,
  ResourceBudget,
  TaskStatus,
  TransitionKind,
  VerificationResult,
} from '@deepseek-ai/dsh-agent-kernel'
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

/** One task-state transition the kernel recorded for a step (§5.2 state delta). */
export interface TraceStateDelta {
  /** Task status before the transition. */
  from: TaskStatus
  /** Task status after the transition. */
  to: TaskStatus
  /** Why the kernel transitioned. */
  trigger: TransitionKind
  /** ISO-8601 instant of the transition, or null when the record carried no metadata. */
  at: string | null
}

/** The subagents one step delegated to (§5.2 subagent usage). */
export interface TraceSubagentUsage {
  /** Subagents the step delegated to. */
  count: number
  /** Child runs the step delegated to, in issue order. */
  runIds: readonly string[]
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
   * Estimated USD the step was billed for, from its route's catalog prices
   * (§5.2 estimated cost). Null when the step reported no usage sample, when no
   * route was in force, or when the route's catalog declares no price; a
   * retried attempt and the settled message both contribute, and a sample whose
   * route is unpriced contributes nothing.
   */
  estimatedCostUsd: number | null
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
  /**
   * Task-state transitions bound to this step (§5.2 state delta), in log order:
   * a transition recorded before the turn's first step opens the first step,
   * one recorded after the last step closes the last step, and one recorded
   * between two steps opens the following one. A transition recorded before any
   * turn opened is bound to no step.
   */
  stateDelta: readonly TraceStateDelta[]
  /** The subagents this step delegated to, bound the same way as {@link stateDelta}. */
  subagentUsage: TraceSubagentUsage
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

/** How one run ended (§5.1 Agent Trace). */
export type AgentRunStatus =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'budget_exceeded'
  | 'loop_detected'
  | 'timeout'

/** One delegated child run as the delegating log records it (§5.1 subagents). */
export interface TraceSubagent {
  /** Identity of the parent's delegation receipt. */
  delegationId: string
  /** Child run the parent delegated to. */
  runId: string
  /** Delegation depth of the child; a direct child is 1. */
  depth: number
  /** Ceilings the child's task contract started with. */
  limits: ResourceBudget
  /** Capabilities the receipt granted the child. */
  capabilities: readonly Capability[]
  /** Turn the receipt was issued in; null when it was issued before any turn opened. */
  turn: number | null
  /** Step the receipt was issued in; null when it followed none. */
  step: number | null
  /** ISO-8601 instant of the receipt. */
  issuedAt: string
}

/** The ceilings a run's task contract declared and the spend observed against them. */
export interface BudgetTrace {
  /** Ceilings the contract declared; an absent field is unbounded. */
  limits: ResourceBudget
  /** `step/start` records in the run. */
  steps: number
  /** `tool/call` records in the run. */
  toolCalls: number
  /** The run's steps' token accounting summed as {@link TraceRecord.usage} sums it. */
  tokens: number
  /** Wall-clock milliseconds from the run's contract to its newest recorded event. */
  wallMs: number
  /** Estimated USD over the run's priced steps; null when none was priceable. */
  costUsd: number | null
  /** Deepest child delegation depth the run reached; 0 without a delegation. */
  childDepth: number
}

/** The context placements one run compiled (§5.1 context). */
export interface ContextTrace {
  /** `context/compiled` records in the run. */
  compilations: number
  /** Placement digests in log order, the identity §17 reconstructs. */
  digests: readonly string[]
  /** Largest placement token estimate in the run; 0 when the run recorded none. */
  peakTokens: number
}

/** One verification result attributed to the run that requested it (§5.1 verification). */
export interface VerificationTrace extends VerificationResult {
  /** ISO-8601 instant of the result. */
  at: string
}

/**
 * The first-class execution trace of one run (§5.1 Agent Trace): the kernel's
 * task-and-transition records plus the agent-loop's step events, projected from
 * one session log. A session with no `task/created` record holds no run, and a
 * log that recorded several tasks holds one trace per run.
 */
export interface AgentTrace {
  /** Durable run identity the kernel gave the task. */
  runId: string
  /** Session whose log the run was projected from. */
  sessionId: string
  /** Task the run executes; the contract carries one at intake. */
  taskId: string
  /** Registered agent profile the task runs under. */
  profile: string
  /** ISO-8601 instant of the run's `task/created` record. */
  startedAt: string
  /** ISO-8601 instant of the record that ended the run; null while it has not ended. */
  endedAt: string | null
  /** Every step of the run in log order. */
  steps: readonly TraceStep[]
  /** Every tool call of the run in dispatch order. */
  toolCalls: readonly TraceToolCall[]
  /** Subagents the run delegated to, in issue order. */
  subagents: readonly TraceSubagent[]
  /** Observed spend against the contract's ceilings. */
  budget: BudgetTrace
  /** Context placements the run compiled. */
  context: ContextTrace
  /** Verification results the run recorded, in log order. */
  verification: readonly VerificationTrace[]
  /**
   * How the run ended, or null while it has not: the status the newest decisive
   * record gives it. The mapping from the kernel's records is total over an
   * ended run and is documented in the package README.
   */
  finalStatus: AgentRunStatus | null
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
