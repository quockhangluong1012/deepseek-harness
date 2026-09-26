/**
 * The read models this layer owns: the §43 uncertainty queue and the §42
 * capability frontier, presented beside the evaluator-health reading already
 * carried in the supporting set. The three owning stores keep their durable
 * domains and their writers, so each report here only reads the store the
 * host already mounted and degrades to naming the missing store when it is
 * not mounted at all.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EvaluationTask } from '@deepseek-ai/dsh-evolution-uncertainty'
import type { FrontierGap, SelfModel as SkillAssessment } from '@deepseek-ai/dsh-evolution-self-model'
import EvolutionMetrics from '../src/index.ts'
import type { MetricValue, SelfModelReport, UncertaintyReport } from '../src/index.ts'

/** Every uncertainty reading, in the order the report fixes. */
const UNCERTAINTY_IDS = ['uncertainty-queue-depth', 'uncertainty-corroboration']

/** Every self-model reading, in the order the report fixes. */
const SELF_MODEL_IDS = ['self-model-frontier-pass-rate', 'self-model-weakest-pass-rate']

/** The gap each report names when its store is not mounted. */
const UNCERTAINTY_GAP = 'the evolution uncertainty store is not mounted'
const SELF_MODEL_GAP = 'the evolution self-model store is not mounted'

/** One queued evaluation task, with the fields a test does not read defaulted. */
function task(overrides: Partial<EvaluationTask> = {}): EvaluationTask {
  return {
    skill: 'writer',
    taskId: 't1',
    kinds: ['disagreement'],
    topScore: 0.5,
    priority: 0.5,
    signals: 1,
    ...overrides,
  }
}

/** One ranked frontier row, with the fields a test does not read defaulted. */
function gap(overrides: Partial<FrontierGap> = {}): FrontierGap {
  return {
    capability: 'refactor',
    score: 0.5,
    confidence: 0.5,
    coveringSkills: ['writer'],
    observations: 2,
    ...overrides,
  }
}

/** Mount the metric layer over the two stores a test provides. */
async function boot(options: {
  queue?: readonly EvaluationTask[]
  gaps?: readonly FrontierGap[]
  skills?: readonly SkillAssessment[]
} = {}) {
  const ctx = new Context()
  if (options.queue !== undefined) {
    ctx.provide('evolutionUncertainty', { queue: () => options.queue } as never)
  }
  if (options.gaps !== undefined || options.skills !== undefined) {
    ctx.provide('evolutionSelfModel', {
      gaps: () => options.gaps ?? [],
      assessments: () => options.skills ?? [],
    } as never)
  }
  const metrics = await ctx.plugin(EvolutionMetrics, {}).then(() => ctx.evolutionMetrics)
  return { ctx, metrics }
}

/** The reading with this id from one report. */
function value(report: UncertaintyReport | SelfModelReport, id: string): MetricValue {
  const found = report.metrics.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no metric '${id}' in the report`)
  return found
}

describe('the read models this layer owns', () => {
  it('presents evaluator health, uncertainty, and self model, and drops none of them', async () => {
    const { metrics } = await boot()

    const owned = [
      ...metrics.report().supporting.map(entry => entry.id),
      ...metrics.uncertainty().metrics.map(entry => entry.id),
      ...metrics.selfModel().metrics.map(entry => entry.id),
    ]

    expect(owned).toContain('evaluator-reliability')
    expect(owned).toEqual(expect.arrayContaining(UNCERTAINTY_IDS))
    expect(owned).toEqual(expect.arrayContaining(SELF_MODEL_IDS))
  })
})

describe('the §43 uncertainty read model', () => {
  it('reports the depth and the corroborated share of the queue the store ranked', async () => {
    const { metrics } = await boot({
      queue: [
        task({ kinds: ['disagreement', 'instability'], topScore: 0.9, priority: 1, signals: 3 }),
        task({ taskId: null, kinds: ['low-confidence'], topScore: 0.4, priority: 0.4 }),
      ],
    })

    const report = metrics.uncertainty()

    expect(report.metrics.map(entry => entry.id)).toEqual(UNCERTAINTY_IDS)
    expect(report.window).toEqual({ skill: null, tasks: 2, signals: 4, topPriority: 1 })
    // One of the two tasks was flagged by more than one of the five kinds.
    expect(value(report, 'uncertainty-corroboration').value).toBe(0.5)
    expect(value(report, 'uncertainty-queue-depth').value).toBe(2)
    expect(value(report, 'uncertainty-queue-depth').caveat).toContain("a task that is still queued is one nobody re-evaluated yet")
  })

  it('narrowes the queue to one skill', async () => {
    const { metrics } = await boot({ queue: [task()] })

    const report = metrics.uncertainty({ skill: 'writer' })

    expect(report.window.skill).toBe('writer')
    expect(report.window.tasks).toBe(1)
  })

  it('measures an empty queue as zero tasks and names the record the share needs', async () => {
    const { metrics } = await boot({ queue: [] })

    const report = metrics.uncertainty()

    expect(report.window).toEqual({ skill: null, tasks: 0, signals: 0, topPriority: null })
    expect(value(report, 'uncertainty-queue-depth').value).toBe(0)
    expect(value(report, 'uncertainty-corroboration').unavailableReason).toContain('no evaluation task is queued')
  })

  it('names the missing store when the uncertainty store is not mounted', async () => {
    const { metrics } = await boot()

    const report = metrics.uncertainty()

    for (const entry of report.metrics) {
      expect(entry.value, entry.id).toBeNull()
      expect(entry.unavailableReason, entry.id).toContain(UNCERTAINTY_GAP)
    }
    expect(value(report, 'uncertainty-queue-depth').inputs).toEqual([
      'ctx.evolutionUncertainty.queue(skill, limit): EvaluationTask.kinds / signals / priority',
    ])
  })
})

describe('the §42 self-model read model', () => {
  it('reports how weak the ranked frontier stands and how weak its head is', async () => {
    const { metrics } = await boot({
      skills: [{ skill: 'writer' } as SkillAssessment],
      gaps: [gap({ capability: 'refactor', score: 0.25 }), gap({ capability: 'lint', score: 0.9 })],
    })

    const report = metrics.selfModel()

    expect(report.metrics.map(entry => entry.id)).toEqual(SELF_MODEL_IDS)
    expect(report.window).toEqual({ skills: 1, capabilities: 2 })
    // The unweighted mean of 0.25 and 0.9, over both ranked capabilities.
    expect(value(report, 'self-model-frontier-pass-rate').value).toBeCloseTo(0.575, 12)
    expect(value(report, 'self-model-weakest-pass-rate').value).toBe(0.25)
    expect(value(report, 'self-model-weakest-pass-rate').caveat).toContain("'refactor'")
  })

  it('names the missing observation when no capability is ranked', async () => {
    const { metrics } = await boot({ gaps: [] })

    const report = metrics.selfModel()

    expect(report.window).toEqual({ skills: 0, capabilities: 0 })
    for (const entry of report.metrics) {
      expect(entry.value, entry.id).toBeNull()
      expect(entry.unavailableReason, entry.id).toContain('no capability entry is recorded')
    }
  })

  it('names the missing store when the self-model store is not mounted', async () => {
    const { metrics } = await boot()

    const report = metrics.selfModel()

    for (const entry of report.metrics) {
      expect(entry.value, entry.id).toBeNull()
      expect(entry.unavailableReason, entry.id).toContain(SELF_MODEL_GAP)
    }
    expect(value(report, 'self-model-frontier-pass-rate').inputs).toEqual([
      'ctx.evolutionSelfModel.gaps(): FrontierGap.score',
    ])
  })
})
