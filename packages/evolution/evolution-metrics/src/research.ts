/**
 * The §13.3 research metric set over the records the research loop already
 * wrote: what one window of recorded runs shows about the claims the runs
 * asserted, the observations those claims cite, and the answer the epistemic
 * review accepted (§13.3 Claim Accuracy, Source Quality, Evidence Coverage,
 * Contradiction Recall, Uncertainty Calibration, Citation Correctness,
 * Unsupported Claim Rate).
 *
 * A run's claims and observations are the agent kernel's own records, logged
 * as `claim/updated` and `evidence/recorded`; the run record holds their
 * identities. One session is folded into a {@link ResearchLedger}, and the
 * window is the {@link ResearchWork} of every session whose runs it covers, so
 * every reference resolves through the log the identity was recorded in.
 *
 * A reading whose records are absent names the record, never zero. Nothing
 * here writes and nothing calls a model.
 * @module @deepseek-ai/dsh-evolution-metrics/src/research
 */

import type { Evidence, TaskClaim, TaskClaimStatus } from '@deepseek-ai/dsh-agent-kernel'
import type { AnswerStatement, ResearchRunRecord } from '@deepseek-ai/dsh-research-controller'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { rate, unavailable } from './metrics.ts'
import type { MetricUnit, MetricValue, ResearchMetricId } from './types.ts'

/** The session log the claim and observation records are folded from. */
const LOG_INPUT = 'ctx.sessionPersistence.list() / open(id, \'read\') / read(0): the session log'

/** The run records that scope the metric set. */
const RUN_INPUT = 'ctx.research.runs(): ResearchRunRecord.stages / answer / settledAt'

/** The claims the runs recorded, as the kernel logged them. */
const CLAIM_INPUT = `${LOG_INPUT} — claim/updated: TaskClaim.status / confidence / evidence`

/** The observations those claims cite. */
const EVIDENCE_INPUT = `${LOG_INPUT} — evidence/recorded: Evidence.trust`

/** The answer statements a settled run stated. */
const ANSWER_INPUT = `${RUN_INPUT} — ResearchRunRecord.answer: AnswerStatement.claims`

/** Why a claim-derived reading has no population. */
const NO_CLAIMS = 'no run in the window recorded a claim: the claim-extraction stage lists the claims a run asserted'

/** Why a decided-claim reading has no population. */
const NO_DECIDED = 'no claim the window\'s runs recorded reached a decided status'
  + ' (`supported`, `contradicted`, or `rejected`)'

/**
 * The statuses evidence has settled a claim into. A `proposed` claim is not
 * yet tested and a `stale` one lost the evidence behind it, so neither is a
 * decision about the statement.
 */
const DECIDED: Readonly<Partial<Record<TaskClaimStatus, true>>> = {
  supported: true,
  contradicted: true,
  rejected: true,
}

/**
 * The answer buckets whose statements this set reads. The review requires a
 * statement outside `unresolved` to rest on a claim, but a `hypothesis` is
 * stated as proposed and an `unresolved` one as open, so only the four
 * established buckets asked for evidence are read.
 */
const ESTABLISHED_BUCKETS = ['documented', 'observation', 'interpretation', 'inference'] as const

/** The confidence at and above which a claim states it expects to hold. */
const CERTAIN = 0.5

/** One session's kernel claim and observation records, the ledger a run resolves through. */
export interface ResearchLedger {
  /** The current state of each claim the log recorded, by identity. */
  readonly claims: ReadonlyMap<string, TaskClaim>
  /** Each observation the log recorded, by identity. */
  readonly evidence: ReadonlyMap<string, Evidence>
}

/** One session's research work: its runs, and the ledger their references resolve through. */
export interface ResearchWork {
  /** The session that recorded the runs and the ledger. */
  readonly sessionId: string
  /** The session's runs, in any order. */
  readonly runs: readonly ResearchRunRecord[]
  /** The session's claim and observation records. */
  readonly ledger: ResearchLedger
}

