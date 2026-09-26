/**
 * Evolution actuator: the loops that act on what the engine recorded.
 *
 * Every evolution store records a verdict and stops there — a live rollout
 * waiting for a decision, an island whose scheduled migration is due, a
 * stagnant skill with a strategy to follow, an uncertain evaluation, an open
 * curriculum proposal, a decisive failure, a recorded weakness. This plugin
 * registers one heartbeat task per loop and performs the step each verdict asks
 * for, through the store that already accepts it, while the host is idle. It
 * calls no model, opens no domain, and gates no skill: it moves recorded state
 * only (§58.12), so mounting it changes the engine's next move without changing
 * what any session sees. Each step runs under the §37 budget its task class was
 * priced at, so an allocation can stop the work of a class whose batch is
 * spent.
 * @module @deepseek-ai/dsh-evolution-actuator
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { EvolutionAdversary } from '@deepseek-ai/dsh-evolution-adversary'
import { ladderAdvance } from '@deepseek-ai/dsh-evolution-benchmark'
import type { BenchmarkInput, EvolutionBenchmark, ExposureEvidence } from '@deepseek-ai/dsh-evolution-benchmark'
import { MINED_TASK } from '@deepseek-ai/dsh-evolution-benchmark'
import { withinAllocation } from '@deepseek-ai/dsh-evolution-budget'
import type { EvolutionBudget } from '@deepseek-ai/dsh-evolution-budget'
import { assessRisk } from '@deepseek-ai/dsh-evolution-canary'
import type { EvolutionCanary } from '@deepseek-ai/dsh-evolution-canary'
import type {} from '@deepseek-ai/dsh-evolution-curator'
import type { EvolutionCurriculum } from '@deepseek-ai/dsh-evolution-curriculum'
import type {} from '@deepseek-ai/dsh-evolution-feedback'
import type {} from '@deepseek-ai/dsh-evolution-heartbeat'
import { headIsland } from '@deepseek-ai/dsh-evolution-islands'
import type { EvolutionIslands } from '@deepseek-ai/dsh-evolution-islands'
import type { EvolutionOperators } from '@deepseek-ai/dsh-evolution-operators'
import type { EvolutionPopulation } from '@deepseek-ai/dsh-evolution-population'
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { EvolutionStagnation } from '@deepseek-ai/dsh-evolution-stagnation'
import type { EvolutionUncertainty } from '@deepseek-ai/dsh-evolution-uncertainty'
import { governingAllocation } from './budget.ts'
import { migrationTarget } from './lanes.ts'
import { debtInputs, exposureOf, failureInputs } from './mine.ts'
import { debtProbe, probeTask, signalProbe } from './probe.ts'
import { benchmarkInput } from './queue.ts'
import { recoveryStep } from './recovery.ts'
import { rolloutDecision, rolloutRisk, routeAllows } from './rollout.ts'
import type { AutomationLoop } from './types.ts'

export type * from './types.ts'
export { governingAllocation } from './budget.ts'
export { migrationTarget } from './lanes.ts'
export { debtInputs, exposureOf, failureInputs } from './mine.ts'
export { debtProbe, probeTask, signalProbe } from './probe.ts'
export type { GeneratedProbe } from './probe.ts'
export { benchmarkInput } from './queue.ts'
export { recoveryStep } from './recovery.ts'
export { rolloutDecision, rolloutRisk, routeAllows } from './rollout.ts'

/** Plugin name, as the loader reports it. */
export const name = 'evolution-actuator'

/** The heartbeat this plugin drives every loop from. */
export const inject = ['evolutionHeartbeat']

/** Every loop this plugin can drive, in registration order. */
export const AUTOMATION_LOOPS = ['rollout', 'migration', 'recovery', 'drain', 'admission', 'growth', 'adversary'] as const

