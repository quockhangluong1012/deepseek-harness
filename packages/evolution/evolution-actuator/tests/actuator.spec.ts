import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import EvolutionAdversary from '@deepseek-ai/dsh-evolution-adversary'
import EvolutionBenchmark, { benchmarkHash, MINED_TASK } from '@deepseek-ai/dsh-evolution-benchmark'
import EvolutionBudget from '@deepseek-ai/dsh-evolution-budget'
import EvolutionCanary from '@deepseek-ai/dsh-evolution-canary'
import EvolutionCurriculum from '@deepseek-ai/dsh-evolution-curriculum'
import EvolutionHeartbeat from '@deepseek-ai/dsh-evolution-heartbeat'
import EvolutionIslands from '@deepseek-ai/dsh-evolution-islands'
import EvolutionOperators, { MUTATION_OPERATORS } from '@deepseek-ai/dsh-evolution-operators'
import EvolutionPopulation from '@deepseek-ai/dsh-evolution-population'
import EvolutionStagnation from '@deepseek-ai/dsh-evolution-stagnation'
import EvolutionUncertainty from '@deepseek-ai/dsh-evolution-uncertainty'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as actuator from '../src/index.ts'
import {
  AUTOMATION_LOOPS,
  LOOP_TASK_NAMES,
  benchmarkInput,
  debtInputs,
  debtProbe,
  exposureOf,
  failureInputs,
  governingAllocation,
  migrationTarget,
  probeTask,
  recoveryStep,
  resolveConfig,
  rolloutDecision,
  rolloutRisk,
  routeAllows,
  signalProbe,
} from '../src/index.ts'
import type { BenchmarkInput, ExposureEvidence } from '@deepseek-ai/dsh-evolution-benchmark'
import type { BudgetAllocation } from '@deepseek-ai/dsh-evolution-budget'
import type { DeploymentRecord, RiskRoute } from '@deepseek-ai/dsh-evolution-canary'
import type { RegressionDebt } from '@deepseek-ai/dsh-evolution-curator'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import type { Island } from '@deepseek-ai/dsh-evolution-islands'
import type { PopulationCandidate } from '@deepseek-ai/dsh-evolution-population'
import type { EvaluationTask, UncertaintyKind, UncertaintySignal } from '@deepseek-ai/dsh-evolution-uncertainty'

const T0 = Date.parse('2026-06-01T00:00:00.000Z')
const AT = '2026-06-01T00:00:00.000Z'

afterEach(() => {
  vi.useRealTimers()
})

/** The stores `boot` can mount, by name. */
type StoreName =
  | 'canary'
  | 'benchmark'
  | 'budget'
  | 'adversary'
  | 'islands'
  | 'operators'
  | 'population'
  | 'stagnation'
  | 'curriculum'
  | 'uncertainty'

/** One store's mount, keyed by the name a caller selects it by. */
const STORES: Record<StoreName, (ctx: Context) => Fiber & PromiseLike<Fiber>> = {
  canary: ctx => ctx.plugin(EvolutionCanary),
  benchmark: ctx => ctx.plugin(EvolutionBenchmark),
  budget: ctx => ctx.plugin(EvolutionBudget, {}),
  adversary: ctx => ctx.plugin(EvolutionAdversary, {}),
  islands: ctx => ctx.plugin(EvolutionIslands, { migrationCadence: 1000 }),
  operators: ctx => ctx.plugin(EvolutionOperators, {}),
  population: ctx => ctx.plugin(EvolutionPopulation),
  stagnation: ctx => ctx.plugin(EvolutionStagnation, { threshold: 1, relativeImprovement: 0.05 }),
  curriculum: ctx => ctx.plugin(EvolutionCurriculum),
  uncertainty: ctx => ctx.plugin(EvolutionUncertainty, {}),
}

/**
 * Mount the heartbeat, the named stores, and the actuator itself over an
 * in-memory storage backend. The island cadence and the stagnation threshold are
 * small so one pass reaches the branch under test.
 * @param config - actuator configuration.
 * @param options - `stores: false` mounts nothing but the heartbeat; an array
 * mounts exactly those stores, so a partial host reaches a loop's missing-store
 * branch.
 * @returns the host and the actuator's fiber.
 */
async function boot(
  config: Record<string, unknown> = {},
  options: { stores?: boolean | readonly StoreName[] } = {},
) {
  vi.useFakeTimers({ now: T0 })
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(EvolutionHeartbeat)
  if (options.stores !== false) {
    const names = options.stores === undefined || typeof options.stores === 'boolean'
      ? Object.keys(STORES) as StoreName[]
      : options.stores
    for (const name of names) await STORES[name](ctx)
  }
  const fiber = await ctx.plugin(actuator, config)
  return { ctx, fiber }
}

const deployment = (id: string, triple: DeploymentRecord['triple']): DeploymentRecord => ({
  id,
  skill: 'writer',
  state: 'canary',
  triple,
  at: AT,
  enteredAt: AT,
  decidedAt: null,
})

const lane = (islandId: string, objective: Island['objective'], at = AT): Island => ({
  islandId,
  name: islandId,
  objective,
  skill: 'writer',
  generation: 0,
  lastActivityAt: null,
  at,
})

const signal = (overrides: Partial<UncertaintySignal>): UncertaintySignal => ({
  signalId: 's1',
  skill: 'writer',
  taskId: null,
  kind: 'disagreement',
  score: 0.5,
  detail: 'note',
  at: AT,
  ...overrides,
})

