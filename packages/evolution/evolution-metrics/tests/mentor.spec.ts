/**
 * The §13.4 mentor metric set: the six readings over one learner's record and
 * the misconception cycles recorded for them, and the service that reads both
 * stores.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EvidenceId } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CaseReference, CaseImpact, ConceptId, LearnerId } from '@deepseek-ai/dsh-learner-model'
import LearnerModel from '@deepseek-ai/dsh-learner-model'
import type { CaseHistoryEntry, LearnerRecord, Misconception } from '@deepseek-ai/dsh-learner-model'
import type { MisconceptionId, MisconceptionPipeline } from '@deepseek-ai/dsh-misconception'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMetrics from '../src/index.ts'
import { mentorMetrics } from '../src/mentor.ts'
import type { MetricValue } from '../src/index.ts'

const T1 = '2026-01-01T00:00:00.000Z'
const T2 = '2026-01-02T00:00:00.000Z'
const T3 = '2026-01-03T00:00:00.000Z'
const T4 = '2026-01-04T00:00:00.000Z'

/** One learner record carrying only the parts a test states. */
function record(parts: {
  readonly misconceptions?: readonly Misconception[]
  readonly cases?: readonly CaseHistoryEntry[]
} = {}): LearnerRecord {
  return {
    learnerId: LearnerId('learner-1'),
    updatedAt: T4,
    conceptKnowledge: [],
    applicationAbility: [],
    misconceptions: [...(parts.misconceptions ?? [])],
    recurringMistakes: [],
    confidence: [],
    caseHistory: [...(parts.cases ?? [])],
    objectives: [],
  }
}

/** One detected misconception. */
function misconception(id: string, recurrences: number, status: Misconception['status'], cases: readonly string[]): Misconception {
  return {
    misconceptionId: id,
    statement: `the learner believes ${id}`,
    status,
    recurrences,
    detectedAt: T1,
    updatedAt: T2,
    caseIds: cases.map(caseId => CaseReference(caseId)),
    trust: 'trusted',
  }
}

/** One reviewed case entry carrying the given judgements. */
function reviewed(
  caseId: string,
  impacts: readonly CaseImpact[],
  mistakes: readonly string[] = [],
): CaseHistoryEntry {
  return {
    caseId: CaseReference(caseId),
    symbol: 'EURUSD',
    reviewedAt: T1,
    outcome: 'the scenario resolved',
    conceptsTested: [...new Set(impacts.map(impact => impact.conceptId))],
    lessons: [],
    mistakes: [...mistakes],
    impacts: [...impacts],
    trust: 'trusted',
  }
}

/** One per-concept judgement of a case. */
function impact(concept: string, direction: CaseImpact['impact'], at: string): CaseImpact {
  return { conceptId: ConceptId(concept), impact: direction, at, trust: 'trusted' }
}