/** Deployment choices of the actuator; an omitted field takes its default. */
export interface Config {
  /** Loops to drive; default every loop. */
  loops?: AutomationLoop[]
  /** Hours between two rollout-monitor passes; default 6. */
  rolloutIntervalHours?: number
  /** Cost multiple over the incumbent's triple that fails a rollout; default 1.5. */
  rolloutCostFactor?: number
  /** Hours between two scheduled island-migration passes; default 24. */
  migrationIntervalHours?: number
  /** Hours between two stagnation-recovery passes; default 24. */
  recoveryIntervalHours?: number
  /** Hours between two uncertainty-drain passes; default 12. */
  drainIntervalHours?: number
  /** Hours between two curriculum-admission passes; default 24. */
  admissionIntervalHours?: number
  /** Hours between two benchmark-growth passes; default 24. */
  growthIntervalHours?: number
  /** Hours between two adversarial-generation passes; default 24. */
  adversaryIntervalHours?: number
  /** Items one loop acts on per pass, strongest or newest first; default 5. */
  maxPerPass?: number
}

/** Plugin configuration with every optional field resolved. */
export interface ResolvedConfig {
  /** Loops to drive, in registration order. */
  loops: readonly AutomationLoop[]
  /** Hours between two rollout-monitor passes. */
  rolloutIntervalHours: number
  /** Cost multiple over the incumbent's triple that fails a rollout. */
  rolloutCostFactor: number
  /** Hours between two scheduled island-migration passes. */
  migrationIntervalHours: number
  /** Hours between two stagnation-recovery passes. */
  recoveryIntervalHours: number
  /** Hours between two uncertainty-drain passes. */
  drainIntervalHours: number
  /** Hours between two curriculum-admission passes. */
  admissionIntervalHours: number
  /** Hours between two benchmark-growth passes. */
  growthIntervalHours: number
  /** Hours between two adversarial-generation passes. */
  adversaryIntervalHours: number
  /** Items one loop acts on per pass. */
  maxPerPass: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  loops: z.array(z.union([...AUTOMATION_LOOPS])).min(1).default([...AUTOMATION_LOOPS]),
  rolloutIntervalHours: z.number().min(1).default(6),
  rolloutCostFactor: z.number().min(1).default(1.5),
  migrationIntervalHours: z.number().min(1).default(24),
  recoveryIntervalHours: z.number().min(1).default(24),
  drainIntervalHours: z.number().min(1).default(12),
  admissionIntervalHours: z.number().min(1).default(24),
  growthIntervalHours: z.number().min(1).default(24),
  adversaryIntervalHours: z.number().min(1).default(24),
  maxPerPass: z.number().step(1).min(1).default(5),
})

/**
 * Resolve the loop and cadence defaults, refusing a loop this plugin does not
 * drive before anything registers.
 * @param config - validated plugin configuration.
 * @returns configuration with every field present.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const loops = [...(config.loops ?? AUTOMATION_LOOPS)]
  for (const loop of loops) {
    if (!AUTOMATION_LOOPS.includes(loop)) {
      throw new Error(`evolution-actuator: unknown automation loop '${loop}'`)
    }
  }
  return {
    loops,
    rolloutIntervalHours: config.rolloutIntervalHours ?? 6,
    rolloutCostFactor: config.rolloutCostFactor ?? 1.5,
    migrationIntervalHours: config.migrationIntervalHours ?? 24,
    recoveryIntervalHours: config.recoveryIntervalHours ?? 24,
    drainIntervalHours: config.drainIntervalHours ?? 12,
    admissionIntervalHours: config.admissionIntervalHours ?? 24,
    growthIntervalHours: config.growthIntervalHours ?? 24,
    adversaryIntervalHours: config.adversaryIntervalHours ?? 24,
    maxPerPass: config.maxPerPass ?? 5,
  }
}

/** One loop's registration: its stable task name, cadence, and pass. */
interface LoopRegistration {
  /** Heartbeat task identity, unique per host. */
  name: string
  /** Hours between two passes of this loop. */
  intervalHours: (resolved: ResolvedConfig) => number
  /** The pass this loop performs. */
  run: (ctx: Context, resolved: ResolvedConfig) => Promise<void>
}

