/**
 * The claim/evidence layer: the pure fold that records assertions onto a
 * scope's claims, the belief it derives, and the mapping from one
 * `evolution-memory` decision batch to the assertions that batch evidences.
 *
 * A claim is not a better edge: an edge counts how often a relation was read
 * from the same text, while a claim carries who attested it. Belief is
 * computed, never stored alone, and it rises only with independent sources —
 * a source re-read ten times is still one source — so repeated observation of
 * one document, session, or model cannot inflate a claim.
 * @module @deepseek-ai/dsh-evolution-graph/claims
 */

import { normalizeStatement } from '@deepseek-ai/dsh-evolution-memory'
import type { LessonArtifact, LessonDecision, LessonEvidenceKind } from '@deepseek-ai/dsh-evolution-memory'
import type {
  Claim,
  ClaimAssertion,
  ClaimEvidence,
  ClaimEvidenceInput,
  ClaimObserveResult,
} from './types.ts'

/**
 * How strongly one kind of lesson artifact attests a claim. A fact was
 * verified, a direct observation was read from the record, and an inference
 * was concluded, so the same source attesting an inference counts for less
 * than the same source attesting a fact.
 */
const EVIDENCE_QUALITY: Record<LessonEvidenceKind, number> = {
  fact: 1,
  observation: 0.8,
  inference: 0.5,
}

/** The six stored fields that make up one claim's belief. */
type Belief = Pick<
  Claim,
  'confidence' | 'evidenceQuality' | 'sourceReliability' | 'independentSupport' | 'contradictionCount' | 'recency'
>

/**
 * Derive one claim's belief from its evidence. Supporting evidence
 * contributes its best quality and its most trusted source, multiplied by a
 * saturating factor of the independent-source count — the first source is
 * worth most and each further one adds less, so no count of sources alone can
 * reach 1 — and every distinct contradicting source divides the result. A
 * contradiction therefore always lowers the belief it lands on, and a claim
 * keeps standing (at a lower belief) until something supersedes it.
 *
 * `recency` is recorded, not weighted: believing a fact less merely because
 * time passed needs a clock this pure fold does not have.
 * @param supportedBy - supporting evidence, one entry per source.
 * @param contradictedBy - contradicting evidence, one entry per source.
 * @param fallbackRecency - instant to report when the claim carries no evidence.
 * @returns the belief fields to store on the claim.
 */
export function deriveBelief(
  supportedBy: readonly ClaimEvidence[],
  contradictedBy: readonly ClaimEvidence[],
  fallbackRecency: string,
): Belief {
  const evidenceQuality = supportedBy.reduce((best, entry) => Math.max(best, entry.quality), 0)
  const sourceReliability = supportedBy.reduce((best, entry) => Math.max(best, entry.reliability), 0)
  const recency = [...supportedBy, ...contradictedBy]
    .reduce((latest, entry) => (entry.lastAt > latest ? entry.lastAt : latest), fallbackRecency)
  return {
    confidence: supportedBy.length / (supportedBy.length + 1)
      * evidenceQuality * sourceReliability / (1 + contradictedBy.length),
    evidenceQuality,
    sourceReliability,
    independentSupport: supportedBy.length,
    contradictionCount: contradictedBy.length,
    recency,
  }
}

/**
 * Merge one side's evidence into what a claim already holds. A source already
 * present keeps the quality and reliability it first attested with and gains
 * only `lastAt` and `count`, so re-reading one source changes no belief
 * input; a source named with a blank identity is dropped rather than counted.
 * @param existing - the claim's evidence on this side.
 * @param inputs - the evidence this batch supplies.
 * @param now - ISO-8601 instant of the batch.
 * @returns the merged evidence, in first-attestation order.
 */
function mergeEvidence(
  existing: readonly ClaimEvidence[],
  inputs: readonly ClaimEvidenceInput[] | undefined,
  now: string,
): ClaimEvidence[] {
  const merged = existing.map(entry => ({ ...entry }))
  for (const input of inputs ?? []) {
    const source = input.source.trim()
    if (source === '') continue
    const found = merged.find(entry => entry.source === source)
    if (found === undefined) {
      merged.push({
        source,
        quality: input.quality ?? 1,
        reliability: input.reliability ?? 1,
        firstAt: now,
        lastAt: now,
        count: 1,
      })
      continue
    }
    found.count += 1
    found.lastAt = now
  }
  return merged
}

/**
 * Union one identity list into another, keeping first-seen order and dropping
 * blanks.
 * @param existing - the claim's list.
 * @param additions - the identities this batch supplies.
 * @returns the merged list.
 */
function mergeIds(existing: readonly string[], additions: readonly string[]): string[] {
  const merged = [...existing]
  for (const id of additions) {
    if (id === '' || merged.includes(id)) continue
    merged.push(id)
  }
  return merged
}

/**
 * Fold one batch of assertions onto a scope's claims: create each claim the
 * scope does not hold yet, merge its evidence and edges into the one it does,
 * and recompute its belief. `supersedes` is applied after the whole batch, so
 * a claim retired by another claim of the same batch is retired whichever
 * order the two arrived in.
 * @param existing - the scope's claims, in insertion order.
 * @param assertions - the batch to record.
 * @param maxClaims - claims retained per scope; further distinct statements are refused.
 * @param now - ISO-8601 instant to stamp.
 * @returns the new claim list and what the batch changed.
 */
