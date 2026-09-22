/**
 * The §49 risk model: the class of one proposed change and the step that class
 * licenses. A pure function over a structural input — the artifact the change
 * mutates, how strong the recorded evidence is, whether the change can still be
 * undone, and whether a protected holdout covers the artifact's capability — so
 * §54's Phase 0 contract is a decision a caller reads rather than prose a
 * reader interprets. No I/O, no domain, no context.
 * @module @deepseek-ai/dsh-evolution-canary/src/risk
 */

/**
 * The artifact kinds a governed write accepts, as `evolution-memory`'s staged
 * write boundary defines them: a `skill` body, which a session reads only when
 * it selects that skill, and a `memory` entry, which the scope's later
 * retrieval reads on every session in the scope.
 */
export type RiskArtifact = 'memory' | 'skill'

/** How strong the evidence recorded for one change is. */
export type EvidenceStrength =
  /** Measured, and compared against a recorded baseline. */
  | 'strong'
  /** Measured, but with no recorded baseline to compare against. */
  | 'partial'
  /** Nothing was measured. */
  | 'none'

/** The §49 risk class of one proposed change. */
export type RiskClass = 'low' | 'medium' | 'high' | 'uncertain'

/** The step a risk class licenses (§49). */
export type RiskRoute =
  /** Low risk with strong evidence: the change promotes with no human in the loop. */
  | 'auto-promote'
  /** Medium risk: the change runs on a live fraction and waits for evidence. */
  | 'canary'
  /** High risk: a person approves the step before it happens. */
  | 'human-approval'
  /** The evidence cannot decide the step: a person reviews it. */
  | 'human-review'

/** What a caller knows about one proposed change. */
export interface RiskInput {
  /** The artifact the change mutates. */
  artifact: RiskArtifact
  /** How strong the recorded evidence is. */
  evidence: EvidenceStrength
  /** Whether the change can still leave its rollout, so a wrong bet is undone. */
  reversible: boolean
  /** Whether a protected holdout covers the artifact's capability (§15). */
  holdout: boolean
}

/** One change's risk class and the step that class licenses. */
export interface RiskAssessment {
  /** The §49 risk class. */
  risk: RiskClass
  /** The step this class licenses. */
  route: RiskRoute
}

/**
 * Graduate one change from what the caller recorded. No measurement means no
 * evidence to decide on, so the class is `uncertain` and a person reviews it.
 * A change that cannot be undone is `high` however strong its evidence, and so
 * is any change carrying two of the three aggravations — a memory artifact,
 * partial evidence, or no protected holdout — because those stack: durable
 * scope-wide memory reaches sessions a skill body never does, a measurement
 * with no baseline proves a result without proving an improvement, and §15
 * forbids resting a promotion on the dataset that generated the candidate.
 * One aggravation is `medium` and runs on a live fraction; none is `low` and
 * promotes.
 * @param input - what the caller knows about the change.
 * @returns the risk class and the route it licenses.
 */
export function assessRisk(input: RiskInput): RiskAssessment {
  if (input.evidence === 'none') return { risk: 'uncertain', route: 'human-review' }
  const aggravations = (input.artifact === 'memory' ? 1 : 0)
    + (input.evidence === 'partial' ? 1 : 0)
    + (input.holdout ? 0 : 1)
  if (!input.reversible || aggravations >= 2) return { risk: 'high', route: 'human-approval' }
  if (aggravations === 1) return { risk: 'medium', route: 'canary' }
  return { risk: 'low', route: 'auto-promote' }
}
