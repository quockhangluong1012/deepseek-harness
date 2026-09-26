/**
 * The §13.3 research metric set: the ledger fold over one session's kernel
 * records, the seven readings over a window of runs, and the service that
 * reads the run store and the session logs behind them.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EvidenceId, TaskClaimId, TaskClaimStatus } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ResearchAnswer,
  ResearchRunRecord,
  ResearchStage,
  StageRecord,
  StageStatus,
} from '@deepseek-ai/dsh-research-controller'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import EvolutionMetrics from '../src/index.ts'
import { readResearchLedger, researchMetrics, runInstant } from '../src/research.ts'
import type { MetricValue, ResearchWork } from '../src/index.ts'

const TIME = '2026-01-01T00:00:00.000Z'
const LATER = '2026-01-02T00:00:00.000Z'
const seq = (n: number): SessionSeq => SessionSeq(n)
const time = Date.parse(TIME)

/** One `claim/updated` event, carrying the claim's current state. */
function claim(id: string, status: TaskClaimStatus, confidence: number, evidence: readonly string[]): SessionEvent {
  return {
    type: 'claim/updated',
    seq: seq(0),
    time,
    data: {
      claimId: brandString<TaskClaimId>(id),
      statement: `statement of ${id}`,
      evidence: evidence.map(item => brandString<EvidenceId>(item)),
      confidence,
      status,
    },
  }
}

/** One `evidence/recorded` event. */
function observed(id: string, trust: 'trusted' | 'untrusted'): SessionEvent {
  return {
    type: 'evidence/recorded',
    seq: seq(0),
    time,
    data: {
      evidenceId: brandString<EvidenceId>(id),
      kind: 'web',
      contentRef: `https://example.test/${id}`,
      sourceRef: { source: 'web', locator: id },
      trust,
      observedAt: time,
    },
  }
}

/** One stage of a run, settled as stated. */
function stage(name: ResearchStage, claims: readonly string[] = [], status: StageStatus = 'produced'): StageRecord {
  return {
    stage: name,
    status,
    output: status === 'pending' ? [] : ['stated the stage'],
    evidence: [],
    claims: [...claims],
    provider: null,
    startedAt: TIME,
    settledAt: status === 'pending' ? null : TIME,
    failure: null,
  }
}

/** One recorded run whose claim-extraction stage recorded the given claims. */
function run(options: {
  readonly runId: string
  readonly sessionId?: string
  readonly claims?: readonly string[]
  readonly searched?: StageStatus
  readonly answer?: ResearchAnswer | null
  readonly startedAt?: string
  readonly settledAt?: string | null
}): ResearchRunRecord {
  const stages = [stage('claim-extraction', options.claims ?? [])]
  if (options.searched !== undefined) stages.push(stage('contradiction-search', [], options.searched))
  return {
    runId: options.runId,
    sessionId: options.sessionId ?? 's1',
    taskId: `t-${options.runId}`,
    taskClass: 'research',
    question: `question of ${options.runId}`,
    stages,
    answer: options.answer ?? null,
    startedAt: options.startedAt ?? TIME,
    settledAt: options.settledAt === undefined ? null : options.settledAt,
  }
}

/** One answer stating the given buckets, every bucket it does not name empty. */
function answer(buckets: Partial<ResearchAnswer> = {}): ResearchAnswer {
  return {
    documented: [],
    observation: [],
    interpretation: [],
    inference: [],
    hypothesis: [],
    unresolved: [],
    ...buckets,
  }
}

/** One session's work: four claims and two observations behind one settled run. */
function fixture(): ResearchWork {
  return {
    sessionId: 's1',
    runs: [run({
      runId: 'r1',
      claims: ['c1', 'c2', 'c3', 'c4'],
      searched: 'produced',
      settledAt: LATER,
      answer: answer({ documented: [{ statement: 'clause 4 applies', claims: ['c1', 'c4'] }] }),
    })],
    ledger: readResearchLedger([
      observed('e1', 'trusted'),
      observed('e2', 'untrusted'),
      claim('c1', 'supported', 0.9, ['e1']),
      claim('c2', 'contradicted', 0.9, ['e1']),
      claim('c3', 'rejected', 0.2, ['e2']),
      claim('c4', 'proposed', 0.9, []),
    ]),
  }
}

