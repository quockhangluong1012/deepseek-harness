/**
 * Pure compression of one structured trace into the learning-trace row the
 * learning loop reads (§3.3): counts, summed usage and latency, and the
 * distinct failure gists in first-occurrence order — a session with nothing to
 * learn from contributes no row.
 * @module @deepseek-ai/dsh-evolution-trace/src/summarize
 */

import type { LearningTraceRow, TraceFailure, TraceRecord } from './types.ts'

/**
 * Compress one session's structured trace into its learning-trace row.
 * @param record - the structured trace.
 * @returns the row, or undefined when the session produced no turn.
 */
export function summarize(record: TraceRecord): LearningTraceRow | undefined {
  if (record.turnCount === 0) return undefined
  let calls = 0
  let failures = 0
  let retries = 0
  let tokens = 0
  let latencyMs = 0
  const gists: string[] = []
  const seen = new Set<string>()
  for (const turn of record.turns) {
    if (turn.latencyMs !== null) latencyMs += turn.latencyMs
    for (const step of turn.steps) {
      calls += step.calls.length
      failures += step.failures
      retries += step.retries
      if (step.usage !== null) tokens += step.usage.inputTokens + step.usage.outputTokens
    }
    for (const failure of turn.failures) collectGist(failure, gists, seen)
  }
  return {
    sessionId: record.sessionId,
    turns: record.turnCount,
    calls,
    failures,
    retries,
    tokens,
    latencyMs,
    failureGists: gists,
    updatedAt: record.updatedAt,
  }
}

/** Append one failure's gist once, in first-occurrence order. */
function collectGist(failure: TraceFailure, gists: string[], seen: Set<string>): void {
  if (seen.has(failure.message)) return
  seen.add(failure.message)
  gists.push(failure.message)
}
