/**
 * §46 evaluator-gaming defense observation: which defenses the recorded stores
 * actually show, derived from evidence that already exists rather than from a
 * hand-set checklist. A defense no store can answer from is reported
 * `unobserved` — not open, which would claim a fact nobody measured. Randomized
 * tests and human spot checks stay operator-side: nothing records them. No I/O,
 * no domain: the caller supplies the recorded facts.
 * @module @deepseek-ai/dsh-evolution-adversary/src/defenses
 */

import { GAMING_DEFENSES, uncoveredCategories } from './adversary.ts'
import type { AdversarialProbe, GamingDefense } from './types.ts'

/** How one defense reads from the recorded state. */
export type DefenseState = 'observed-satisfied' | 'observed-open' | 'unobserved'

/** One defense's observed state with the evidence behind it. */
export interface DefenseObservation {
  /** The defense observed. */
  defense: GamingDefense
  /** What the recorded state shows. */
  state: DefenseState
  /** The numbers behind the state, or why nothing records it. */
  evidence: string
}

/**
 * The recorded facts the defense observer derives from; a null store is one
 * that is not mounted, which reads `unobserved` rather than open.
 */
export interface DefenseFacts {
  /** `evolution-evaluator-strategy` rows, or null when that store is unmounted. */
  strategies: readonly { evaluator: string; taskClass: string; independentSamples: number }[] | null
  /** Capabilities holding a protected `evolution-benchmark` holdout task, or null when unmounted. */
  holdouts: readonly string[] | null
  /** `evolution-router` effectiveness rows for the `evaluation` role, or null when unmounted. */
  evaluationRoutes: readonly { taskClass: string; provider: string; model: string }[] | null
  /** This store's own recorded probes. */
  probes: readonly AdversarialProbe[]
  /** Probes per category before a category counts as covered. */
  minProbesPerCategory: number
}

/**
 * Observe every §46 checklist defense from the recorded state, in canonical
 * order. Each defense reads `observed-satisfied`, `observed-open`, or
 * `unobserved`; nothing is reported as satisfied without a store behind it.
 * @param facts - the recorded facts, per store.
 * @returns one observation per defense, in canonical order.
 */
export function observeDefenses(facts: DefenseFacts): DefenseObservation[] {
  return GAMING_DEFENSES.map(defense => OBSERVERS[defense](facts))
}

/** How one defense reads from the recorded facts. */
type Observer = (facts: DefenseFacts) => DefenseObservation

/** The observer of each defense; the record's key type keeps the set complete. */
const OBSERVERS: Record<GamingDefense, Observer> = {
  'multiple-evaluators': (facts) => {
    const strategies = facts.strategies
    if (strategies === null) {
      return {
        defense: 'multiple-evaluators',
        state: 'unobserved',
        evidence: 'the evaluator-strategy store is not mounted, so no evaluator is recorded',
      }
    }
    const evaluators = new Set(strategies.filter(row => row.independentSamples > 0).map(row => row.evaluator))
    return {
      defense: 'multiple-evaluators',
      state: evaluators.size >= 2 ? 'observed-satisfied' : 'observed-open',
      evidence: `${evaluators.size} evaluator(s) carry an independent verdict`,
    }
  },
  'hidden-holdout': (facts) => {
    const holdouts = facts.holdouts
    if (holdouts === null) {
      return {
        defense: 'hidden-holdout',
        state: 'unobserved',
        evidence: 'the benchmark store is not mounted, so no protected partition is recorded',
      }
    }
    return {
      defense: 'hidden-holdout',
      state: holdouts.length > 0 ? 'observed-satisfied' : 'observed-open',
      evidence: `${holdouts.length} capability(s) hold a protected holdout task`,
    }
  },
  'behavioral-metrics': (facts) => {
    const gaming = facts.probes.filter(probe => probe.category === 'evaluator-gaming').length
    return {
      defense: 'behavioral-metrics',
      state: gaming > 0 ? 'observed-satisfied' : 'observed-open',
      evidence: `${gaming} probe(s) exercised evaluator-gaming behavior`,
    }
  },
  'adversarial-tests': (facts) => {
    const skills = [...new Set(facts.probes.map(probe => probe.skill))]
    const covered = skills.filter(skill => uncoveredCategories(facts.probes, skill, facts.minProbesPerCategory).length === 0)
    return {
      defense: 'adversarial-tests',
      state: covered.length > 0 ? 'observed-satisfied' : 'observed-open',
      evidence: covered.length === 0
        ? `no probe skill covers every §45 category at ${facts.minProbesPerCategory} probe(s) each`
        : `${covered.length} probe skill(s) cover every §45 category`,
    }
  },
  'evaluator-rotation': (facts) => {
    const routes = facts.evaluationRoutes
    if (routes === null) {
      return {
        defense: 'evaluator-rotation',
        state: 'unobserved',
        evidence: 'the router store is not mounted, so no evaluation route is recorded per task class',
      }
    }
    const byClass = new Map<string, Set<string>>()
    for (const row of routes) {
      const key = `${row.provider}\0${row.model}`
      const seen = byClass.get(row.taskClass) ?? new Set<string>()
      seen.add(key)
      byClass.set(row.taskClass, seen)
    }
    const rotated = [...byClass.values()].filter(seen => seen.size >= 2).length
    return {
      defense: 'evaluator-rotation',
      state: rotated > 0 ? 'observed-satisfied' : 'observed-open',
      evidence: `${rotated} task class(es) recorded two or more evaluation routes`,
    }
  },
  'randomized-tests': () => ({
    defense: 'randomized-tests',
    state: 'unobserved',
    evidence: 'nothing records which tests were randomized; randomized tests and human spot checks stay operator-side',
  }),
}
