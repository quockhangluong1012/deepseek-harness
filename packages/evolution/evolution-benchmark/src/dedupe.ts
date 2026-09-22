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