/**
 * The instant a run is windowed by: the instant the epistemic review accepted
 * its answer, or the instant it started while it is unsettled.
 * @param run - the run to read the instant of.
 * @returns the ISO-8601 instant.
 */
export function runInstant(run: ResearchRunRecord): string {
  return run.settledAt ?? run.startedAt
}

/**
 * Fold one session's committed events into the claim and observation records a
 * run's references resolve through. `claim/updated` carries the current state
 * of one claim, so the newest event for an identity is the state.
 * @param events - the session's committed events, in sequence order.
 * @returns the ledger this log implies.
 */
export function readResearchLedger(events: readonly SessionEvent[]): ResearchLedger {
  const claims = new Map<string, TaskClaim>()
  const evidence = new Map<string, Evidence>()
  for (const event of events) {
    if (event.type === 'claim/updated') claims.set(String(event.data.claimId), event.data)
    else if (event.type === 'evidence/recorded') evidence.set(String(event.data.evidenceId), event.data)
  }
  return { claims, evidence }
}

/** Unit and order of the seven §13.3 metrics. */
const RESEARCH_UNITS: readonly (readonly [ResearchMetricId, MetricUnit])[] = [
  ['claim-accuracy', 'share'],
  ['source-quality', 'share'],
  ['evidence-coverage', 'share'],
  ['contradiction-recall', 'share'],
  ['uncertainty-calibration', 'share'],
  ['citation-correctness', 'share'],
  ['unsupported-claim-rate', 'share'],
]

/**
 * The distinct claims one session's runs recorded, resolved through the
 * session's own ledger. An identity the ledger no longer holds contributes
 * nothing: a claim that is not recorded cannot be read.
 * @param work - the session's runs and ledger.
 * @returns the resolved claims, in the order the runs reference them.
 */
function recordedClaims(work: ResearchWork): readonly TaskClaim[] {
  const claims: TaskClaim[] = []
  const seen = new Set<string>()
  for (const run of work.runs) {
    for (const stage of run.stages) {
      for (const id of stage.claims) {
        const claim = seen.has(id) ? undefined : work.ledger.claims.get(id)
        if (claim === undefined) continue
        seen.add(id)
        claims.push(claim)
      }
    }
  }
  return claims
}

/** The observations the given claims cite, resolved through their session's ledger. */
function citedObservations(work: ResearchWork, claims: readonly TaskClaim[]): readonly Evidence[] {
  const observations: Evidence[] = []
  for (const claim of claims) {
    for (const id of claim.evidence) {
      const observation = work.ledger.evidence.get(id)
      if (observation !== undefined) observations.push(observation)
    }
  }
  return observations
}

/** The statements of one settled run that its review required to rest on a claim. */
function statedStatements(run: ResearchRunRecord): readonly AnswerStatement[] {
  const answer = run.answer
  if (run.settledAt === null || answer === null) return []
  return ESTABLISHED_BUCKETS.flatMap(bucket => [...answer[bucket]])
}

/** Whether a run is one that asserted a claim. */
function assertedArun(run: ResearchRunRecord): boolean {
  return run.stages.some(stage => stage.stage === 'claim-extraction' && stage.claims.length > 0)
}

/**
 * The seven §13.3 research metrics over one window of recorded runs. A metric
 * whose records the window does not hold is returned unmeasurable with the
 * missing record named, so a reader can tell "nothing went wrong" from
 * "nothing observed it".
 * @param work - the window's sessions, each with its runs and its ledger.
 * @param gap - why the window is empty, reported by every metric when it is.
 * @returns the seven readings, in spec order.
 */
