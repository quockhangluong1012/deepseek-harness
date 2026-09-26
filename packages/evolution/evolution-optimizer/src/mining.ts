/**
 * Holdout mining: turn the failure signals a scope's recorded trajectories
 * already carry into candidate holdout scenarios, so the holdout a promotion is
 * checked against is drawn from what actually failed rather than from a
 * hand-written config list (amendment S9).
 *
 * Two existing producers supply the signals: `dsh-evolution-trace` compresses a
 * session into one learning row whose `failureGists` name the distinct failures
 * it hit, and `dsh-evolution-feedback` aggregates the same failures across
 * sessions with their tool attribution and observation counts. One failure
 * pattern becomes one candidate scenario, named by a digest of the pattern so
 * the name is a stable, corpus-safe directory name a recorder can use, and
 * carrying the evidence behind it — which signals named it, how often they fired —
 * so a drawn holdout stays auditable. Pure folding plus the two selection
 * helpers; the optimizer owns the reads, the budget gate, and the durable
 * corpus.
 * @module @deepseek-ai/dsh-evolution-optimizer/mining
 */

import { createHash } from 'node:crypto'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import type { LearningTraceRow } from '@deepseek-ai/dsh-evolution-trace'
import type { MinedScenario, MinedScenarioSource } from './types.ts'

/** One recorded signal a mined scenario can come from. */
export interface MineSignals {
  /** Compressed learning rows of the sessions the scope's scored runs recorded. */
  traces: readonly LearningTraceRow[]
  /** Aggregated failures of those same sessions. */
  signals: readonly FeedbackSignal[]
}

/**
 * Whether two signals name the same failure pattern: the kind, the tool, and
 * the normalized detail. One comparison, so a fold and a corpus merge agree
 * about what counts as the same evidence.
 * @param left - one recorded signal.
 * @param right - the signal to compare it against.
 * @returns whether the two are the same recorded signal.
 */
export function sameSource(left: MinedScenarioSource, right: MinedScenarioSource): boolean {
  return left.kind === right.kind && left.tool === right.tool && left.detail === right.detail
}

/**
 * Name one failure pattern as a candidate corpus scenario: a digest of the
 * pattern's identity, prefixed so a name is recognizable as mined. Lowercase hex
 * and a hyphen are safe as a corpus directory name on every platform.
 * @param source - the signal kind that named the pattern.
 * @param tool - the failing tool, or null when the signal named none.
 * @param detail - the failure text the signal carried.
 * @returns the candidate scenario name.
 */
export function minedScenarioName(source: MinedScenarioSource['kind'], tool: string | null, detail: string): string {
  const identity = `${source}\n${tool ?? ''}\n${normalizeDetail(detail)}`
  return `mined-${createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 12)}`
}

/**
 * Order candidates strongest evidence first: most observations, then most
 * recently seen, then name. One comparator, so the fold, the holdout draw, and
 * the retention cap agree about which candidate matters more.
 * @param rows - candidates in any order.
 * @returns the candidates, strongest first.
 */
export function orderMinedScenarios<T extends { scenario: string; occurrences: number; lastAt: string }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((left, right) =>
    right.occurrences - left.occurrences
    || right.lastAt.localeCompare(left.lastAt)
    || left.scenario.localeCompare(right.scenario))
}

/**
 * Fold the recorded signals into candidate scenarios, merged by failure
 * pattern: the same failure observed in several sessions is one candidate whose
 * evidence lists each signal that named it. Order is strongest evidence
 * first, so a caller that keeps only the head keeps the best-evidenced
 * candidates.
 * @param input - the trace rows and feedback signals to fold.
 * @returns the candidate scenarios, strongest first.
 */
export function mineScenarios(input: MineSignals): MinedScenario[] {
  const merged = new Map<string, MinedScenario>()
  const merge = (source: MinedScenarioSource, occurrences: number, sessions: number, at: string | null): void => {
    const scenario = minedScenarioName(source.kind, source.tool, source.detail)
    const current = merged.get(scenario)
    if (current === undefined) {
      merged.set(scenario, {
        scenario,
        sources: [source],
        occurrences,
        sessions,
        firstAt: at ?? '',
        lastAt: at ?? '',
      })
      return
    }
    if (!current.sources.some(existing => sameSource(existing, source))) {
      current.sources.push(source)
    }
    current.occurrences += occurrences
    current.sessions = Math.max(current.sessions, sessions)
    if (at !== null) {
      current.firstAt = current.firstAt === '' || at < current.firstAt ? at : current.firstAt
      current.lastAt = at > current.lastAt ? at : current.lastAt
    }
  }
  for (const row of input.traces) {
    for (const gist of row.failureGists) {
      merge({ kind: 'trace', tool: null, detail: gist }, 1, 1, row.updatedAt)
    }
  }
  for (const signal of input.signals) {
    merge({ kind: 'feedback', tool: signal.tool, detail: signal.message }, signal.count, signal.sessions, signal.lastAt)
  }
  return orderMinedScenarios([...merged.values()])
}

/**
 * Draw a holdout from the mined corpus: the strongest candidates the skill has
 * not already searched. A scenario the skill's own runs already scored shaped
 * its selection, so offering it as a holdout would be contamination; the draw
 * skips those instead of handing the run a list its contamination check must
 * then refuse.
 * @param corpus - the scope's mined candidates, in any order.
 * @param searched - scenario names the skill's recorded runs already searched.
 * @param count - how many candidates to draw.
 * @returns the drawn scenario names, strongest evidence first; empty when none are eligible.
 */
export function drawHoldout(
  corpus: readonly { scenario: string; occurrences: number; lastAt: string }[],
  searched: ReadonlySet<string>,
  count: number,
): string[] {
  return orderMinedScenarios(corpus)
    .filter(candidate => !searched.has(candidate.scenario))
    .slice(0, Math.max(0, count))
    .map(candidate => candidate.scenario)
}

/**
 * Fold one failure text into the identity two signals merge under: whitespace
 * collapsed and trimmed, so the same failure reported with different spacing is
 * one candidate rather than two.
 * @param detail - the failure text.
 * @returns the normalized identity text.
 */
function normalizeDetail(detail: string): string {
  return detail.replace(/\s+/g, ' ').trim()
}