const queued = (overrides: Partial<EvaluationTask> = {}): EvaluationTask => ({
  skill: 'writer',
  taskId: null,
  kinds: ['disagreement'],
  topScore: 0.5,
  priority: 0.5,
  signals: 1,
  ...overrides,
})

/** The measured triple shared by most fixtures. */
const passing = { pass: true, tokens: 10, wallTimeMs: 5 }

const graded = (overrides: Partial<FeedbackSignal> = {}): FeedbackSignal => ({
  tool: 'bash',
  message: 'command not found',
  count: 3,
  firstAt: AT,
  lastAt: AT,
  sessions: 2,
  actionability: 'trigger_review',
  evidenceStatus: 'complete',
  mergeKey: 'bash\u0000command not found',
  ...overrides,
})

const owed = (overrides: Partial<RegressionDebt> = {}): RegressionDebt => ({
  name: 'writer',
  mergeKey: 'bash\u0000stuck',
  message: 'stuck',
  firstSeenAt: AT,
  lastSeenAt: AT,
  passes: 2,
  sessions: 3,
  revision: 0,
  ...overrides,
})

const candidate = (overrides: Partial<PopulationCandidate> = {}): PopulationCandidate => ({
  candidateId: 'cand-1',
  skill: 'writer',
  parentCandidateId: null,
  operator: 'rewrite',
  generation: 1,
  novelty: 0.4,
  triple: passing,
  status: 'approved',
  at: AT,
  ...overrides,
})