export function researchMetrics(work: readonly ResearchWork[], gap: string): readonly MetricValue[] {
  if (work.length === 0) return RESEARCH_UNITS.map(([id, unit]) => unavailable(id, unit, [RUN_INPUT], gap))
  const perSession = work.map((session) => {
    const claims = recordedClaims(session)
    return { claims, observations: citedObservations(session, claims) }
  })
  const asserted = perSession.flatMap(session => session.claims)
  const cited = perSession.flatMap(session => session.observations)
  const runs = work.flatMap(session => session.runs)
  const decided = asserted.filter(claim => DECIDED[claim.status] === true)
  const supported = decided.filter(claim => claim.status === 'supported')
  const trusted = cited.filter(observation => observation.trust === 'trusted')
  const settled = runs.filter(run => run.settledAt !== null && run.answer !== null)
  const statements = runs.flatMap(statedStatements)
  const citations = statements.flatMap(statement => statement.claims)
  const established = new Set(asserted.filter(claim => claim.status === 'supported').map(claim => String(claim.claimId)))
  const grounded = new Set(asserted.filter(claim => claim.evidence.length > 0).map(claim => String(claim.claimId)))
  const covered = statements.filter(statement => statement.claims.some(id => grounded.has(id)))
  const claiming = runs.filter(assertedArun)
  const searched = claiming.filter(run =>
    run.stages.some(stage => stage.stage === 'contradiction-search' && stage.status === 'produced'))

  return [
    rate(
      'claim-accuracy',
      'share',
      supported.length,
      decided.length,
      [CLAIM_INPUT, RUN_INPUT],
      NO_DECIDED,
      '`proposed` and `stale` claims are excluded from the population, and a supported claim is one the run\'s own'
      + ' recorded evidence satisfied, not a fact about the world',
    ),
    rate(
      'source-quality',
      'share',
      trusted.length,
      cited.length,
      [EVIDENCE_INPUT, CLAIM_INPUT],
      'no observation the window\'s claims cite resolved to an `evidence/recorded` record',
      'trust is the label the observer recorded, not a measured quality, and §12.3\'s source classes are not'
      + ' recorded, so a primary source and a blog carrying the same label count alike',
    ),
    rate(
      'evidence-coverage',
      'share',
      covered.length,
      statements.length,
      [ANSWER_INPUT, `${CLAIM_INPUT} / ${EVIDENCE_INPUT}`],
      settled.length === 0
        ? 'no run in the window settled an answer: `ResearchRunRecord.settledAt` is set when the epistemic review accepts one'
        : 'no settled run states a statement in the documented, observation, interpretation, or inference bucket',
      'a statement rests on evidence when one of its claims cites an observation; whether the observation supports the'
      + ' statement is not recorded, and `hypothesis` and `unresolved` statements are excluded because the review'
      + ' lets them rest on no evidence',
    ),
    rate(
      'contradiction-recall',
      'share',
      searched.length,
      claiming.length,
      [RUN_INPUT, CLAIM_INPUT],
      NO_CLAIMS,
      'the record states that the contradiction search ran and settled with output, not how many of the contradictions'
      + ' a body of material holds it found: nothing enumerates them, so a search that found none reads like material'
      + ' that held none',
    ),
    rate(
      'uncertainty-calibration',
      'share',
      decided.filter(claim => (claim.status === 'supported') === (claim.confidence >= CERTAIN)).length,
      decided.length,
      [CLAIM_INPUT, RUN_INPUT],
      NO_DECIDED,
      'agreement is the recorded confidence against the recorded status at the half-confidence split, and a claim whose'
      + ' status is `rejected` states no outcome about the world, so this compares one stated number with one status'
      + ' rather than with a frequency of truth',
    ),
    rate(
      'citation-correctness',
      'share',
      citations.filter(id => established.has(id)).length,
      citations.length,
      [ANSWER_INPUT, CLAIM_INPUT],
      'no statement of a settled run cites a claim',
      'a citation is correct when the claim it names is recorded as `supported`; whether the statement follows from'
      + ' that claim, and whether it is the right claim for the statement, is not recorded',
    ),
    rate(
      'unsupported-claim-rate',
      'share',
      asserted.filter(claim => claim.evidence.length === 0).length,
      asserted.length,
      [CLAIM_INPUT, RUN_INPUT],
      NO_CLAIMS,
      'a claim citing an observation is not thereby true: the kernel\'s evidence list is undirected, so this is a'
      + ' coverage reading of an assertion, not a soundness one',
    ),
  ]
}
