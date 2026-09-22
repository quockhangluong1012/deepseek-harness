/**
 * Public type vocabulary of the evolution trace store: the structured
 * learning trace of one session, its ranked root-cause attribution, and the
 * compressed summary row the learning loop reads. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-trace/src/types
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** One tool invocation recorded in a trace step, its call paired with its result. */
export interface TraceToolCall {
  /** Tool identity pairing the call with its result. */
  callId: string
  /** Tool name. */
  name: string
  /** Whether the result carried an error block. */
  ok: boolean
  /** Failure identity name when the tool reported one; null otherwise. */
  errorName: string | null
  /** Failure identity code when the tool reported one; null otherwise. */
  errorCode: string | null
  /** Clipped model-facing text of a failing result; null when the call succeeded. */
  message: string | null
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
