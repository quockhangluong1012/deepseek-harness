/**
 * Conflict resolution for one candidate that matched a standing fact, and the
 * record of which rule decided. Confidence alone is not a resolution: a
 * narrower scope, a fresher window, better evidence, more attestations, or a
 * fact whose observed utility contradicts the confidence it claims all outrank
 * it, and an explicit supersession outranks every comparison.
 *
 * The resolver is pure and takes both sides as stored, so the rule it reports
 * can be asserted without a store.
 * @module @deepseek-ai/dsh-evolution-memory/conflict
 */

import { ttlElapsed } from './maintenance.ts'
import type {
  LessonArtifact,
  LessonArtifactInput,
  LessonArtifactScope,
  LessonEvidenceKind,
  LessonMergeStrategy,
} from './lesson-artifact.ts'

/** The rules a conflict may be decided by, strongest first. */
export const CONFLICT_RULES = [
  'explicit-supersession',
  'scope',
  'recency',
  'source-quality',
  'evidence-count',
  'utility',
  'confidence',
] as const

/** One rule a conflict may be decided by. */
export type ConflictRule = (typeof CONFLICT_RULES)[number]

/**
 * Which side of one conflict stands, the rule that decided it, and when. Stored
 * on the fact that survived, so a later reader sees what the standing wording
 * beat or lost to.
 */
export interface LessonConflict {
  rule: ConflictRule
  winner: 'standing' | 'candidate'
  at: string
}

/** How narrow a scope is: a narrower fact overrides a broader one. */
const SCOPE_SPECIFICITY: Record<LessonArtifactScope, number> = {
  user: 3,
  project: 2,
  global: 1,
}

/** How far one evidence kind is trusted on its own. */
const EVIDENCE_QUALITY: Record<LessonEvidenceKind, number> = {
  fact: 1,
  observation: 0.8,
  inference: 0.5,
}

/**
 * Resolve one conflict between a standing fact and a candidate that matched it,
 * reporting the rule that decided. Comparisons run strongest-first: the caller's
 * explicit supersession, then scope, recency, source quality, evidence count, a
 * utility reading that contradicts the confidence the fact claims, and finally
 * confidence itself. A fact that has aged past its ttl has lost its window and
 * loses the conflict; when every comparison ties, the standing fact keeps its
 * place, recorded under `confidence`.
 * @param standing - the fact already stored.
 * @param candidate - the candidate that matched it.
 * @param strategy - the merge policy the caller asked for; `overwrite` is the
 * caller naming the winner.
 * @param now - ISO-8601 instant of the conflict.
 * @returns the resolution to record on the surviving fact.
 */
export function resolveConflict(
  standing: LessonArtifact,
  candidate: LessonArtifactInput,
  strategy: LessonMergeStrategy,
  now: string,
): LessonConflict {
  if (strategy === 'overwrite') return { winner: 'candidate', rule: 'explicit-supersession', at: now }

  const scopeOrder = SCOPE_SPECIFICITY[candidate.scope] - SCOPE_SPECIFICITY[standing.scope]
  if (scopeOrder !== 0) {
    return { winner: scopeOrder > 0 ? 'candidate' : 'standing', rule: 'scope', at: now }
  }

  if (ttlElapsed(standing, Date.parse(now))) return { winner: 'candidate', rule: 'recency', at: now }

  const qualityOrder = EVIDENCE_QUALITY[candidate.evidence] - EVIDENCE_QUALITY[standing.evidence]
  if (qualityOrder !== 0) {
    return { winner: qualityOrder > 0 ? 'candidate' : 'standing', rule: 'source-quality', at: now }
  }

  const standingRefs = (standing.sourceRefs?.length ?? 0) + (standing.trajectoryRefs?.length ?? 0)
    + standing.validationCount
  const candidateRefs = (candidate.sourceRefs?.length ?? 0) + (candidate.trajectoryRefs?.length ?? 0)
  if (standingRefs !== candidateRefs) {
    return { winner: standingRefs > candidateRefs ? 'standing' : 'candidate', rule: 'evidence-count', at: now }
  }

  if (standing.utility !== undefined && standing.utility.value < standing.confidence) {
    return { winner: 'candidate', rule: 'utility', at: now }
  }

  if (candidate.confidence !== standing.confidence) {
    return { winner: candidate.confidence > standing.confidence ? 'candidate' : 'standing', rule: 'confidence', at: now }
  }

  return { winner: 'standing', rule: 'confidence', at: now }
}