describe('evolution actuator', () => {
  it('resolves loop defaults and refuses a loop it does not drive', () => {
    expect(resolveConfig({})).toEqual({
      loops: [...AUTOMATION_LOOPS],
      rolloutIntervalHours: 6,
      rolloutCostFactor: 1.5,
      migrationIntervalHours: 24,
      recoveryIntervalHours: 24,
      drainIntervalHours: 12,
      admissionIntervalHours: 24,
      growthIntervalHours: 24,
      adversaryIntervalHours: 24,
      maxPerPass: 5,
    })
    expect(resolveConfig({ loops: ['drain'], maxPerPass: 2 })).toMatchObject({ loops: ['drain'], maxPerPass: 2 })
    expect(() => resolveConfig({ loops: ['bogus' as never] })).toThrow("unknown automation loop 'bogus'")
  })

  it('registers one heartbeat task per configured loop', async () => {
    const all = await boot()
    try {
      expect(actuator.name).toBe('evolution-actuator')
      expect(all.ctx.evolutionHeartbeat.state().map(task => task.name)).toEqual(
        AUTOMATION_LOOPS.map(loop => LOOP_TASK_NAMES[loop]),
      )
    } finally {
      await all.fiber.dispose()
    }
    const narrowed = await boot({ loops: ['drain'] })
    try {
      expect(narrowed.ctx.evolutionHeartbeat.state().map(task => task.name)).toEqual([LOOP_TASK_NAMES.drain])
    } finally {
      await narrowed.fiber.dispose()
    }
  })

  it('records a pass for every loop whose stores are not mounted', async () => {
    const { ctx, fiber } = await boot({}, { stores: false })
    try {
      for (const loop of AUTOMATION_LOOPS) {
        const report = await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES[loop])
        expect(report).toMatchObject({ name: LOOP_TASK_NAMES[loop], outcome: 'ran' })
      }
    } finally {
      await fiber.dispose()
    }
  })

  it('decides a rollout from the candidate triple against the incumbent', () => {
    const incumbent = { ...deployment('incumbent', passing), state: 'promoted' as const }
    expect(rolloutDecision(deployment('unmeasured', null), undefined, 1.5)).toBe('hold')
    expect(rolloutDecision(deployment('failed', { pass: false, tokens: 1, wallTimeMs: 1 }), undefined, 1.5))
      .toBe('rollback')
    expect(rolloutDecision(deployment('first', passing), undefined, 1.5)).toBe('promote')
    expect(rolloutDecision(deployment('cheaper', { pass: true, tokens: 5, wallTimeMs: 5 }), incumbent, 1.5))
      .toBe('promote')
    expect(rolloutDecision(deployment('costly', { pass: true, tokens: 16, wallTimeMs: 5 }), incumbent, 1.5))
      .toBe('rollback')
    expect(rolloutDecision(deployment('slow', { pass: true, tokens: 10, wallTimeMs: 8 }), incumbent, 1.5))
      .toBe('rollback')
  })

  it('rotates a due lane to the next objective in canonical order', () => {
    const lanes = [lane('b', 'novelty'), lane('a', 'conservative'), lane('c', 'adversarial')]
    expect(migrationTarget('a', lanes)?.islandId).toBe('b')
    expect(migrationTarget('b', lanes)?.islandId).toBe('c')
    expect(migrationTarget('c', lanes)?.islandId).toBe('a')
    expect(migrationTarget('a', [lane('a', 'conservative')])).toBeUndefined()
    expect(migrationTarget('missing', lanes)).toBeUndefined()
    // Two lanes sharing an objective order by island id, so the rotation is
    // deterministic however the caller listed them.
    const tied = [lane('z', 'novelty'), lane('y', 'novelty')]
    expect(migrationTarget('y', tied)?.islandId).toBe('z')
    expect(migrationTarget('z', tied)?.islandId).toBe('y')
  })

  it('maps a ladder rung to the step an existing store accepts', () => {
    expect(recoveryStep('diversity')).toBe('diversify')
    expect(recoveryStep('newOperators')).toBe('operators')
    expect(recoveryStep('newTasks')).toBe('propose')
    for (const rung of ['exploitation', 'newEvaluators', 'newModel'] as const) {
      expect(recoveryStep(rung)).toBe('unactionable')
    }
  })

  it('grounds each recorded uncertainty kind in the weakness family it exercises', () => {
    const family = (kind: UncertaintyKind): string => signalProbe(signal({ kind, detail: 'note' })).probe.category
    expect(family('disagreement')).toBe('evaluator-gaming')
    expect(family('low-confidence')).toBe('ambiguous-instruction')
    expect(family('instability')).toBe('edge-case')
    expect(family('retrieval-ambiguity')).toBe('retrieval-trap')
    expect(family('conflicting-evidence')).toBe('contradictory-evidence')
  })

  it('builds a probe from the recorded text alone, with a stable identity', () => {
    const first = signalProbe(signal({ kind: 'retrieval-ambiguity', detail: 'two chunks scored alike' }))
    expect(first.probe.probeId).toMatch(/^adversarial-[0-9a-f]{32}$/)
    expect(first.probe).toMatchObject({
      probe: "Probe writer for the recorded retrieval-trap weakness: 'two chunks scored alike'.",
      skill: 'writer',
      category: 'retrieval-trap',
      foundWeakness: false,
    })
    expect(first.evidence).toBe('two chunks scored alike')

    // The identity is a content address, so the same recorded weakness is one
    // probe however often a pass reaches it.
    expect(signalProbe(signal({ kind: 'retrieval-ambiguity', detail: 'two chunks scored alike' })).probe.probeId)
      .toBe(first.probe.probeId)
    expect(signalProbe(signal({ kind: 'retrieval-ambiguity', detail: 'another note' })).probe.probeId)
      .not.toBe(first.probe.probeId)

    // A regression debt is a failing tool call, and its message is verbatim.
    const debt = debtProbe(owed())
    expect(debt.probe).toMatchObject({ skill: 'writer', category: 'tool-failure', foundWeakness: false })
    expect(debt.probe.probe).toBe("Probe writer for the recorded tool-failure weakness: 'stuck'.")
    expect(debt.evidence).toBe('stuck')
  })

  it('admits a generated probe as the evaluation task with the probe text', () => {
    expect(probeTask(signalProbe(signal({ kind: 'instability', detail: 'flaky on empty input' })))).toEqual({
      capability: 'writer',
      task: "Probe writer for the recorded edge-case weakness: 'flaky on empty input'.",
      gists: ['flaky on empty input'],
      sourceSessions: [],
      profile: null,
      family: 'loop-recovery',
      stepSpan: null,
      acceptance: null,
    })
  })

  it('reads the newest recorded allocation of a task class, and none for an unpriced class', () => {
    const allocation = (batchId: string, at: string): BudgetAllocation => ({
      batchId,
      taskClass: 'writer',
      candidateClass: 'standard',
      maxTokens: 100,
      maxWallTimeMs: 100,
      reason: 'priced',
      at,
    })
    expect(governingAllocation([])).toBeUndefined()
    expect(governingAllocation([allocation('b1', AT), allocation('b2', '2026-07-01T00:00:00.000Z')])?.batchId).toBe('b2')
    // Same instant, so the batch identity decides and the answer stays total.
    expect(governingAllocation([allocation('b1', AT), allocation('b2', AT)])?.batchId).toBe('b2')
  })

  it('turns a queued uncertainty into a benchmark task from its strongest note', () => {
    expect(benchmarkInput(queued(), [
      signal({ signalId: 's1', score: 0.3, detail: 'weak note' }),
      signal({ signalId: 's2', score: 0.9, detail: 'strong note' }),
      signal({ signalId: 's3', score: 0.9, detail: 'strong note' }),
    ])).toEqual({
      capability: 'writer',
      task: 'strong note',
      gists: ['strong note', 'weak note'],
      sourceSessions: [],
      profile: null,
      family: 'loop-recovery',
      stepSpan: null,
      acceptance: null,
    })
    expect(() => benchmarkInput(queued(), [])).toThrow("evaluation task 'writer' has no signal")
  })

  it('turns only decisive graded failures into benchmark tasks', () => {
    expect(failureInputs([
      graded(),
      graded({ tool: 'read', message: 'missing file', actionability: 'ranking_only', mergeKey: 'read\u0000missing file' }),
      graded({ tool: null, message: 'no tool', actionability: 'observe_only', mergeKey: '\u0000no tool' }),
    ])).toEqual([{
      capability: 'bash',
      task: "Recover from the recurring failure: 'command not found' — bash was in play.",
      gists: ['command not found'],
      sourceSessions: [],
      profile: null,
      family: 'loop-recovery',
      stepSpan: null,
      acceptance: null,
    }])
    // The task text carries no observation count, so one more sighting of the
    // same failure content-addresses to the task already admitted for it.
    const once = failureInputs([graded()])
    const twice = failureInputs([graded({ count: 99 })])
    expect(benchmarkHash(twice[0] as BenchmarkInput)).toBe(benchmarkHash(once[0] as BenchmarkInput))
  })

  it('turns open regression debt into benchmark tasks', () => {
    expect(debtInputs([owed()])).toEqual([{
      capability: 'writer',
      task: "Recover from the recurring failure: 'stuck' — writer was in play.",
      gists: ['stuck'],
      sourceSessions: [],
      profile: null,
      family: 'loop-recovery',
      stepSpan: null,
      acceptance: null,
    }])
    expect(debtInputs([])).toEqual([])
  })

  it('counts only measured candidates as exposure', () => {
    const exposure = (candidates: readonly PopulationCandidate[]): ExposureEvidence => exposureOf(candidates)
    expect(exposure([])).toEqual({ runs: 0, passes: 0 })
    expect(exposure([candidate({ triple: null })])).toEqual({ runs: 0, passes: 0 })
    expect(exposure([
      candidate({ candidateId: 'c1' }),
      candidate({ candidateId: 'c2', triple: { pass: false, tokens: 4, wallTimeMs: 2 } }),
      candidate({ candidateId: 'c3', triple: null }),
    ])).toEqual({ runs: 2, passes: 1 })
  })

  it('grades a live rollout from its measurement and its holdout coverage', () => {
    expect(rolloutRisk(deployment('unmeasured', null), true))
      .toEqual({ artifact: 'skill', evidence: 'none', reversible: true, holdout: true })
    // The same measured patch grades differently on whether §15 protects its
    // capability, which is what turns the monitor's promotion into a route.
    expect(rolloutRisk(deployment('measured', passing), true).evidence).toBe('strong')
    expect(rolloutRisk(deployment('measured', passing), false)).toEqual({
      artifact: 'skill',
      evidence: 'strong',
      reversible: true,
      holdout: false,
    })
  })

  it('licenses a promotion through the auto-promote route only', () => {
    expect(routeAllows('promote', 'auto-promote')).toBe(true)
    for (const route of ['canary', 'human-approval', 'human-review'] as const) {
      expect(routeAllows('promote', route)).toBe(false)
    }
    // Rolling back restores the incumbent, so no route guards it.
    for (const route of ['auto-promote', 'canary', 'human-approval', 'human-review'] as RiskRoute[]) {
      expect(routeAllows('rollback', route)).toBe(true)
    }
  })

  it('promotes a passing rollout and ends a failing or costlier one', async () => {
    const { ctx, fiber } = await boot()
    try {
      // §15: a protected holdout covering the capability is what makes the
      // measured patch low-risk, so the monitor may promote it.
      await ctx.evolutionBenchmark.admit([{
        capability: 'writer',
        task: 'protect me',
        gists: [],
        sourceSessions: [],
        ...MINED_TASK,
      }])
      const protectedTask = ctx.evolutionBenchmark.tasks('fresh')[0]
      if (protectedTask === undefined) throw new Error('fixture requires an admitted task')
      for (const state of ['search', 'validation', 'holdout'] as const) {
        await ctx.evolutionBenchmark.transition(protectedTask.id, state)
      }
      for (const [id, triple] of [
        ['passing', passing],
        ['failing', { pass: false, tokens: 10, wallTimeMs: 5 }],
      ] as const) {
        await ctx.evolutionCanary.enter({ id, skill: 'writer', triple })
        await ctx.evolutionCanary.advance(id, 'canary')
      }
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.rollout)
      expect(ctx.evolutionCanary.deployments('promoted').map(record => record.id)).toEqual(['passing'])
      expect(ctx.evolutionCanary.deployments('rolled-back').map(record => record.id)).toEqual(['failing'])

      // A later patch that passes but costs more than the promoted incumbent leaves the ladder.
      await ctx.evolutionCanary.enter({ id: 'costly', skill: 'writer', triple: { pass: true, tokens: 16, wallTimeMs: 5 } })
      await ctx.evolutionCanary.advance('costly', 'canary')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.rollout)
      expect(ctx.evolutionCanary.deployments('rolled-back').map(record => record.id).sort())
        .toEqual(['costly', 'failing'])
    } finally {
      await fiber.dispose()
    }
  })

  it('leaves a promotable rollout live when §15 protects no holdout for it', async () => {
    const { ctx, fiber } = await boot()
    try {
      await ctx.evolutionCanary.enter({ id: 'passing', skill: 'writer', triple: passing })
      await ctx.evolutionCanary.advance('passing', 'canary')
      // No holdout covers 'writer', so the route is `canary` and the promotion
      // waits for the operator step that route names.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.rollout)
      expect(ctx.evolutionCanary.deployments('promoted')).toEqual([])
      expect(ctx.evolutionCanary.deployments('canary').map(record => record.id)).toEqual(['passing'])

      // A regression still leaves the ladder: rolling back is not guarded.
      await ctx.evolutionCanary.enter({ id: 'failing', skill: 'writer', triple: { pass: false, tokens: 1, wallTimeMs: 1 } })
      await ctx.evolutionCanary.advance('failing', 'canary')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.rollout)
      expect(ctx.evolutionCanary.deployments('rolled-back').map(record => record.id)).toEqual(['failing'])
    } finally {
      await fiber.dispose()
    }
  })

  it('migrates the elite off every lane the schedule flags as due, once per cadence', async () => {
    const { ctx, fiber } = await boot()
    try {
      for (const [islandId, objective] of [
        ['writer-conservative', 'conservative'],
        ['writer-novelty', 'novelty'],
      ] as const) {
        await ctx.evolutionIslands.register({ islandId, name: islandId, objective, skill: 'writer' })
      }
      await ctx.evolutionPopulation.record({
        skill: 'writer',
        candidateId: 'cand-1',
        operator: 'rewrite',
        novelty: 0.4,
        triple: passing,
        status: 'approved',
      })
      vi.setSystemTime(T0 + 2000)
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.migration)
      const recorded = ctx.evolutionIslands.migrations('writer')
      expect(recorded.map(migration => `${migration.fromIslandId}→${migration.toIslandId}`).sort()).toEqual([
        'writer-conservative→writer-novelty',
        'writer-novelty→writer-conservative',
      ])
      expect(recorded.every(migration => migration.candidateId === 'cand-1' && migration.reason === 'schedule'))
        .toBe(true)

      // The recorded migration resets the due flag, so the same instant migrates nothing twice.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.migration)
      expect(ctx.evolutionIslands.migrations('writer')).toHaveLength(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('moves a stagnant skill elite into its novelty lane', async () => {
    const { ctx, fiber } = await boot()
    try {
      await ctx.evolutionIslands.register({
        islandId: 'writer-novelty',
        name: 'writer-novelty',
        objective: 'novelty',
        skill: 'writer',
      })
      vi.setSystemTime(T0 + 1000)
      await ctx.evolutionIslands.register({
        islandId: 'writer-conservative',
        name: 'writer-conservative',
        objective: 'conservative',
        skill: 'writer',
      })
      await ctx.evolutionPopulation.record({
        skill: 'writer',
        candidateId: 'cand-1',
        operator: 'rewrite',
        novelty: 0.4,
        triple: passing,
        status: 'approved',
      })
      for (const runId of ['r1', 'r2']) {
        await ctx.evolutionStagnation.recordRun({
          runId,
          skill: 'writer',
          score: { pass: true, tokens: 100, wallTimeMs: 10 },
        })
      }
      expect(ctx.evolutionStagnation.status('writer').strategy).toBe('diversity')

      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(ctx.evolutionIslands.migrations('writer')).toMatchObject([{
        reason: 'diversity',
        fromIslandId: 'writer-conservative',
        toIslandId: 'writer-novelty',
        candidateId: 'cand-1',
      }])
    } finally {
      await fiber.dispose()
    }
  })

  it('stages the tasks a stagnant skill gaps derive, once', async () => {
    const { ctx, fiber } = await boot()
    try {
      ctx.provide('evolutionSkillTelemetry', { entries: () => [{ name: 'writer', usage: { sessionIds: ['s1'] } }] })
      ctx.provide('evolutionTrace', { summary: async () => [{ failureGists: ['g1', 'g2'] }] })
      for (const runId of ['r1', 'r2', 'r3', 'r4']) {
        await ctx.evolutionStagnation.recordRun({
          runId,
          skill: 'writer',
          score: { pass: true, tokens: 100, wallTimeMs: 10 },
        })
      }
      expect(ctx.evolutionStagnation.status('writer').strategy).toBe('newTasks')

      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(ctx.evolutionCurriculum.proposals()).toMatchObject([{
        capability: 'writer',
        gists: ['g1', 'g2'],
        state: 'open',
      }])

      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(ctx.evolutionCurriculum.proposals()).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('admits the queued uncertainty as a benchmark task and drains its signals', async () => {
    const { ctx, fiber } = await boot()
    try {
      await ctx.evolutionUncertainty.record({
        signalId: 's1',
        skill: 'writer',
        taskId: null,
        kind: 'disagreement',
        score: 0.8,
        detail: 'evaluators disagreed on writer',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.drain)
      expect(ctx.evolutionBenchmark.tasks()).toMatchObject([{
        capability: 'writer',
        task: 'evaluators disagreed on writer',
        gists: ['evaluators disagreed on writer'],
        state: 'fresh',
      }])
      expect(ctx.evolutionUncertainty.queue()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('admits open curriculum proposals as benchmark tasks once', async () => {
    const { ctx, fiber } = await boot()
    try {
      await ctx.evolutionCurriculum.propose([{
        capability: 'writer',
        sourceSessions: ['s1'],
        failureGists: ['g1', 'g2'],
      }])
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.admission)
      expect(ctx.evolutionBenchmark.tasks().map(task => task.capability)).toEqual(['writer'])

      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.admission)
      expect(ctx.evolutionBenchmark.tasks()).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('admits a repeated decisive failure once and a different one beside it', async () => {
    const { ctx, fiber } = await boot()
    try {
      ctx.provide('evolutionSkillTelemetry', { entries: () => [{ name: 'writer', usage: { sessionIds: ['s1', 's2'] } }] })
      // Only one failure is `trigger_review`; the other only ranks, so it must
      // not become a task however often the store reports it.
      const signals = [
        graded(),
        graded({ tool: 'read', message: 'missing file', actionability: 'ranking_only', mergeKey: 'read\u0000missing file' }),
      ]
      ctx.provide('evolutionFeedback', { signals: () => signals })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(ctx.evolutionBenchmark.tasks()).toMatchObject([{
        capability: 'bash',
        task: "Recover from the recurring failure: 'command not found' — bash was in play.",
        gists: ['command not found'],
        sourceSessions: [],
        state: 'fresh',
      }])

      // The store keeps grading the same failure `trigger_review` on the next
      // pass; content addressing, not the store's memory, blocks the second copy.
      signals[0] = graded({ count: 99, sessions: 3 })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(ctx.evolutionBenchmark.tasks()).toHaveLength(1)

      // The same failure promoted to `trigger_review` is admitted beside it.
      signals[1] = graded({
        tool: 'read',
        message: 'missing file',
        mergeKey: 'read\u0000missing file',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(ctx.evolutionBenchmark.tasks().map(task => task.capability).sort()).toEqual(['bash', 'read'])
    } finally {
      await fiber.dispose()
    }
  })

  it('admits the regression debt the curator still owes', async () => {
    const { ctx, fiber } = await boot()
    try {
      ctx.provide('evolutionCurator', { debt: () => [owed()] })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(ctx.evolutionBenchmark.tasks()).toMatchObject([{
        capability: 'writer',
        task: "Recover from the recurring failure: 'stuck' — writer was in play.",
        state: 'fresh',
      }])
    } finally {
      await fiber.dispose()
    }
  })

  it('walks a task down the ladder on the exposure recorded for its capability', async () => {
    const { ctx, fiber } = await boot()
    try {
      const { admitted } = await ctx.evolutionBenchmark.admit([{
        capability: 'writer',
        task: 'recover from the recurring failure',
        gists: ['g1'],
        sourceSessions: [],
        ...MINED_TASK,
      }])
      expect(admitted).toHaveLength(1)
      const states = (): string[] => ctx.evolutionBenchmark.tasks().map(task => task.state)
      // Nothing recorded yet: the ladder stays where the admission left it.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(states()).toEqual(['fresh'])

      // One recorded candidate evaluation joins the search set.
      await ctx.evolutionPopulation.record({
        skill: 'writer',
        candidateId: 'cand-1',
        operator: 'rewrite',
        novelty: 0.4,
        triple: passing,
        status: 'approved',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(states()).toEqual(['search'])

      // One passing candidate carries a baseline, so the task validates.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(states()).toEqual(['validation'])

      // Holdout needs the corpus to have moved past the task: three evaluations.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(states()).toEqual(['validation'])
      for (const candidateId of ['cand-2', 'cand-3']) {
        await ctx.evolutionPopulation.record({
          skill: 'writer',
          candidateId,
          operator: 'rewrite',
          novelty: 0.4,
          triple: passing,
          status: 'approved',
        })
      }
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(states()).toEqual(['holdout'])

      // The protected state is the end of the partition, so later passes stop.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(states()).toEqual(['holdout'])
    } finally {
      await fiber.dispose()
    }
  })

  it('leaves a promotable rollout live when no store records its holdout coverage', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['canary'] })
    try {
      await ctx.evolutionCanary.enter({ id: 'passing', skill: 'writer', triple: passing })
      await ctx.evolutionCanary.advance('passing', 'canary')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.rollout)
      // Without the benchmark store nothing records a holdout, so the route is
      // `canary` and the promotion waits; a regression still leaves the ladder.
      expect(ctx.evolutionCanary.deployments('promoted')).toEqual([])
      await ctx.evolutionCanary.enter({ id: 'failing', skill: 'writer', triple: { pass: false, tokens: 1, wallTimeMs: 1 } })
      await ctx.evolutionCanary.advance('failing', 'canary')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.rollout)
      expect(ctx.evolutionCanary.deployments('rolled-back').map(record => record.id)).toEqual(['failing'])
    } finally {
      await fiber.dispose()
    }
  })

  it('migrates nothing without a target lane or an elite to move', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['islands', 'population'] })
    try {
      await ctx.evolutionIslands.register({
        islandId: 'writer-only',
        name: 'writer-only',
        objective: 'conservative',
        skill: 'writer',
      })
      vi.setSystemTime(T0 + 2000)
      // One lane: the rotation has nowhere to go.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.migration)
      expect(ctx.evolutionIslands.migrations('writer')).toEqual([])

      // Two lanes but no recorded candidate: there is nothing to migrate.
      await ctx.evolutionIslands.register({
        islandId: 'writer-second',
        name: 'writer-second',
        objective: 'novelty',
        skill: 'writer',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.migration)
      expect(ctx.evolutionIslands.migrations('writer')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('mirrors a stagnant skill into the novelty lane it has, and stops when it cannot', async () => {
    const { ctx, fiber } = await boot({}, {
      stores: ['stagnation', 'islands', 'population'],
    })
    try {
      await ctx.evolutionIslands.register({
        islandId: 'writer-novelty',
        name: 'writer-novelty',
        objective: 'novelty',
        skill: 'writer',
      })
      for (const runId of ['r1', 'r2']) {
        await ctx.evolutionStagnation.recordRun({
          runId,
          skill: 'writer',
          score: { pass: true, tokens: 100, wallTimeMs: 10 },
        })
      }
      expect(ctx.evolutionStagnation.status('writer').strategy).toBe('diversity')
      // The head lane is already the novelty lane, so there is nowhere to move.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(ctx.evolutionIslands.migrations('writer')).toEqual([])

      // A conservative lane becomes the head, but no candidate is recorded yet.
      vi.setSystemTime(T0 + 1000)
      await ctx.evolutionIslands.register({
        islandId: 'writer-conservative',
        name: 'writer-conservative',
        objective: 'conservative',
        skill: 'writer',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(ctx.evolutionIslands.migrations('writer')).toEqual([])

      // With an elite recorded the diversity escape lands.
      await ctx.evolutionPopulation.record({
        skill: 'writer',
        candidateId: 'cand-1',
        operator: 'rewrite',
        novelty: 0.4,
        triple: passing,
        status: 'approved',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(ctx.evolutionIslands.migrations('writer')).toMatchObject([{ reason: 'diversity' }])
    } finally {
      await fiber.dispose()
    }
  })

  it('reports a rung as unactionable without the store it would write to', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['stagnation'] })
    try {
      const runs = (runId: string): Promise<unknown> => ctx.evolutionStagnation.recordRun({
        runId,
        skill: 'writer',
        score: { pass: true, tokens: 100, wallTimeMs: 10 },
      })
      // One run has not stalled anything, so the recovery loop does nothing.
      await runs('r1')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(ctx.evolutionStagnation.status('writer').stagnant).toBe(false)

      // The diversity rung asks for a migration no lane store could record.
      await runs('r2')
      expect(ctx.evolutionStagnation.status('writer').strategy).toBe('diversity')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)

      // The newTasks rung asks for a curriculum proposal no such store accepts.
      await runs('r3')
      await runs('r4')
      expect(ctx.evolutionStagnation.status('writer').strategy).toBe('newTasks')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      // Neither rung wrote anything, and the recorded runs still stand.
      expect(ctx.evolutionStagnation.runs().map(run => run.skill)).toEqual(Array(4).fill('writer'))
    } finally {
      await fiber.dispose()
    }
  })

  it('admits nothing when no curriculum proposal is open', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['benchmark', 'curriculum'] })
    try {
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.admission)
      expect(ctx.evolutionBenchmark.tasks()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('leaves the ladder alone without the store that records exposure', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['benchmark'] })
    try {
      await ctx.evolutionBenchmark.admit([{
        capability: 'writer',
        task: 'recover from the recurring failure',
        gists: ['g1'],
        sourceSessions: [],
        ...MINED_TASK,
      }])
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.growth)
      expect(ctx.evolutionBenchmark.tasks().map(task => task.state)).toEqual(['fresh'])
    } finally {
      await fiber.dispose()
    }
  })

  it('reports the mutation instruction the operators store recommends for a stagnant skill', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['stagnation', 'operators'] })
    try {
      const messages: string[] = []
      ctx.logger.exporter({
        levels: { default: 9 },
        export: (message) => {
          messages.push(message.args.join(' '))
        },
      })
      for (const runId of ['r1', 'r2', 'r3']) {
        await ctx.evolutionStagnation.recordRun({
          runId,
          skill: 'writer',
          score: { pass: true, tokens: 100, wallTimeMs: 10 },
        })
      }
      expect(ctx.evolutionStagnation.status('writer').strategy).toBe('newOperators')

      // No proposal recorded yet: the rung has a readable store and nothing to
      // report, so it says which of the two it is rather than acting.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(messages.join('\n')).toContain(
        "recovery left rung 'newOperators' for 'writer' unactionable: evolution-operators holds no instruction for class 'writer'",
      )

      // Every canonical operator holds a proposal, so whichever the ranking
      // leads with, the recommendation exists.
      for (const operator of MUTATION_OPERATORS) {
        await ctx.evolutionOperators.recordInstruction({
          operator,
          artifactClass: 'writer',
          instruction: `try ${operator} on the writer`,
          reason: 'the writer stalled on its last three runs',
        })
      }
      const expected = ctx.evolutionOperators.recommendedInstruction('writer')
      expect(expected).toBeDefined()
      messages.length = 0
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(messages.join('\n')).toContain(
        `recovery takes 'writer' to the recommended '${expected?.operator}' instruction: '${expected?.instruction}'`,
      )
      // The rung reads: the portfolio the optimizer owns is exactly as it was.
      expect(ctx.evolutionOperators.instructions('writer'))
        .toHaveLength(MUTATION_OPERATORS.length)
    } finally {
      await fiber.dispose()
    }
  })

  it('reports the operators rung unactionable where its store is not mounted', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['stagnation'] })
    try {
      const messages: string[] = []
      ctx.logger.exporter({
        levels: { default: 9 },
        export: (message) => {
          messages.push(message.args.join(' '))
        },
      })
      for (const runId of ['r1', 'r2', 'r3']) {
        await ctx.evolutionStagnation.recordRun({
          runId,
          skill: 'writer',
          score: { pass: true, tokens: 100, wallTimeMs: 10 },
        })
      }
      expect(ctx.evolutionStagnation.status('writer').strategy).toBe('newOperators')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.recovery)
      expect(messages.join('\n')).toContain(
        "recovery left rung 'newOperators' for 'writer' unactionable: the evolution-operators store is not mounted",
      )
    } finally {
      await fiber.dispose()
    }
  })

  it('drains a named evaluation task from the signals that name it', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['benchmark', 'uncertainty'] })
    try {
      await ctx.evolutionUncertainty.record({
        signalId: 's1',
        skill: 'writer',
        taskId: 't1',
        kind: 'low-confidence',
        score: 0.4,
        detail: 'the writer answer was uncertain on t1',
      })
      await ctx.evolutionUncertainty.record({
        signalId: 's2',
        skill: 'writer',
        taskId: null,
        kind: 'disagreement',
        score: 0.9,
        detail: 'evaluators disagreed on writer',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.drain)
      expect(ctx.evolutionBenchmark.tasks().map(task => task.task).sort()).toEqual([
        'evaluators disagreed on writer',
        'the writer answer was uncertain on t1',
      ])
      expect(ctx.evolutionUncertainty.queue()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('generates one probe and one adversarial example per recorded weakness, twice over', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['adversary', 'benchmark', 'uncertainty'] })
    try {
      // The capability is already benchmark-shaped: a task the store holds
      // names it, which is what §14's evaluation set is made of.
      await ctx.evolutionBenchmark.admit([{
        capability: 'writer',
        task: 'an existing task for the capability',
        gists: [],
        sourceSessions: [],
        ...MINED_TASK,
      }])
      await ctx.evolutionUncertainty.record({
        signalId: 's1',
        skill: 'writer',
        taskId: null,
        kind: 'retrieval-ambiguity',
        score: 0.8,
        detail: 'two chunks scored alike for writer',
      })

      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.adversary)
      expect(ctx.evolutionAdversary.probes()).toMatchObject([{
        skill: 'writer',
        category: 'retrieval-trap',
        probe: "Probe writer for the recorded retrieval-trap weakness: 'two chunks scored alike for writer'.",
        foundWeakness: false,
        repaired: false,
      }])
      expect(ctx.evolutionBenchmark.tasks().map(task => task.task).sort()).toEqual([
        "Probe writer for the recorded retrieval-trap weakness: 'two chunks scored alike for writer'.",
        'an existing task for the capability',
      ])

      // The signal stays recorded, so the next pass re-derives the same probe
      // and the same task; neither becomes a second copy.
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.adversary)
      expect(ctx.evolutionAdversary.probes()).toHaveLength(1)
      expect(ctx.evolutionBenchmark.tasks()).toHaveLength(2)

      // A repaired probe is not re-opened by the pass that keeps seeing it.
      await ctx.evolutionAdversary.setRepaired(ctx.evolutionAdversary.probes()[0]?.probeId ?? '')
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.adversary)
      expect(ctx.evolutionAdversary.probes().map(probe => probe.repaired)).toEqual([true])
    } finally {
      await fiber.dispose()
    }
  })

  it('grounds a probe in an open regression debt and admits it as a benchmark task', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['adversary', 'benchmark'] })
    try {
      await ctx.evolutionBenchmark.admit([{
        capability: 'writer',
        task: 'an existing task for the capability',
        gists: [],
        sourceSessions: [],
        ...MINED_TASK,
      }])
      ctx.provide('evolutionCurator', { debt: () => [owed()] })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.adversary)
      expect(ctx.evolutionAdversary.probes()).toMatchObject([{
        skill: 'writer',
        category: 'tool-failure',
        probe: "Probe writer for the recorded tool-failure weakness: 'stuck'.",
      }])
      expect(ctx.evolutionBenchmark.tasks().map(task => task.task)).toContain(
        "Probe writer for the recorded tool-failure weakness: 'stuck'.",
      )
    } finally {
      await fiber.dispose()
    }
  })

  it('records a probe but admits no task for a capability the benchmark store never held', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['adversary', 'benchmark', 'uncertainty'] })
    try {
      await ctx.evolutionUncertainty.record({
        signalId: 's1',
        skill: 'unseen',
        taskId: null,
        kind: 'instability',
        score: 0.7,
        detail: 'flaky on empty input',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.adversary)
      expect(ctx.evolutionAdversary.probes().map(probe => probe.skill)).toEqual(['unseen'])
      // A first-time failure in a brand-new capability has no evaluation set to
      // join, so the probe stands as the recorded challenge and no task appears.
      expect(ctx.evolutionBenchmark.tasks()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('generates nothing without the evidence it grounds probes in', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['adversary'] })
    try {
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.adversary)
      expect(ctx.evolutionAdversary.probes()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('records the probe where no benchmark store accepts the example', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['adversary', 'uncertainty'] })
    try {
      await ctx.evolutionUncertainty.record({
        signalId: 's1',
        skill: 'writer',
        taskId: null,
        kind: 'conflicting-evidence',
        score: 0.6,
        detail: 'two sources disagreed about writer',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.adversary)
      expect(ctx.evolutionAdversary.probes()).toMatchObject([{ category: 'contradictory-evidence' }])
    } finally {
      await fiber.dispose()
    }
  })

  it('stops a loop whose task class spent its allocation, and settles the ones that ran', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['benchmark', 'uncertainty', 'budget'] })
    try {
      const warnings: string[] = []
      ctx.logger.exporter({
        levels: { default: 9 },
        export: (message) => {
          warnings.push(message.args.join(' '))
        },
      })
      await ctx.evolutionBudget.allocate({ batchId: 'spent', taskClass: 'writer', candidateClass: 'low-potential' })
      await ctx.evolutionBudget.spend('spent', { tokens: 999_999, wallTimeMs: 999_999, rollouts: 1 })
      await ctx.evolutionBudget.allocate({ batchId: 'open', taskClass: 'reader', candidateClass: 'standard' })
      await ctx.evolutionUncertainty.record({
        signalId: 's1',
        skill: 'writer',
        taskId: null,
        kind: 'low-confidence',
        score: 0.9,
        detail: 'uncertain about writer',
      })
      await ctx.evolutionUncertainty.record({
        signalId: 's2',
        skill: 'reader',
        taskId: null,
        kind: 'low-confidence',
        score: 0.5,
        detail: 'uncertain about reader',
      })

      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.drain)

      // The spent class is untouched — its signal stays queued and no task
      // appeared — while the class with room drains as usual.
      expect(ctx.evolutionBenchmark.tasks().map(task => task.capability)).toEqual(['reader'])
      expect(ctx.evolutionUncertainty.queue().map(task => task.skill)).toEqual(['writer'])
      expect(warnings.join('\n')).toContain("drain left 'writer' alone: budget batch 'spent' is spent")
      // The work that ran settled against the batch that governed it, which is
      // what lets the recorded ceiling stop the class next time.
      expect(ctx.evolutionBudget.spends('open')).toHaveLength(1)
      expect(ctx.evolutionBudget.spends('open')[0]).toMatchObject({ tokens: 0, rollouts: 0 })
    } finally {
      await fiber.dispose()
    }
  })

  it('runs a loop unmeasured where no allocation prices its task class', async () => {
    const { ctx, fiber } = await boot({}, { stores: ['benchmark', 'uncertainty', 'budget'] })
    try {
      await ctx.evolutionBudget.allocate({ batchId: 'other', taskClass: 'unrelated', candidateClass: 'standard' })
      await ctx.evolutionUncertainty.record({
        signalId: 's1',
        skill: 'writer',
        taskId: null,
        kind: 'disagreement',
        score: 0.8,
        detail: 'evaluators disagreed on writer',
      })
      await ctx.evolutionHeartbeat.runTask(LOOP_TASK_NAMES.drain)
      expect(ctx.evolutionBenchmark.tasks().map(task => task.capability)).toEqual(['writer'])
    } finally {
      await fiber.dispose()
    }
  })
})