/** The metric with this id from the report. */
function value(metrics: readonly MetricValue[], id: string): MetricValue {
  const found = metrics.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no metric '${id}' in the report`)
  return found
}

/** The measured value of this metric, or null when it is unmeasurable. */
function number(metrics: readonly MetricValue[], id: string): number | null {
  return value(metrics, id).value
}

describe('the research ledger fold', () => {
  it('keeps the newest state of each claim and each observation', () => {
    const ledger = readResearchLedger([
      claim('c1', 'proposed', 0.2, []),
      observed('e1', 'untrusted'),
      { type: 'turn/start', seq: seq(1), time, data: { turn: 1 } },
      claim('c1', 'supported', 0.9, ['e1']),
      observed('e1', 'trusted'),
    ])

    expect([...ledger.claims.keys()]).toEqual(['c1'])
    expect(ledger.claims.get('c1')).toMatchObject({ status: 'supported', confidence: 0.9 })
    expect([...ledger.evidence.keys()]).toEqual(['e1'])
    expect(ledger.evidence.get('e1')?.trust).toBe('trusted')
  })

  it('windows a run by its settled instant, and by its start while it is unsettled', () => {
    expect(runInstant(run({ runId: 'r1', startedAt: TIME, settledAt: LATER }))).toBe(LATER)
    expect(runInstant(run({ runId: 'r2', startedAt: TIME, settledAt: null }))).toBe(TIME)
  })
})

describe('the research metrics', () => {
  it('measures the seven §13.3 readings over one window', () => {
    const metrics = researchMetrics([fixture()], 'unused')

    expect(metrics).toHaveLength(7)
    // One of the three decided claims held up.
    expect(number(metrics, 'claim-accuracy')).toBeCloseTo(1 / 3, 12)
    // Two of the three cited observations are trusted.
    expect(number(metrics, 'source-quality')).toBeCloseTo(2 / 3, 12)
    // The one settled statement rests on a claim that cites an observation.
    expect(number(metrics, 'evidence-coverage')).toBe(1)
    // The only run that asserted a claim ran the contradiction search.
    expect(number(metrics, 'contradiction-recall')).toBe(1)
    // Confidence agreed with the outcome for the supported and rejected claims.
    expect(number(metrics, 'uncertainty-calibration')).toBeCloseTo(2 / 3, 12)
    // One of the two citations names a claim recorded as supported.
    expect(number(metrics, 'citation-correctness')).toBe(0.5)
    // One of the four claims cites no observation.
    expect(number(metrics, 'unsupported-claim-rate')).toBe(0.25)
    expect(metrics.every(entry => entry.unit === 'share')).toBe(true)
  })

  it('reads a contradiction search that did not produce as no recall', () => {
    const work: ResearchWork = {
      sessionId: 's1',
      runs: [run({ runId: 'r1', claims: ['c1'], searched: 'failed', settledAt: LATER })],
      ledger: readResearchLedger([claim('c1', 'supported', 0.9, [])]),
    }

    expect(number(researchMetrics([work], 'unused'), 'contradiction-recall')).toBe(0)
  })

  it('excludes the buckets a hypothesis and an unresolved statement are stated in', () => {
    const work: ResearchWork = {
      sessionId: 's1',
      runs: [run({
        runId: 'r1',
        claims: ['c1'],
        settledAt: LATER,
        answer: answer({
          documented: [{ statement: 'clause 4 applies', claims: ['c1'] }],
          hypothesis: [{ statement: 'clause 5 may apply', claims: ['c1'] }],
          unresolved: [{ statement: 'nothing settles clause 6', claims: [] }],
        }),
      })],
      ledger: readResearchLedger([observed('e1', 'trusted'), claim('c1', 'supported', 0.9, ['e1'])]),
    }

    expect(number(researchMetrics([work], 'unused'), 'evidence-coverage')).toBe(1)
  })

  it('names the record each metric is missing in a window of runs that recorded nothing', () => {
    const work: ResearchWork = { sessionId: 's1', runs: [run({ runId: 'r1' })], ledger: readResearchLedger([]) }
    const metrics = researchMetrics([work], 'unused')
    const reason = (id: string): string | null => value(metrics, id).unavailableReason

    expect(reason('claim-accuracy')).toContain('no claim the window\'s runs recorded reached a decided status')
    expect(reason('uncertainty-calibration')).toContain('no claim the window\'s runs recorded reached a decided status')
    expect(reason('source-quality')).toContain('no observation the window\'s claims cite')
    expect(reason('evidence-coverage')).toContain('no run in the window settled an answer')
    expect(reason('contradiction-recall')).toContain('no run in the window recorded a claim')
    expect(reason('unsupported-claim-rate')).toContain('no run in the window recorded a claim')
    expect(reason('citation-correctness')).toContain('no statement of a settled run cites a claim')
    expect(metrics.every(entry => entry.value === null)).toBe(true)
  })

  it('names the answer bucket a settled run did not fill', () => {
    const work: ResearchWork = {
      sessionId: 's1',
      runs: [run({ runId: 'r1', settledAt: LATER, answer: answer({ unresolved: [{ statement: 'open', claims: [] }] }) })],
      ledger: readResearchLedger([]),
    }

    expect(value(researchMetrics([work], 'unused'), 'evidence-coverage').unavailableReason)
      .toContain('documented, observation, interpretation, or inference bucket')
  })

  it('carries an answer only once its review accepted it', () => {
    const unsettled = researchMetrics([{
      sessionId: 's1',
      runs: [run({ runId: 'r1', claims: ['c1'], answer: answer({ documented: [{ statement: 'stated', claims: ['c1'] }] }) })],
      ledger: readResearchLedger([claim('c1', 'supported', 0.9, [])]),
    }], 'unused')

    expect(number(unsettled, 'evidence-coverage')).toBeNull()
    expect(number(unsettled, 'citation-correctness')).toBeNull()
  })

  it('counts a claim two runs of one session reference once', () => {
    const work: ResearchWork = {
      sessionId: 's1',
      runs: [
        run({ runId: 'r1', claims: ['c1'], settledAt: LATER }),
        run({ runId: 'r2', claims: ['c1'], settledAt: LATER }),
      ],
      ledger: readResearchLedger([claim('c1', 'proposed', 0.9, [])]),
    }
    const metrics = researchMetrics([work], 'unused')

    expect(number(metrics, 'claim-accuracy')).toBeNull()
    expect(number(metrics, 'unsupported-claim-rate')).toBe(1)
  })

  it('reads nothing for a reference the log no longer holds', () => {
    const work: ResearchWork = {
      sessionId: 's1',
      runs: [run({
        runId: 'r1',
        claims: ['c1', 'gone'],
        settledAt: LATER,
        answer: answer({ documented: [{ statement: 'stated', claims: ['gone'] }] }),
      })],
      ledger: readResearchLedger([claim('c1', 'supported', 0.9, ['e-gone'])]),
    }
    const metrics = researchMetrics([work], 'unused')

    // The claim no record holds is not a member of the population, so the one
    // claim left cites something in its own record even though the observation
    // it names is unreadable.
    expect(number(metrics, 'claim-accuracy')).toBe(1)
    expect(number(metrics, 'unsupported-claim-rate')).toBe(0)
    expect(value(metrics, 'source-quality').unavailableReason).toContain('no observation the window\'s claims cite')
    // A citation of a claim the log does not hold is not a correct citation.
    expect(number(metrics, 'citation-correctness')).toBe(0)
  })

  it('reports every metric as unmeasurable when the window is empty', () => {
    const metrics = researchMetrics([], 'the research controller is not mounted')

    expect(metrics).toHaveLength(7)
    for (const entry of metrics) {
      expect(entry.value, entry.id).toBeNull()
      expect(entry.unavailableReason, entry.id).toBe('the research controller is not mounted')
      expect(entry.inputs, entry.id).toEqual(['ctx.research.runs(): ResearchRunRecord.stages / answer / settledAt'])
    }
  })
})

describe('the research report service', () => {
  /** One session's work: a settled run asserting two claims, one of them cited. */
  const RUN = run({
    runId: 'r1',
    claims: ['c1', 'c2'],
    searched: 'produced',
    startedAt: TIME,
    settledAt: LATER,
    answer: answer({ documented: [{ statement: 'clause 4 applies', claims: ['c1'] }] }),
  })
  const LEDGER = [observed('e1', 'trusted'), claim('c1', 'supported', 0.9, ['e1']), claim('c2', 'proposed', 0.9, ['e1'])]

  /** Mount the metric layer over stubs of the run store and the session log. */
  async function boot(options: {
    readonly runs?: readonly ResearchRunRecord[]
    readonly research?: boolean
    readonly persistence?: boolean
  } = {}): Promise<{ metrics: EvolutionMetrics; opened: string[] }> {
    const ctx = new Context()
    const opened: string[] = []
    if (options.research !== false) ctx.provide('research', { runs: () => options.runs ?? [] } as never)
    if (options.persistence !== false) {
      ctx.provide('sessionPersistence', {
        open: async (id: SessionId) => {
          opened.push(String(id))
          return { read: async () => ({ eventState: 'detached', events: LEDGER }), close: async () => {} }
        },
      } as never)
    }
    return { metrics: await ctx.plugin(EvolutionMetrics, {}).then(() => ctx.evolutionMetrics), opened }
  }

  it('reads the window from the run store and folds each run\'s session once', async () => {
    const { metrics, opened } = await boot({ runs: [RUN] })

    const report = await metrics.research()

    expect(report.window).toEqual({ sessions: 1, runs: 1, from: LATER, to: LATER })
    expect(opened).toEqual(['s1'])
    expect(number(report.metrics, 'claim-accuracy')).toBe(1)
    expect(number(report.metrics, 'unsupported-claim-rate')).toBe(0)
    expect(number(report.metrics, 'citation-correctness')).toBe(1)
  })

  it('windows the runs by session, instant, and the newest-first limit', async () => {
    const older = run({ runId: 'r0', sessionId: 's0', claims: ['c0'], startedAt: TIME, settledAt: TIME })
    const newer = run({ runId: 'r2', sessionId: 's2', claims: ['c2'], startedAt: LATER, settledAt: LATER })
    const { metrics, opened } = await boot({ runs: [newer, RUN, older] })

    expect((await metrics.research({ sessionId: SessionId('s2') })).window)
      .toEqual({ sessions: 1, runs: 1, from: LATER, to: LATER })
    expect(opened).toEqual(['s2'])
    expect((await metrics.research({ since: LATER })).window).toEqual({ sessions: 2, runs: 2, from: LATER, to: LATER })
    expect((await metrics.research({ until: TIME })).window).toEqual({ sessions: 1, runs: 1, from: TIME, to: TIME })
    expect((await metrics.research({ limit: 1 })).window).toEqual({ sessions: 1, runs: 1, from: LATER, to: LATER })
  })

  it('reports the whole set as unmeasurable when the research controller is not mounted', async () => {
    const { metrics } = await boot({ research: false })

    const report = await metrics.research()

    expect(report.window).toEqual({ sessions: 0, runs: 0, from: null, to: null })
    for (const entry of report.metrics) {
      expect(entry.value, entry.id).toBeNull()
      expect(entry.unavailableReason, entry.id).toBe('the research controller is not mounted, so no research run is recorded')
    }
  })

  it('names the session log when the runs cannot be resolved through it', async () => {
    const { metrics } = await boot({ runs: [RUN], persistence: false })

    const report = await metrics.research()

    expect(report.window).toEqual({ sessions: 0, runs: 1, from: LATER, to: LATER })
    expect(value(report.metrics, 'claim-accuracy').unavailableReason)
      .toBe('the session persistence store is not mounted, so no claim or observation is read')
  })

  it('names the empty window when the query covers no run', async () => {
    const { metrics } = await boot({ runs: [] })

    expect(value((await metrics.research()).metrics, 'source-quality').unavailableReason)
      .toBe('the query covers 0 recorded research runs')
  })
})