/** Every loop's registration, keyed by the loop it closes. */
const LOOPS: Record<AutomationLoop, LoopRegistration> = {
  rollout: {
    name: 'evolution-rollout-monitor',
    intervalHours: resolved => resolved.rolloutIntervalHours,
    run: runRollout,
  },
  migration: {
    name: 'evolution-island-migration',
    intervalHours: resolved => resolved.migrationIntervalHours,
    run: runMigration,
  },
  recovery: {
    name: 'evolution-stagnation-recovery',
    intervalHours: resolved => resolved.recoveryIntervalHours,
    run: runRecovery,
  },
  drain: {
    name: 'evolution-uncertainty-drain',
    intervalHours: resolved => resolved.drainIntervalHours,
    run: runDrain,
  },
  admission: {
    name: 'evolution-curriculum-admission',
    intervalHours: resolved => resolved.admissionIntervalHours,
    run: runAdmission,
  },
  growth: {
    name: 'evolution-benchmark-growth',
    intervalHours: resolved => resolved.growthIntervalHours,
    run: runGrowth,
  },
  adversary: {
    name: 'evolution-adversarial-probes',
    intervalHours: resolved => resolved.adversaryIntervalHours,
    run: runAdversary,
  },
}

/**
 * The heartbeat task name each loop registers under, so a host can address one
 * loop's pass through `runTask` and read its bookkeeping through `state`.
 */
export const LOOP_TASK_NAMES: Record<AutomationLoop, string> = {
  rollout: LOOPS.rollout.name,
  migration: LOOPS.migration.name,
  recovery: LOOPS.recovery.name,
  drain: LOOPS.drain.name,
  admission: LOOPS.admission.name,
  growth: LOOPS.growth.name,
  adversary: LOOPS.adversary.name,
}

/**
 * Register one heartbeat task per configured loop. Registration is the trigger.
 * The plugin removes each task on teardown and awaits any active run.
 * @param ctx - plugin context; registrations dispose with it.
 * @param config - which loops to drive and how often.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  for (const loop of resolved.loops) {
    const registration = LOOPS[loop]
    ctx.effect(
      () => ctx.evolutionHeartbeat.register({
        name: registration.name,
        intervalHours: registration.intervalHours(resolved),
        run: () => registration.run(ctx, resolved),
      }),
      `evolution-actuator.${loop}`,
    )
  }
}

/**
 * Run one loop's work under the §37 budget its task class was priced at. The
 * budget store keys an allocation by batch and task class, so the work of one
 * skill or capability is governed by the newest allocation recorded for that
 * class: a class whose batch has no room left is left alone and the skip is
 * recorded in the log — nothing happened, so nothing is written to a domain —
 * while a class no batch priced, and a host without the budget store, runs
 * unmeasured. `withinAllocation` is the budget package's own rule, so a
 * dimension the engine adds to an allocation is enforced here wherever it is
 * recorded. After the work the pass settles against the same batch, recording
 * the wall time it took: the loops call no model, so what a pass consumes is
 * wall time, and recording it is what lets a batch's ceiling stop the class it
 * priced.
 * @param ctx - host context carrying the optional budget store.
 * @param loop - the loop asking, named in the recorded skip.
 * @param taskClass - the skill or capability the work touches.
 * @param work - the step to perform when the class still has room; a step with
 * no store call is synchronous and still settles its wall time.
 */
