/**
 * The pure scorer: turn one scenario's expectation and its fresh-process
 * attempts into the metric triple. No filesystem, process, or service access
 * happens here, so specs drive it with recorded observations.
 * @module @deepseek-ai/dsh-evolution-scorer/score
 */

import { medianOf } from './statistics.ts'
import { diffWorkspace } from './workspace.ts'
import type { ScoreInput, ScoreRecord, WorkspaceChange } from './types.ts'

/**
 * Score one scenario from its attempts.
 *
 * `pass` holds when every attempt's final workspace matches the scenario's
 * expected capture, or its own initial state when the scenario ships no
 * `workspace.expected/`. `changes` reports the first divergent attempt, so a
 * failure names paths rather than only a verdict. Tokens and wall time are
 * medians across attempts. `fixtureDigest` passes through unchanged, and
 * `trajectory` carries the first attempt's harvested session id, or null.
 * @param input - scenario name, expected capture, the fixture digest, and the per-attempt observations.
 * @returns the metric triple for this scenario.
 */
export function scoreRun(input: ScoreInput): ScoreRecord {
  let changes: WorkspaceChange[] = []
  for (const attempt of input.attempts) {
    const diff = diffWorkspace(input.expected ?? attempt.initial, attempt.final)
    if (diff.length > 0) {
      changes = diff
      break
    }
  }
  return {
    scenario: input.scenario,
    pass: changes.length === 0,
    changes,
    tokens: medianOf(input.attempts.map(attempt => attempt.tokens)),
    wallTimeMs: medianOf(input.attempts.map(attempt => attempt.wallTimeMs)),
    samples: input.attempts.map(attempt => attempt.wallTimeMs),
    fixtureDigest: input.fixtureDigest,
    trajectory: input.attempts[0]?.sessionId ?? null,
  }
}
