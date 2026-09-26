/**
 * The dreaming decision rules: which candidates may reach the durable
 * promotion path, and how a later narrative relates to one the scope already
 * holds. Every rule here is pure — no clock, no store, no model — so a
 * threshold change is a unit test rather than a host fixture.
 * @module @deepseek-ai/dsh-evolution-dreaming/narrative
 */

import { conceptOverlap } from './signals.ts'
import type { DreamSignals } from './signals.ts'
import type {
  DreamCandidate,
  DreamPromotion,
  DreamAttribution,
  DreamRefusalReason,
} from './types.ts'

/**
 * Identity of one narrative: its statement normalized for comparison. Two
 * sightings that normalize alike are one narrative, which is what makes a
 * promotion addressable by identity.
 * @param statement - the statement as observed.
 * @returns the normalized identity.
 */
export function narrativeId(statement: string): string {
  return statement.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Attribution of a candidate two sources contributed sightings to. One sighting
 * the harness observed vouches for the candidate, so `attributed` absorbs: a
 * failure recorded by the feedback seam keeps its attribution when an episodic
 * note restates it.
 * @param left - attribution already held.
 * @param right - attribution arriving.
 * @returns the attribution the candidate carries.
 */
export function mergeAttribution(left: DreamAttribution, right: DreamAttribution): DreamAttribution {
  return left === 'attributed' || right === 'attributed' ? 'attributed' : 'unattributed'
}

/** The evidence the promotion gate judges. */
export interface PromotionGateInput {
  /** Where the candidate's sightings came from. */
  attribution: DreamAttribution
  /** Composite the six signals produced for it. */
  score: number
  /** Sightings it carries. */
  count: number
  /** Distinct sessions that reported it. */
  sessions: number
}

/** Thresholds the gate compares against; a resolved config satisfies it. */
export interface PromotionGate {
  /** Composite a candidate must reach. */
  minScore: number
  /** Sightings a candidate must reach. */
  minRecallCount: number
  /** Distinct sessions a candidate must appear in. */
  minUniqueQueries: number
}

/** Outcome of the promotion gate for one candidate. */
export type PromotionDecision = { promote: true } | { promote: false; reason: DreamRefusalReason }

/**
 * Decide whether one candidate may reach the durable promotion path. The
 * attribution gate runs first, so a candidate the cycle cannot credit to a
 * recorded source is refused by name however high it scores.
 * @param input - the candidate's attribution and scored observations.
 * @param gate - the thresholds to compare against.
 * @returns whether it may promote, or the named gate that refused it.
 */
export function decidePromotion(input: PromotionGateInput, gate: PromotionGate): PromotionDecision {
  if (input.attribution !== 'attributed') return { promote: false, reason: 'unattributed-sighting' }
  if (input.score < gate.minScore) return { promote: false, reason: 'below-score' }
  if (input.count < gate.minRecallCount) return { promote: false, reason: 'below-recall' }
  if (input.sessions < gate.minUniqueQueries) return { promote: false, reason: 'below-diversity' }
  return { promote: true }
}

/** How a later candidate relates to a narrative the scope already holds. */
export type NarrativeRelationKind = 'identical' | 'restates' | 'corrects'

/** The narrative a candidate relates to, and the overlap that decided how. */
export interface NarrativeRelation {
  /** Which rule the overlap landed in. */
  kind: NarrativeRelationKind
  /** Identity of the narrative it relates to. */
  id: string
  /** Shared share of their concepts, `1` for an identity the record already holds. */
  overlap: number
}

/** Overlap thresholds and the fold bound the relation rule reads; a resolved config satisfies it. */
export interface NarrativeLimits {
  /** Overlap at or above which a candidate is a narrative the scope holds, restated. */
  mergeOverlap: number
  /** Lower overlap at or above which a candidate corrects the narrative it shares a tool with. */
  supersedeOverlap: number
  /** Statements one narrative retains as the restatements it absorbed. */
  maxRestatements: number
}

/**
 * Relate one candidate to the narratives the scope holds. Only an active
 * narrative is a match, and only one naming the same tool: two failures of
 * different tools are two subjects however alike their wording. The strongest
 * overlap decides, so a candidate that could fold into one narrative and
 * correct another folds.
 * @param candidate - the candidate to place.
 * @param existing - the scope's promotions before this pass.
 * @param limits - the overlap thresholds.
 * @returns the relation and the narrative it names, or undefined when unrelated.
 */
export function relateNarrative(
  candidate: DreamCandidate,
  existing: readonly DreamPromotion[],
  limits: NarrativeLimits,
): NarrativeRelation | undefined {
  // An identity the record already answers to is no new narrative, whether it
  // is the canonical statement or one that statement absorbed.
  const identical = existing.find(entry => entry.supersededBy === null
    && (entry.id === candidate.id
      || entry.restatements.some(statement => narrativeId(statement) === candidate.id)))
  if (identical !== undefined) return { kind: 'identical', id: identical.id, overlap: 1 }
  let best: NarrativeRelation | undefined
  for (const entry of existing) {
    if (entry.supersededBy !== null || entry.tool !== candidate.tool) continue
    const overlap = conceptOverlap(candidate.statement, entry.statement)
    if (overlap < limits.supersedeOverlap) continue
    const kind: NarrativeRelationKind = overlap >= limits.mergeOverlap ? 'restates' : 'corrects'
    if (best === undefined || overlap > best.overlap) best = { kind, id: entry.id, overlap }
  }
  return best
}

/** One candidate that cleared the gate, with the composite that qualified it. */
export interface QualifiedCandidate {
  /** The staged candidate. */
  candidate: DreamCandidate
  /** Composite the six signals produced for it. */
  score: number
  /** The per-dimension contributions behind that composite. */
  signals: DreamSignals
}

/** What one promotion pass did to the scope's narratives. */
export interface NarrativeOutcome {
  /** The promotions after the pass, newest first. */
  promotions: DreamPromotion[]
  /** Narratives the pass added. */
  promoted: number
  /** Candidates the pass folded into a narrative it already held. */
  merged: number
  /** Narratives the pass retired in favor of a correction. */
  superseded: number
}

/** The durable narrative one qualified candidate becomes. */
function newNarrative(qualified: QualifiedCandidate, now: string): DreamPromotion {
  const { candidate, score, signals } = qualified
  return {
    id: candidate.id,
    statement: candidate.statement,
    tool: candidate.tool,
    score,
    signals,
    promotedAt: now,
    evidence: {
      attribution: candidate.attribution,
      count: candidate.count,
      sessions: candidate.sessions,
    },
    restatements: [],
    supersededBy: null,
    supersededAt: null,
  }
}

/**
 * Apply the gate's survivors to the scope's narratives. A candidate the scope
 * does not hold becomes a new narrative; one that restates a narrative it holds
 * folds into it, which is why the durable record collects no near-duplicates;
 * and one that corrects it retires its predecessor, which then answers nothing
 * while keeping its place in the record.
 *
 * Every candidate is related against the narratives this pass has already
 * written, so two candidates that restate each other fold in one pass however
 * the scope stood before it. A candidate the scope already answers to adds no
 * narrative, but it does move that narrative's promotion instant — the decay
 * rule measures from it — so a recurring narrative stays durable while it is
 * seen.
 * @param held - the scope's promotions before the pass.
 * @param qualified - gate survivors with their scores, in scan order.
 * @param limits - the overlap thresholds and the fold bound.
 * @param now - ISO-8601 instant of the pass.
 * @returns the narratives after the pass and what each rule did.
 */
export function evolveNarratives(
  held: readonly DreamPromotion[],
  qualified: readonly QualifiedCandidate[],
  limits: NarrativeLimits,
  now: string,
): NarrativeOutcome {
  let promotions = [...held]
  let promoted = 0
  let merged = 0
  let superseded = 0
  for (const qualifiedCandidate of qualified) {
    const { candidate } = qualifiedCandidate
    const relation = relateNarrative(candidate, promotions, limits)
    if (relation === undefined) {
      promotions = [newNarrative(qualifiedCandidate, now), ...promotions]
      promoted += 1
      continue
    }
    if (relation.kind === 'identical') {
      // The narrative is still being sighted, so its promotion instant moves:
      // `staleAfterDays` measures from that instant, and a recurring narrative
      // must not be decay-pruned for a sighting that did reach this pass.
      promotions = promotions.map(entry => entry.id === relation.id ? { ...entry, promotedAt: now } : entry)
      continue
    }
    if (relation.kind === 'restates') {
      promotions = promotions.map(entry => entry.id === relation.id
        ? {
          ...entry,
          restatements: [...entry.restatements, candidate.statement].slice(0, limits.maxRestatements),
        }
        : entry)
      merged += 1
      continue
    }
    promotions = [
      newNarrative(qualifiedCandidate, now),
      ...promotions.map(entry => entry.id === relation.id
        ? { ...entry, supersededBy: candidate.id, supersededAt: now }
        : entry),
    ]
    promoted += 1
    superseded += 1
  }
  return { promotions, promoted, merged, superseded }
}