/** One recorded teach-and-reassess cycle. */
function cycle(id: string, stage: MisconceptionPipeline['stage'], exercise = false): MisconceptionPipeline {
  return {
    misconceptionId: brandString<MisconceptionId>(id),
    learnerId: LearnerId('learner-1'),
    patternId: `pattern-${id}`,
    thesis: 'the learner stated a thesis',
    misconception: `the learner believes ${id}`,
    designError: 'the design assumed one scenario',
    objective: 'read the shift without assuming a scenario',
    stage,
    evidence: [brandString<EvidenceId>('e1')],
    ...(exercise
      ? {
        exercise: {
          exerciseId: `exercise-${id}`,
          misconceptionId: brandString<MisconceptionId>(id),
          objective: 'read the shift without assuming a scenario',
          prompt: 'mark the shift on the replay',
        },
      }
      : {}),
    detectedAt: T1,
    updatedAt: T2,
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

describe('the mentor metrics', () => {
  /** One learner: three reviewed cases, one recurring belief, two recorded cycles. */
  function facts() {
    return {
      learner: record({
        misconceptions: [misconception('m1', 2, 'resolved', ['case-1']), misconception('m2', 1, 'detected', ['case-9'])],
        cases: [
          reviewed('case-1', [impact('x', 'strengthened', T1), impact('y', 'strengthened', T2)], ['mixed up the levels']),
          reviewed('case-2', [impact('x', 'weakened', T3), impact('y', 'unchanged', T3)]),
          reviewed('case-3', [impact('x', 'strengthened', T4)]),
        ],
      }),
      pipelines: [cycle('m1', 'reassess', true), cycle('m2', 'explain')],
    }
  }

  it('measures the six §13.4 readings over one learner', () => {
    const metrics = mentorMetrics(facts())

    expect(metrics).toHaveLength(6)
    // One of the three reviewed cases carries a detection.
    expect(number(metrics, 'misconception-detection')).toBeCloseTo(1 / 3, 12)
    // One of the two cycles moved past the explain stage.
    expect(number(metrics, 'explanation-quality')).toBe(0.5)
    // The one assigned exercise serves a belief that recurred.
    expect(number(metrics, 'exercise-relevance')).toBe(1)
    // Three of the five judgements strengthened a concept.
    expect(number(metrics, 'learning-improvement')).toBe(0.6)
    // One of the two judgements that followed a strengthening held.
    expect(number(metrics, 'retention')).toBe(0.5)
    // The one belief that recurred is resolved.
    expect(number(metrics, 'repeated-mistake-reduction')).toBe(1)
    expect(metrics.every(entry => entry.unit === 'share')).toBe(true)
  })

  it('reads an exercise assigned to a belief the record does not count as recurring as irrelevant', () => {
    const once = {
      learner: record({ misconceptions: [misconception('m2', 1, 'detected', ['case-1'])] }),
      pipelines: [cycle('m2', 'reassess', true)],
    }

    expect(number(mentorMetrics(once), 'exercise-relevance')).toBe(0)
  })

  it('names the store each metric is missing when neither is mounted', () => {
    const metrics = mentorMetrics({ learner: undefined, pipelines: undefined })
    const reason = (id: string): string | null => value(metrics, id).unavailableReason

    expect(metrics).toHaveLength(6)
    expect(metrics.every(entry => entry.value === null)).toBe(true)
    expect(reason('misconception-detection')).toContain('the learner model is not mounted')
    expect(reason('learning-improvement')).toContain('the learner model is not mounted')
    expect(reason('retention')).toContain('the learner model is not mounted')
    expect(reason('repeated-mistake-reduction')).toContain('the learner model is not mounted')
    expect(reason('explanation-quality')).toBe('the misconception engine is not mounted, so no recorded cycle is read')
    expect(reason('exercise-relevance')).toBe('the misconception engine is not mounted, so no recorded cycle is read')
  })

  it('names the learner record when an exercise cannot be judged without it', () => {
    const metrics = mentorMetrics({ learner: undefined, pipelines: [cycle('m1', 'reassess', true)] })

    expect(value(metrics, 'exercise-relevance').value).toBeNull()
    expect(value(metrics, 'exercise-relevance').unavailableReason)
      .toContain('the learner model is not mounted')
    expect(number(metrics, 'explanation-quality')).toBe(1)
  })

  it('names the record each metric is missing in a learner with nothing recorded', () => {
    const metrics = mentorMetrics({ learner: record(), pipelines: [] })
    const reason = (id: string): string | null => value(metrics, id).unavailableReason

    expect(metrics.every(entry => entry.value === null)).toBe(true)
    expect(reason('misconception-detection')).toContain('no reviewed case is recorded')
    expect(reason('explanation-quality')).toContain('no cycle is recorded for the learner')
    expect(reason('exercise-relevance')).toContain('no recorded cycle assigned an exercise')
    expect(reason('learning-improvement')).toContain('no reviewed case judged how the learner moved')
    expect(reason('retention')).toContain('no concept was judged strengthened and then judged again')
    expect(reason('repeated-mistake-reduction')).toContain('no misconception the learner showed more than once')
  })

  it('counts a judgement that weakens a concept as a loss however the later one reads', () => {
    const regained = {
      learner: record({ cases: [reviewed('case-1', [impact('x', 'strengthened', T1), impact('x', 'weakened', T2)])] }),
      pipelines: [],
    }

    expect(number(mentorMetrics(regained), 'retention')).toBe(0)
  })
})

describe('the mentor report service', () => {
  /** Mount the metric layer over a real learner model and a stub cycle store. */
  async function boot(engine = true): Promise<{ ctx: Context; metrics: EvolutionMetrics; learnerId: LearnerId }> {
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(LearnerModel)
    if (engine) ctx.provide('misconception', { pipelines: () => [] } as never)
    const metrics = await ctx.plugin(EvolutionMetrics, {}).then(() => ctx.evolutionMetrics)
    return { ctx, metrics, learnerId: LearnerId('learner-1') }
  }

  it('reads the learner record and the recorded cycles into the report', async () => {
    const { ctx, metrics, learnerId } = await boot()
    await ctx.learnerModel.recordMisconception(learnerId, {
      misconceptionId: 'm1',
      statement: 'the learner believes m1',
      caseId: CaseReference('case-1'),
      trust: 'trusted',
    })
    await ctx.learnerModel.recordMisconception(learnerId, {
      misconceptionId: 'm1',
      statement: 'the learner believes m1',
      caseId: CaseReference('case-1'),
      trust: 'trusted',
    })
    await ctx.learnerModel.setMisconceptionStatus(learnerId, 'm1', 'resolved')
    await ctx.learnerModel.applyCase(learnerId, {
      caseId: CaseReference('case-1'),
      symbol: 'EURUSD',
      outcome: 'the scenario resolved',
      conceptsTested: [ConceptId('x')],
      lessons: [],
      mistakes: ['mixed up the levels'],
      impacts: [{ conceptId: ConceptId('x'), impact: 'strengthened' }],
      trust: 'trusted',
    })

    const report = metrics.mentor({ learnerId })

    expect(report.learnerId).toBe('learner-1')
    expect(number(report.metrics, 'misconception-detection')).toBe(1)
    expect(number(report.metrics, 'learning-improvement')).toBe(1)
    expect(number(report.metrics, 'repeated-mistake-reduction')).toBe(1)
    expect(number(report.metrics, 'explanation-quality')).toBeNull()
  })

  it('leaves the cycle readings unmeasurable when the engine is not mounted', async () => {
    const { metrics, learnerId } = await boot(false)

    const report = metrics.mentor({ learnerId })

    expect(value(report.metrics, 'explanation-quality').unavailableReason)
      .toBe('the misconception engine is not mounted, so no recorded cycle is read')
    expect(value(report.metrics, 'misconception-detection').unavailableReason)
      .toContain('no reviewed case is recorded')
  })
})
