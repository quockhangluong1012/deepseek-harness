/**
 * Pure artifact transforms of the case store: opening an empty artifact and
 * applying one amendment. No I/O and no clock — the caller supplies the
 * instants the entries carry, so every transform stays deterministic.
 * @module @deepseek-ai/dsh-case-store/src/artifact
 */

import type { CaseAmendment, CaseArtifact, CaseOpenInput } from './types.ts'

/**
 * The artifact of a newly opened case: the symbol and timeframes the caller
 * named, every other field empty, and no outcome yet.
 * @param input - the symbol and timeframes the case opens with.
 * @returns the empty artifact.
 */
export function emptyCaseArtifact(input: CaseOpenInput): CaseArtifact {
  return {
    symbol: input.symbol,
    timeframes: input.timeframes,
    observations: [],
    userThesis: [],
    evidence: [],
    agentAudit: [],
    devilAdvocate: [],
    alternativeScenarios: [],
    outcome: null,
    mistakes: [],
    lessons: [],
    conceptsTested: [],
    learnerImpact: [],
  }
}

/** Append one id-keyed list, replacing an entry that carries the same identity in place. */
function appendById<T>(
  current: readonly T[],
  added: readonly T[] | undefined,
  idOf: (value: T) => string,
): readonly T[] {
  if (added === undefined) return current
  const next = [...current]
  for (const entry of added) {
    const index = next.findIndex(value => idOf(value) === idOf(entry))
    if (index < 0) next.push(entry)
    else next[index] = entry
  }
  return next
}

/**
 * Apply one amendment to an artifact. Each named field appends its entries by
 * identity, and the concepts tested are unioned; a field the amendment omits
 * keeps the recorded value.
 * @param artifact - the artifact at its write-chain slot.
 * @param amendment - the entries to apply.
 * @returns the amended artifact.
 */
export function amendCaseArtifact(artifact: CaseArtifact, amendment: CaseAmendment): CaseArtifact {
  return {
    ...artifact,
    observations: appendById(artifact.observations, amendment.observations, value => value.observationId),
    userThesis: appendById(artifact.userThesis, amendment.userThesis, value => value.thesisId),
    evidence: appendById(artifact.evidence, amendment.evidence, value => value.evidenceKey),
    agentAudit: appendById(artifact.agentAudit, amendment.agentAudit, value => value.interpretationId),
    devilAdvocate: appendById(artifact.devilAdvocate, amendment.devilAdvocate, value => value.interpretationId),
    alternativeScenarios: appendById(
      artifact.alternativeScenarios,
      amendment.alternativeScenarios,
      value => value.interpretationId,
    ),
    outcome: amendment.outcome ?? artifact.outcome,
    mistakes: appendById(artifact.mistakes, amendment.mistakes, value => value.findingId),
    lessons: appendById(artifact.lessons, amendment.lessons, value => value.findingId),
    conceptsTested: amendment.conceptsTested === undefined
      ? artifact.conceptsTested
      : [...new Set([...artifact.conceptsTested, ...amendment.conceptsTested])],
    learnerImpact: appendById(artifact.learnerImpact, amendment.learnerImpact, value => value.impactId),
  }
}
