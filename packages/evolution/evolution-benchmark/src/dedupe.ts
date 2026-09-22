/**
 * Pure deduplication and state-machine rules for the benchmark store. A task's
 * content address is the sha256-hex of its normalized text, so two inputs that
 * differ only in whitespace are the same task; a duplicate is never admitted
 * while it is still learnable (fresh through holdout).
 * @module @deepseek-ai/dsh-evolution-benchmark/src/dedupe
 */

import { createHash } from 'node:crypto'
import type { BenchmarkInput, BenchmarkState } from './types.ts'

/** The states a duplicate input is still blocked by: everything learnable. */
const DUP_BLOCKING: ReadonlySet<BenchmarkState> = new Set(['fresh', 'search', 'validation', 'holdout'])

/**
 * Content-address one task input: sha256-hex of its whitespace-collapsed,
 * trimmed task text.
 * @param input - candidate task.
 * @returns the content address.
 */
export function benchmarkHash(input: Pick<BenchmarkInput, 'task'>): string {
  return createHash('sha256').update(normalize(input.task)).digest('hex')
}

/**
 * Split candidate inputs into new tasks and duplicates against the existing
 * learnable hashes. A candidate whose address already exists in
 * fresh/search/validation/holdout is a duplicate; contaminated and retired
 * tasks do not block re-admission, so a repaired task can re-enter the
 * pipeline.
 * @param candidates - offered inputs, in caller order.
 * @param existingHashes - hashes of the already-learnable tasks.
 * @returns the admitted inputs and the duplicate texts, in input order.
 */
export function dedupe(
  candidates: readonly BenchmarkInput[],
  existingHashes: ReadonlySet<string>,
): { admitted: BenchmarkInput[]; duplicates: string[] } {
  const seen = new Set<string>()
  const admitted: BenchmarkInput[] = []
  const duplicates: string[] = []
  for (const candidate of candidates) {
    const hash = benchmarkHash(candidate)
    if (existingHashes.has(hash) || seen.has(hash)) {
      duplicates.push(candidate.task)
      continue
    }
    seen.add(hash)
    admitted.push(candidate)
  }
  return { admitted, duplicates }
}

/**
 * Whether moving one state to another is a legal transition. Learnability
 * advances fresh → search → validation → holdout; any learnable state may be
 * derailed to contaminated or retired, and terminal states never leave.
 * @param from - current state.
 * @param to - requested state.
 * @returns whether the move is legal.
 */
export function transitionState(from: BenchmarkState, to: BenchmarkState): boolean {
  if (from === to) return true
  if (from === 'contaminated' || from === 'retired') return false
  if (to === 'contaminated' || to === 'retired') return true
  const rank: Record<BenchmarkState, number> = {
    fresh: 0,
    search: 1,
    validation: 2,
    holdout: 3,
    contaminated: 4,
    retired: 4,
  }
  return rank[to] === rank[from] + 1
}

/**
 * The next learnable state one promotion advances a task to, or undefined when
 * the state already advanced or ended.
 * @param state - current state.
 * @returns the next ladder state, or undefined for the last learnable or
 * terminal states.
 */
export function nextLadder(state: BenchmarkState): BenchmarkState | undefined {
  const ladder: Partial<Record<BenchmarkState, BenchmarkState>> = {
    fresh: 'search',
    search: 'validation',
    validation: 'holdout',
  }
  return ladder[state]
}

/** Exposures a task needs before it is reserved as protected holdout. */
export const HOLDOUT_AFTER_RUNS = 3

/** What the engine recorded about one capability's candidate exposure (§15). */
export interface ExposureEvidence {
  /** Candidate evaluations recorded for the capability. */
  runs: number
  /** Recorded evaluations whose candidate passed. */
  passes: number
}

/**
 * The next ladder state one task's recorded exposure earns, or undefined when
 * it has earned none. Each rung asks for its own evidence (§15): a `fresh` task
 * needs one recorded candidate evaluation before it joins the set the search
 * generates against, a `search` task needs one passing candidate so it carries
 * a known baseline and can discriminate rather than only fail, and a
 * `validation` task needs {@link HOLDOUT_AFTER_RUNS} evaluations before it is
 * reserved — at that point the corpus has moved past it, so protecting it costs
 * the search nothing and keeps a promotion from resting on the tasks the
 * candidate was generated against. Exposure counts are capability-scoped
 * because no store binds a candidate evaluation to a benchmark task identity.
 * Terminal states and `holdout` have no rung left and always report undefined.
 * @param state - the task's current state.
 * @param exposure - the exposure recorded for the task's capability.
 * @returns the state to advance to, or undefined when the evidence earns none.
 */
export function ladderAdvance(state: BenchmarkState, exposure: ExposureEvidence): BenchmarkState | undefined {
  const next = nextLadder(state)
  if (next === undefined) return undefined
  const earned = state === 'fresh'
    ? exposure.runs > 0
    : state === 'search'
      ? exposure.passes > 0
      : exposure.runs >= HOLDOUT_AFTER_RUNS
  return earned ? next : undefined
}

/**
 * Block a duplicate while it is learnable.
 * @param state - a task's current state.
 * @returns whether the task still blocks its own re-admission.
 */
export function blocksDuplicate(state: BenchmarkState): boolean {
  return DUP_BLOCKING.has(state)
}

/** Collapse whitespace on one task text so content addressing is stable. */
function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}
