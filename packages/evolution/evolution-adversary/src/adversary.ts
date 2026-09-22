/**
 * Pure helpers for adversarial evolution: per-category probe coverage, the
 * next probing challenge, the weakness rate, and the evaluator-gaming
 * defense gaps. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-adversary/src/adversary
 */

import type { AdversarialCategory, AdversarialProbe, Challenge, DefenseStatus, GamingDefense } from './types.ts'

/** The eight §45 weakness categories, in spec order. */
export const ADVERSARIAL_CATEGORIES = [
  'edge-case',
  'prompt-injection',
  'stale-memory',
  'retrieval-trap',
  'contradictory-evidence',
  'tool-failure',
  'ambiguous-instruction',
  'evaluator-gaming',
] as const satisfies readonly AdversarialCategory[]

/** The six automatable §46 gaming defenses, in spec order. */
export const GAMING_DEFENSES = [
  'multiple-evaluators',
  'hidden-holdout',
  'behavioral-metrics',
  'adversarial-tests',
  'randomized-tests',
  'evaluator-rotation',
] as const satisfies readonly GamingDefense[]

/**
 * Probe counts per category for one skill, zero-filled so an unprobed
 * category reads 0 rather than missing. Probes of other skills never count;
 * a probe whose category is not one of the eight canonical names counts
 * under its own key rather than crashing the map.
 * @param probes - the recorded probes.
 * @param skill - the skill to cover.
 * @returns the probe count of every category, in canonical order.
 */
export function categoryCoverage(
  probes: readonly AdversarialProbe[],
  skill: string,
): Record<AdversarialCategory, number> {
  const coverage = new Map<AdversarialCategory, number>(
    ADVERSARIAL_CATEGORIES.map(category => [category, 0]),
  )
  for (const probe of probes) {
    if (probe.skill === skill) {
      coverage.set(probe.category, (coverage.get(probe.category) ?? 0) + 1)
    }
  }
  return Object.fromEntries(coverage) as Record<AdversarialCategory, number>
}

/**
 * The categories of one skill still below the probe minimum, in canonical
 * order. A covered category never appears, so an empty list means the skill
 * has probed every category at least `minProbes` times.
 * @param probes - the recorded probes.
 * @param skill - the skill to inspect.
 * @param minProbes - probes per category that count as covered.
 * @returns the uncovered categories, in canonical order.
 */
export function uncoveredCategories(
  probes: readonly AdversarialProbe[],
  skill: string,
  minProbes: number,
): AdversarialCategory[] {
  const coverage = categoryCoverage(probes, skill)
  return ADVERSARIAL_CATEGORIES.filter(category => coverage[category] < minProbes)
}

/**
 * The next probing challenge of one skill: the first uncovered category in
 * canonical order, or — when every category is covered — the least-probed
 * category so probing rotates instead of stopping. Canonical order breaks
 * least-probed ties, so the rotation is stable.
 * @param probes - the recorded probes.
 * @param skill - the skill to challenge.
 * @param minProbes - probes per category that count as covered.
 * @returns the challenge naming the next category.
 */
export function nextChallenge(
  probes: readonly AdversarialProbe[],
  skill: string,
  minProbes: number,
): Challenge {
  const coverage = categoryCoverage(probes, skill)
  for (const category of ADVERSARIAL_CATEGORIES) {
    const probed = coverage[category]
    if (probed < minProbes) {
      return { skill, category, probed, reason: `${category} has ${probed} probes, below the ${minProbes} minimum` }
    }
  }
  let least = ADVERSARIAL_CATEGORIES[0] as AdversarialCategory
  for (const category of ADVERSARIAL_CATEGORIES) {
    if (coverage[category] < coverage[least]) {
      least = category
    }
  }
  return { skill, category: least, probed: coverage[least], reason: 'all categories covered; rotating the least-probed' }
}

/**
 * The share of one skill's probes that exposed a real weakness, or null when
 * the skill has no probes yet. A high rate marks a skill worth repairing
 * before further optimization; a zero rate marks one that survived probing.
 * @param probes - the recorded probes.
 * @param skill - the skill to rate.
 * @returns the weakness share, or null without probes.
 */
export function weaknessRate(probes: readonly AdversarialProbe[], skill: string): number | null {
  const scoped = probes.filter(probe => probe.skill === skill)
  if (scoped.length === 0) return null
  return scoped.filter(probe => probe.foundWeakness).length / scoped.length
}

/**
 * The defenses still open: every canonical defense whose checklist row is
 * missing or unsatisfied, in canonical order. An empty list means the full
 * §46 checklist currently holds.
 * @param statuses - the checklist statuses.
 * @returns the open defenses, in canonical order.
 */
export function defenseGaps(statuses: readonly DefenseStatus[]): GamingDefense[] {
  const byDefense = new Map(statuses.map(status => [status.defense, status.satisfied]))
  return GAMING_DEFENSES.filter(defense => byDefense.get(defense) !== true)
}
