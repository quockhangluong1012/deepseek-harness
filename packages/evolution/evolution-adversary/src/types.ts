/**
 * Public type vocabulary of the adversarial-evolution store: durable
 * adversarial probes across the eight §45 weakness categories, the challenge
 * naming the next category to probe, and the §46 evaluator-gaming defense
 * checklist. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-adversary/src/types
 */

/** The eight §45 adversarial weakness targets, in spec order. */
export type AdversarialCategory =
  | 'edge-case'
  | 'prompt-injection'
  | 'stale-memory'
  | 'retrieval-trap'
  | 'contradictory-evidence'
  | 'tool-failure'
  | 'ambiguous-instruction'
  | 'evaluator-gaming'

/** The six automatable §46 evaluator-gaming defenses, in spec order. */
export type GamingDefense =
  | 'multiple-evaluators'
  | 'hidden-holdout'
  | 'behavioral-metrics'
  | 'adversarial-tests'
  | 'randomized-tests'
  | 'evaluator-rotation'

/** One durable adversarial probe. */
export interface AdversarialProbe {
  /** Probe identity. */
  probeId: string
  /** Skill the probe targets. */
  skill: string
  /** The weakness category the probe exercises. */
  category: AdversarialCategory
  /** The adversarial prompt or scenario. */
  probe: string
  /** Whether the probe exposed a real weakness. */
  foundWeakness: boolean
  /** Whether the exposed weakness has been repaired. */
  repaired: boolean
  /** ISO-8601 instant the probe was recorded. */
  at: string
}

/** One probe offered for recording. */
export interface ProbeInput {
  /** Probe identity. */
  probeId: string
  /** Skill the probe targets. */
  skill: string
  /** The weakness category the probe exercises. */
  category: AdversarialCategory
  /** The adversarial prompt or scenario. */
  probe: string
  /** Whether the probe exposed a real weakness. */
  foundWeakness: boolean
}

/** The next probing challenge of one skill. */
export interface Challenge {
  /** Skill the challenge targets. */
  skill: string
  /** The category to probe next. */
  category: AdversarialCategory
  /** Probes already recorded for the category and skill. */
  probed: number
  /** Why this category is next. */
  reason: string
}

/** The checklist state of one gaming defense. */
export interface DefenseStatus {
  /** The defense. */
  defense: GamingDefense
  /** Whether the defense is currently satisfied. */
  satisfied: boolean
  /** ISO-8601 instant the defense was last set, or null when never set. */
  at: string | null
}