export function applyClaimAssertions(
  existing: readonly Claim[],
  assertions: readonly ClaimAssertion[],
  maxClaims: number,
  now: string,
): { claims: Claim[]; result: ClaimObserveResult } {
  const claims: Claim[] = existing.map(entry => ({ ...entry }))
  const result: ClaimObserveResult = { added: 0, updated: 0, retired: 0, skipped: 0 }
  for (const assertion of assertions) {
    const id = normalizeStatement(assertion.statement)
    if (id === '' || (claims.length >= maxClaims && !claims.some(entry => entry.id === id))) {
      result.skipped += 1
      continue
    }
    const found = claims.find(entry => entry.id === id)
    const supportedBy = mergeEvidence(found?.supportedBy ?? [], assertion.supportedBy, now)
    const contradictedBy = mergeEvidence(found?.contradictedBy ?? [], assertion.contradictedBy, now)
    const observedIn = mergeIds(found?.observedIn ?? [], assertion.observedIn ?? [])
    const usedBy = mergeIds(found?.usedBy ?? [], assertion.usedBy ?? [])
    // Lineage names other claims, so it is stored under their identities: a
    // reader compares `supersedes` with `id` and `retiredBy` directly.
    const supersedes = mergeIds(found?.supersedes ?? [], (assertion.supersedes ?? []).map(normalizeStatement))
    const derivedFrom = mergeIds(found?.derivedFrom ?? [], (assertion.derivedFrom ?? []).map(normalizeStatement))
    if (found === undefined) {
      const base: Omit<Claim, keyof Belief> = {
        id,
        statement: assertion.statement.trim(),
        status: 'active',
        retiredBy: null,
        supportedBy,
        contradictedBy,
        observedIn,
        supersedes,
        derivedFrom,
        usedBy,
        createdAt: now,
        updatedAt: now,
      }
      claims.push({ ...base, ...deriveBelief(supportedBy, contradictedBy, now) })
      result.added += 1
      continue
    }
    Object.assign(found, {
      supportedBy,
      contradictedBy,
      observedIn,
      supersedes,
      derivedFrom,
      usedBy,
      updatedAt: now,
      ...deriveBelief(supportedBy, contradictedBy, found.createdAt),
    })
    result.updated += 1
  }
  for (const assertion of assertions) {
    const by = normalizeStatement(assertion.statement)
    for (const statement of assertion.supersedes ?? []) {
      const target = claims.find(entry => entry.id === normalizeStatement(statement))
      if (target === undefined || target.id === by || target.status === 'retired') continue
      target.status = 'retired'
      target.retiredBy = by
      target.updatedAt = now
      result.retired += 1
    }
  }
  return { claims, result }
}

/**
 * Map one `evolution-memory` decision batch to the claims it evidences. Each
 * decision is attributed to the session that reported it, so `confirms`
 * decisions from two sessions are two independent sources while two from one
 * session are one, and a `contradicts` decision that carries a replacement
 * statement becomes a second claim that supersedes the one it corrects.
 *
 * A decision naming an artifact the batch's `artifacts` do not hold is
 * skipped here exactly as the store skipped it, so no claim is invented for
 * an artifact that never landed.
 * @param decisions - the batch, in the order the store applied it.
 * @param artifacts - the scope's artifacts as they read before that write.
 * @param sessionId - session the batch was extracted from.
 * @returns one assertion per claim the batch evidences, in decision order.
 */
export function assertionsFromDecisions(
  decisions: readonly LessonDecision[],
  artifacts: readonly LessonArtifact[],
  sessionId: string,
): ClaimAssertion[] {
  const assertions: ClaimAssertion[] = []
  for (const decision of decisions) {
    if (decision.kind === 'new') {
      assertions.push({
        statement: decision.candidate.statement,
        supportedBy: [{
          source: decision.candidate.source,
          quality: EVIDENCE_QUALITY[decision.candidate.evidence],
          reliability: decision.candidate.confidence,
        }],
        observedIn: [sessionId],
      })
      continue
    }
    const artifact = artifacts.find(entry => entry.id === decision.artifactId)
    if (artifact === undefined) continue
    const evidence: ClaimEvidenceInput = {
      source: sessionId,
      quality: EVIDENCE_QUALITY[artifact.evidence],
      reliability: decision.kind === 'contradicts'
        ? decision.confidence ?? artifact.confidence
        : artifact.confidence,
    }
    assertions.push({
      statement: artifact.statement,
      // A contradiction is evidence against the claim; a confirmation is
      // evidence for it, and neither ever counts as a new row of the other.
      ...(decision.kind === 'contradicts' ? { contradictedBy: [evidence] } : { supportedBy: [evidence] }),
      observedIn: [sessionId],
    })
    if (decision.kind === 'contradicts' && decision.statement !== undefined) {
      // The correction is a claim of its own: the corrected statement stands
      // on the session that corrected it, and retires the statement it
      // replaces instead of editing it, so the replaced claim keeps its
      // evidence and reads as retired rather than as a rewritten fact.
      assertions.push({
        statement: decision.statement,
        supportedBy: [evidence],
        observedIn: [sessionId],
        supersedes: [artifact.statement],
      })
    }
  }
  return assertions
}
