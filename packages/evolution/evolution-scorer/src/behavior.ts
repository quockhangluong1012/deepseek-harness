/**
 * Behavior evaluation gates for skill candidates: a frontmatter contract
 * check, positive/negative trigger-query routing through the real selector,
 * and a baseline-vs-candidate replay comparison. Pure — the service runs
 * the replay compositions, these functions judge the evidence.
 *
 * Only replay evidence approves: the contract gate refuses bodies that
 * would break the skill, the routing gate refuses candidates that route
 * where they must not (or miss where they must), and the replay gate
 * refuses candidates that regress what the baseline proved. A gate that
 * fails cheaply stops the evaluation before the process-expensive replay.
 * @module @deepseek-ai/dsh-evolution-scorer/src/behavior
 */

import { rankSkills } from '@deepseek-ai/dsh-skill/src/rank.ts'
import { splitFrontmatter, validateSkillHead } from '@deepseek-ai/dsh-evolution-skill-manage/src/index.ts'
import type {
  BehaviorCatalogSkill,
  BehaviorContractGate,
  BehaviorReplayGate,
  BehaviorRoutingGate,
  SkillRankSignal,
  SkillScore,
} from './types.ts'
import type { SkillRankVectors } from './types.ts'

/**
 * Check one candidate body against the commit invariant the skill manager
 * enforces on edit: parseable frontmatter that keeps the skill's own name
 * and a routing description. A body failing it would break the skill and
 * leave no way back.
 * @param name - skill name the body must keep.
 * @param body - replacement body from the verdict.
 * @returns whether the body may be committed, with the refusal reasons.
 */
export function checkBehaviorContract(name: string, body: string): BehaviorContractGate {
  const split = splitFrontmatter(body)
  if (split === undefined) return { ok: false, issues: ['body has no frontmatter'] }
  try {
    validateSkillHead(split.head, name)
    return { ok: true, issues: [] }
  } catch (error) {
    /* v8 ignore next -- validateSkillHead throws Error exclusively; the String arm only guards a future throw shape. */
    return { ok: false, issues: [error instanceof Error ? error.message : String(error)] }
  }
}

/**
 * Run positive and negative trigger queries through the real selector: every
 * positive must rank the candidate inside the window, every negative must
 * keep it outside. The caller supplies the catalog the candidate routes
 * among, so the check proves the candidate wins its own triggers without
 * hijacking unrelated ones. Declared prerequisites ride the same selector:
 * a candidate whose `requires` names a skill outside the catalog scores zero
 * and fails every positive, because routing to it could never work — unless
 * another catalog entry provides that name as a capability, in which case
 * the prerequisite is met and the candidate routes on its own merits. Declared
 * conflicts ride it too: of a conflicting pair the selector keeps only the
 * better ranked, so a candidate that loses to a rival in front of it scores
 * zero and fails every positive.
 * @param candidateName - skill name under test; it must be in the catalog.
 * @param catalog - routing catalog: the candidate among its distractors.
 * @param positiveQueries - trigger queries that must route to the candidate.
 * @param negativeQueries - trigger queries that must not route to the candidate.
 * @param topK - routing window for both query sets; 1 means top rank only.
 * @param vectors - embedding vectors for the selector, if any.
 * @returns per-query verdicts with the catalog revisions they were computed over.
 */
export function checkBehaviorRouting(
  candidateName: string,
  catalog: readonly BehaviorCatalogSkill[],
  positiveQueries: readonly string[],
  negativeQueries: readonly string[],
  topK: number,
  vectors?: SkillRankVectors,
): BehaviorRoutingGate {
  if (!Number.isInteger(topK) || topK < 1) {
    throw new Error(`behavior evaluation routing window must be a positive integer, got ${topK}`)
  }
  if (!catalog.some(entry => entry.name === candidateName)) {
    throw new Error(`behavior evaluation needs the candidate '${candidateName}' in the routing catalog`)
  }
  const signals = new Map<string, SkillRankSignal>()
  const requires = new Map<string, readonly string[]>()
  const capabilities = new Map<string, readonly string[]>()
  const conflicts = new Map<string, readonly string[]>()
  for (const entry of catalog) {
    if (entry.signal !== undefined) signals.set(entry.name, entry.signal)
    if (entry.requires !== undefined) requires.set(entry.name, entry.requires)
    if (entry.capabilities !== undefined) capabilities.set(entry.name, entry.capabilities)
    if (entry.conflictsWith !== undefined) conflicts.set(entry.name, entry.conflictsWith)
  }
  const check = (query: string, expected: 'route' | 'avoid'): BehaviorRoutingGate['checks'][number] => {
    const ordered = rankSkills(query, catalog, entry => entry.name, entry => entry.text, {
      signals,
      vectors,
      requires,
      capabilities,
      conflicts,
    })
    // A candidate the selector scores zero is never picked — an unmet
    // prerequisite or the losing side of a declared conflict — so it ranks
    // after every candidate that still can be.
    const selectable = ordered.filter(entry => entry.score > 0)
    const index = selectable.findIndex(entry => entry.skill.name === candidateName)
    const rank = index === -1 ? selectable.length + 1 : index + 1
    const ok = expected === 'route' ? rank <= topK : rank > topK
    return { query, expected, rank, ok }
  }
  const checks = [
    ...positiveQueries.map(query => check(query, 'route')),
    ...negativeQueries.map(query => check(query, 'avoid')),
  ]
  return {
    ok: checks.every(entry => entry.ok),
    checks,
    revisions: catalog.map(entry => ({ name: entry.name, revisionKey: entry.revisionKey })),
  }
}

/**
 * Compare baseline-vs-candidate replay triples: the candidate must regress
 * nothing the baseline proved. Parity on a scenario both fail is not a
 * regression — the gate judges "no worse", and selection judges "better".
 * @param baseline - triple measured under the baseline revision.
 * @param candidate - triple measured under the candidate revision.
 * @returns the no-regression verdict with the billed-token delta.
 */
export function compareBehaviorReplay(baseline: SkillScore, candidate: SkillScore): BehaviorReplayGate {
  const baselinePassed = new Set(
    baseline.scores.filter(record => record.pass).map(record => record.scenario),
  )
  const regressions = candidate.scores
    .filter(record => !record.pass && baselinePassed.has(record.scenario))
    .map(record => record.scenario)
  return {
    ok: regressions.length === 0,
    baseline,
    candidate,
    regressions,
    tokenDelta: candidate.tokens - baseline.tokens,
  }
}