async function underBudget(
  ctx: Context,
  loop: AutomationLoop,
  taskClass: string,
  work: () => Promise<void> | void,
): Promise<void> {
  const budget: EvolutionBudget | undefined = ctx.get('evolutionBudget')
  if (budget === undefined) {
    await work()
    return
  }
  const allocation = governingAllocation(budget.batches(taskClass))
  if (allocation === undefined) {
    await work()
    return
  }
  if (!withinAllocation(allocation, budget.spends(allocation.batchId))) {
    ctx.logger.warn(`evolution-actuator: ${loop} left '${taskClass}' alone: budget batch '${allocation.batchId}' is spent`)
    return
  }
  const startedAt = Date.now()
  await work()
  await budget.spend(allocation.batchId, { tokens: 0, wallTimeMs: Date.now() - startedAt, rollouts: 0 })
}

/**
 * Decide every live rollout the canary store holds: a patch whose recorded
 * evidence holds against the incumbent promotes, one that regressed rolls
 * back, and an unmeasured one holds until it is measured. Starting a rollout
 * stays a human decision (§49 routes the medium-risk step to an operator), so
 * this loop only ends one that already runs live — and it consults §49's risk
 * model before it promotes: a measured regression always leaves the ladder,
 * while a promotion needs the `auto-promote` route, so a patch whose capability
 * has no protected holdout, whose evidence has no baseline, or whose artifact is
 * scope-wide stays live for the operator step its route names.
 * @param ctx - host context carrying the evolution stores.
 * @param resolved - deployment choices.
 */
async function runRollout(ctx: Context, resolved: ResolvedConfig): Promise<void> {
  const canary: EvolutionCanary | undefined = ctx.get('evolutionCanary')
  if (canary === undefined) return
  const benchmark: EvolutionBenchmark | undefined = ctx.get('evolutionBenchmark')
  const holdouts = new Set((benchmark?.tasks('holdout') ?? []).map(task => task.capability))
  for (const deployment of canary.deployments('canary').slice(0, resolved.maxPerPass)) {
    const incumbent = canary.deployments('promoted', deployment.skill)[0]
    const route = assessRisk(rolloutRisk(deployment, holdouts.has(deployment.skill))).route
    const decision = rolloutDecision(deployment, incumbent, resolved.rolloutCostFactor)
    if (decision === 'hold' || !routeAllows(decision, route)) continue
    await underBudget(ctx, 'rollout', deployment.skill, async () => {
      await canary.advance(deployment.id, decision === 'promote' ? 'promoted' : 'rolled-back')
    })
  }
}

/**
 * Record the migrations the island schedule says are due: every due lane hands
 * the skill's current elite to the next lane in §7's objective order. A lane
 * with no sibling lane, and a skill with no recorded candidate, have nowhere
 * to migrate and are skipped. The recorded migration resets the lane's due
 * flag, which is what keeps the next pass from repeating it.
 * @param ctx - host context carrying the evolution stores.
 * @param resolved - deployment choices.
 */
async function runMigration(ctx: Context, resolved: ResolvedConfig): Promise<void> {
  const islands: EvolutionIslands | undefined = ctx.get('evolutionIslands')
  const population: EvolutionPopulation | undefined = ctx.get('evolutionPopulation')
  if (islands === undefined || population === undefined) return
  const due = islands.schedule().filter(row => row.due).slice(0, resolved.maxPerPass)
  for (const row of due) {
    const skill = row.island.skill
    const target = migrationTarget(row.island.islandId, islands.islands(skill))
    const elite = population.elite(skill)[0]
    if (target === undefined || elite === undefined) continue
    await underBudget(ctx, 'migration', skill, async () => {
      await islands.migrate({
        fromIslandId: row.island.islandId,
        toIslandId: target.islandId,
        candidateId: elite.candidateId,
        reason: 'schedule',
      })
    })
  }
}

/**
 * Act on the strategy each stagnant skill's ladder rung asks for (§32). The
 * diversity rung moves the skill's elite into its novelty lane, the
 * newOperators rung reports the mutation instruction its artifact class is
 * recommended, and the newTasks rung stages the tasks its measured gaps
 * derive; the two deeper rungs have no store to write, so they change nothing
 * here — see `recoveryStep`.
 * @param ctx - host context carrying the evolution stores.
 * @param resolved - deployment choices.
 */
