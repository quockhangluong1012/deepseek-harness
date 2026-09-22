/**
 * Pure helpers for the controlled self-model: assessment merging, the running
 * capability pass rate, and the weakest-first frontier ranking. No I/O, no
 * domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-self-model/src/selfmodel
 */

import type { CapabilityEntry, CapabilityObservation, FrontierGap, SelfModel, SelfModelInput } from './types.ts'

/**
 * Merge one offered assessment over the previous record of the same skill.
 * Every list is replaced wholesale — the input is the skill's current whole
 * self-view, not a patch — while the revision ticks one past the previous
 * record (1 for a skill's first assessment) and the instant stamps the write.
 * @param prev - the previous record, or null for a skill's first assessment.
 * @param input - the offered assessment.
 * @param at - ISO-8601 instant of the write.
 * @returns the merged record.
 */
export function mergeModel(prev: SelfModel | null, input: SelfModelInput, at: string): SelfModel {
  return {
    skill: input.skill,
    strengths: [...input.strengths],
    weaknesses: [...input.weaknesses],
    uncertainAreas: [...input.uncertainAreas],
    failureModes: [...input.failureModes],
    preferredTools: [...input.preferredTools],
    evaluatorBlindspots: [...input.evaluatorBlindspots],
    confidence: input.confidence,
    revision: (prev?.revision ?? 0) + 1,
    at,
  }
}

/**
 * Fold one capability observation into the capability's entry. The score is
 * the running pass rate over every observation so far; confidence grows with
 * the observation count toward 1 at `maxObservations`; a present failure note
 * leads the newest-first failures capped at `maxFailures`; the observing
 * skill joins the covering set in first-seen order.
 * @param prev - the previous entry, or null for a capability's first observation.
 * @param obs - the observation to fold in.
 * @param at - ISO-8601 instant of the observation.
 * @param maxObservations - observations that earn full confidence.
 * @param maxFailures - newest failure notes kept.
 * @returns the updated entry.
 */
export function observeCapability(
  prev: CapabilityEntry | null,
  obs: CapabilityObservation,
  at: string,
  maxObservations = 10,
  maxFailures = 10,
): CapabilityEntry {
  const observations = (prev?.observations ?? 0) + 1
  const passes = (prev?.score ?? 0) * (prev?.observations ?? 0) + (obs.pass ? 1 : 0)
  const coveringSkills = [...(prev?.coveringSkills ?? [])]
  if (!coveringSkills.includes(obs.skill)) {
    coveringSkills.push(obs.skill)
  }
  return {
    capability: obs.capability,
    score: passes / observations,
    confidence: Math.min(1, observations / maxObservations),
    failures:
      obs.failure === undefined
        ? [...(prev?.failures ?? [])]
        : [obs.failure, ...(prev?.failures ?? [])].slice(0, maxFailures),
    coveringSkills,
    observations,
    at,
  }
}

/**
 * Rank capability entries weakest first: lower pass rate before higher, then
 * lower confidence (thinner evidence learns first), then fewer covering
 * skills, then the capability name so ties always render deterministically.
 * @param entries - the capability entries to rank.
 * @returns the frontier gaps, weakest first.
 */
export function frontierGaps(entries: readonly CapabilityEntry[]): FrontierGap[] {
  return entries
    .map(entry => ({
      capability: entry.capability,
      score: entry.score,
      confidence: entry.confidence,
      coveringSkills: [...entry.coveringSkills],
      observations: entry.observations,
    }))
    .sort(
      (left, right) =>
        left.score - right.score ||
        left.confidence - right.confidence ||
        left.coveringSkills.length - right.coveringSkills.length ||
        left.capability.localeCompare(right.capability),
    )
}

/**
 * The capability to learn next: the weakest gap, or null with no entries.
 * @param entries - the capability entries to rank.
 * @returns the weakest gap, or null when empty.
 */
export function nextToLearn(entries: readonly CapabilityEntry[]): FrontierGap | null {
  return frontierGaps(entries)[0] ?? null
}