async function runRecovery(ctx: Context, resolved: ResolvedConfig): Promise<void> {
  const stagnation: EvolutionStagnation | undefined = ctx.get('evolutionStagnation')
  if (stagnation === undefined) return
  const skills = [...new Set(stagnation.runs().map(run => run.skill))].sort().slice(0, resolved.maxPerPass)
  for (const skill of skills) {
    const status = stagnation.status(skill)
    if (!status.stagnant) continue
    const step = recoveryStep(status.strategy)
    if (step === 'diversify') await underBudget(ctx, 'recovery', skill, () => diversify(ctx, skill))
    if (step === 'operators') await underBudget(ctx, 'recovery', skill, () => { reportOperators(ctx, skill) })
    if (step === 'propose') await underBudget(ctx, 'recovery', skill, () => proposeTasks(ctx))
  }
}

/**
 * Report the mutation instruction `evolution-operators` recommends for one
 * stagnant skill's artifact class (§32's newOperators rung). The store owns the
 * portfolio and the proposals in it, so this reads and reports rather than
 * writes: the optimizer is the consumer that draws the next portfolio from the
 * same recommendation. A class the store recommends an instruction for is
 * reported with the operator and the instruction line; a class it recommends
 * nothing for — because no instruction is proposed, or because the store is not
 * mounted — is reported unactionable, naming which of the two it is. Either way
 * no store is written, so the pass leaves the portfolio exactly as it found it.
 * @param ctx - host context carrying the optional operators store.
 * @param skill - the stagnant skill, which is the artifact class its mutations target.
 */
function reportOperators(ctx: Context, skill: string): void {
  const operators: EvolutionOperators | undefined = ctx.get('evolutionOperators')
  const recommended = operators?.recommendedInstruction(skill)
  if (recommended === undefined) {
    const why = operators === undefined
      ? 'the evolution-operators store is not mounted'
      : `evolution-operators holds no instruction for class '${skill}'`
    ctx.logger.warn(`evolution-actuator: recovery left rung 'newOperators' for '${skill}' unactionable: ${why}`)
    return
  }
  ctx.logger.info(`evolution-actuator: recovery takes '${skill}' to the recommended '${recommended.operator}' instruction: '${recommended.instruction}'`)
}

/**
 * Move one stagnant skill's elite into its novelty lane, recording the
 * migration as the diversity escape §32 asks for. A skill without a novelty
 * lane, without an elite candidate, or whose head lane already is the novelty
 * lane is left alone.
 * @param ctx - host context carrying the evolution stores.
 * @param skill - the stagnant skill.
 */
async function diversify(ctx: Context, skill: string): Promise<void> {
  const islands: EvolutionIslands | undefined = ctx.get('evolutionIslands')
  const population: EvolutionPopulation | undefined = ctx.get('evolutionPopulation')
  if (islands === undefined || population === undefined) return
  const lanes = islands.islands(skill)
  const from = headIsland(lanes, skill)
  const to = lanes.find(lane => lane.objective === 'novelty')
  const elite = population.elite(skill)[0]
  if (from === undefined || to === undefined || elite === undefined || to.islandId === from.islandId) return
  await islands.migrate({
    fromIslandId: from.islandId,
    toIslandId: to.islandId,
    candidateId: elite.candidateId,
    reason: 'diversity',
  })
}

/**
 * Stage the tasks the measured capability gaps derive. The curriculum store
 * skips a gap whose task is already open, so a skill that stays stagnant
 * stages each task once.
 * @param ctx - host context carrying the evolution stores.
 */
async function proposeTasks(ctx: Context): Promise<void> {
  const curriculum: EvolutionCurriculum | undefined = ctx.get('evolutionCurriculum')
  if (curriculum === undefined) return
  await curriculum.propose(await curriculum.gaps())
}

/**
 * Turn the highest-priority uncertain evaluations into benchmark tasks and
 * drop the signals they were derived from, so the queue drains instead of
 * re-admitting the same uncertainty every pass (§43's active-learning loop).
 * The queue derives every task from these same signals, so each queued task has
 * at least one signal and `benchmarkInput` refuses rather than admits an empty
 * one.
 * @param ctx - host context carrying the evolution stores.
 * @param resolved - deployment choices.
 */
async function runDrain(ctx: Context, resolved: ResolvedConfig): Promise<void> {
  const uncertainty: EvolutionUncertainty | undefined = ctx.get('evolutionUncertainty')
  const benchmark: EvolutionBenchmark | undefined = ctx.get('evolutionBenchmark')
  if (uncertainty === undefined || benchmark === undefined) return
  for (const task of uncertainty.queue(undefined, resolved.maxPerPass)) {
    const signals = uncertainty.signals(task.skill)
      .filter(signal => signal.taskId === task.taskId)
    await underBudget(ctx, 'drain', task.skill, async () => {
      await benchmark.admit([benchmarkInput(task, signals)])
      await uncertainty.resolve(task.skill, task.taskId ?? undefined)
    })
  }
}

/**
 * Admit every open curriculum proposal as a benchmark task: the proposal →
 * benchmark arrow of §53's skill-creation chain, which `/benchmark admit`
 * performs by hand. The benchmark store deduplicates by task content, so a
 * proposal that stays open is admitted once.
 * @param ctx - host context carrying the evolution stores.
 * @param resolved - deployment choices.
 */
async function runAdmission(ctx: Context, resolved: ResolvedConfig): Promise<void> {
  const curriculum: EvolutionCurriculum | undefined = ctx.get('evolutionCurriculum')
  const benchmark: EvolutionBenchmark | undefined = ctx.get('evolutionBenchmark')
  if (curriculum === undefined || benchmark === undefined) return
  const open = curriculum.proposals()
    .filter(proposal => proposal.state === 'open')
    .slice(0, resolved.maxPerPass)
  for (const proposal of open) {
    await underBudget(ctx, 'admission', proposal.capability, async () => {
      await benchmark.admit([{
        capability: proposal.capability,
        task: proposal.task,
        gists: [...proposal.gists],
        sourceSessions: [...proposal.sourceSessions],
        ...MINED_TASK,
      }])
    })
  }
}

/**
 * Grow the benchmark from what the engine already recorded (§14): admit the
 * failures the feedback store graded decisive and the failures the curator still
 * owes as regression cases, then move every learnable task along §15's ladder on
 * the exposure recorded for its capability. The ladder runs first so a task is
 * never advanced in the pass that created it, and both halves are idempotent by
 * construction: the benchmark store blocks a duplicate by content address, the
 * ladder rule is monotonic, and `transition` writes only when the state changes.
 * Neither half needs the optimizer — the sources are live session failures, the
 * curator's own debt, and the candidate evaluations the population store
 * recorded.
 * @param ctx - host context carrying the evolution stores.
 * @param resolved - deployment choices.
 */
async function runGrowth(ctx: Context, resolved: ResolvedConfig): Promise<void> {
  const benchmark: EvolutionBenchmark | undefined = ctx.get('evolutionBenchmark')
  if (benchmark === undefined) return
  await advanceLadder(ctx, benchmark, resolved.maxPerPass)
  const curator = ctx.get('evolutionCurator')
  const feedback = ctx.get('evolutionFeedback')
  const telemetry = ctx.get('evolutionSkillTelemetry')
  const sessions = telemetry === undefined
    ? []
    : [...new Set(telemetry.entries().flatMap(entry => entry.usage.sessionIds))]
  const inputs: BenchmarkInput[] = [
    ...(curator === undefined ? [] : debtInputs(curator.debt().slice(0, resolved.maxPerPass))),
    ...(feedback === undefined ? [] : failureInputs(feedback.signals(sessions, resolved.maxPerPass))),
  ]
  if (inputs.length === 0) return
  for (const input of inputs) {
    await underBudget(ctx, 'growth', input.capability, async () => {
      await benchmark.admit([input])
    })
  }
}

/**
 * Generate the adversarial probes the recorded evidence grounds (§45) and admit
 * the ones that target a benchmark-shaped capability as §14 adversarial
 * examples. The evidence is what two stores already recorded: the §43
 * uncertainty signals, each mapped to the §45 family its kind targets, and the
 * curator's open regression debt, a failing tool call no lesson answered. Every
 * probe therefore carries a recorded observation verbatim, so nothing here
 * invents a weakness — and a probe is recorded, never run: executing it against
 * a candidate needs a runner and a corpus the shipped profile has no store for,
 * so the pass records the challenge and leaves `foundWeakness` false rather than
 * pretending a run happened. A probe whose text the store already holds is left
 * as it stands, so a repaired probe is never re-opened and a re-recorded
 * weakness never becomes a second probe.
 * @param ctx - host context carrying the evolution stores.
 * @param resolved - deployment choices.
 */
async function runAdversary(ctx: Context, resolved: ResolvedConfig): Promise<void> {
  const adversary: EvolutionAdversary | undefined = ctx.get('evolutionAdversary')
  if (adversary === undefined) return
  const uncertainty = ctx.get('evolutionUncertainty')
  const curator = ctx.get('evolutionCurator')
  const generated = [
    ...(uncertainty === undefined ? [] : uncertainty.signals().map(signalProbe)),
    ...(curator === undefined ? [] : curator.debt().map(debtProbe)),
  ].slice(0, resolved.maxPerPass)
  if (generated.length === 0) return
  const benchmark: EvolutionBenchmark | undefined = ctx.get('evolutionBenchmark')
  const capabilities = benchmark === undefined ? undefined : new Set(benchmark.tasks().map(task => task.capability))
  for (const item of generated) {
    await underBudget(ctx, 'adversary', item.probe.skill, async () => {
      const held = adversary.probes(item.probe.skill)
        .some(probe => probe.category === item.probe.category && probe.probe === item.probe.probe)
      if (!held) await adversary.probe(item.probe)
      if (benchmark === undefined || capabilities?.has(item.probe.skill) !== true) return
      await benchmark.admit([probeTask(item)])
    })
  }
}

/**
 * Move the learnable benchmark tasks one rung each where the exposure recorded
 * for their capability earns it (§15). Exposure is capability-scoped and comes
 * from the population store's recorded candidate evaluations; a task whose
 * capability has no recorded evaluation stays where it is, so the ladder moves
 * on evidence and never on the pass count. At most `maxPerPass` tasks are
 * considered per pass, in ladder order and newest first, and the rule advances
 * one rung per call, so a task converges on `holdout` over several passes and
 * then stops.
 * @param ctx - host context carrying the evolution stores.
 * @param benchmark - the benchmark store to advance.
 * @param maxPerPass - tasks one pass may consider.
 */
async function advanceLadder(ctx: Context, benchmark: EvolutionBenchmark, maxPerPass: number): Promise<void> {
  const population: EvolutionPopulation | undefined = ctx.get('evolutionPopulation')
  if (population === undefined) return
  const learnable = [
    ...benchmark.tasks('fresh'),
    ...benchmark.tasks('search'),
    ...benchmark.tasks('validation'),
  ].slice(0, maxPerPass)
  for (const task of learnable) {
    const exposure: ExposureEvidence = exposureOf(population.candidates(task.capability))
    const next = ladderAdvance(task.state, exposure)
    if (next === undefined) continue
    await underBudget(ctx, 'growth', task.capability, async () => {
      await benchmark.transition(task.id, next)
    })
  }
}
