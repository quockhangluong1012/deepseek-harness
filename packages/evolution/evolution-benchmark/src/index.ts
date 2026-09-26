/**
 * Benchmark growth and execution (`ctx.evolutionBenchmark`): a durable store of
 * evaluation tasks with content deduplication and the contamination lifecycle
 * (§14, §35), and the run pass that executes them (§13). Failures promoted into
 * tasks enter as `fresh`; a task advances fresh → search → validation → holdout
 * as it is used, and any learnable task can be derailed to `contaminated` or
 * `retired`. A duplicate is never admitted while its twin is still learnable,
 * and contaminated or retired tasks do not block re-admission. The ladder
 * itself has a recorded-evidence rule (`ladderAdvance`, §15): a rung is earned
 * by the candidate exposure recorded for the task's capability, so the
 * holdout partition is not purely a manual decision. The §5.3 baseline
 * datasets ship beside the store as task definitions a runner enumerates with
 * `loadDatasets` and admits through `admit`, so one store holds both the mined
 * tasks and the authored corpus.
 *
 * `run` is the execution half. It builds each task's input script from the task
 * text, boots it through the same fresh-process runner `evolution-scorer`
 * scores through, reduces the attempts with the scorer's own `scoreRun`, and
 * records one durable outcome per task — the pass verdict, the billed triple,
 * and the §13.5 facts its harvested sessions recorded. Nothing here calls a
 * model itself: the runner the caller passes decides whether a run is the
 * keyless replay tier or a live one.
 * @module @deepseek-ai/dsh-evolution-benchmark
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { measureRunTokens, scoreRun } from '@deepseek-ai/dsh-evolution-scorer'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type { HarvestedLog } from '@deepseek-ai/dsh-session-snapshot'
import type { ScoreAttempt } from '@deepseek-ai/dsh-evolution-scorer'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-evolution-curriculum'
import { benchmarkHash, blocksDuplicate, dedupe, transitionState } from './dedupe.ts'
import { horizonTier } from './dataset.ts'
import { benchmarkRunDomainSpec } from './outcome.ts'
import { runFacts, taskScript } from './run.ts'
import { benchmarkDomainSpec } from './spec.ts'
import type {
  BenchmarkInput,
  BenchmarkOutcome,
  BenchmarkRunReport,
  BenchmarkRunRequest,
  BenchmarkState,
  BenchmarkTask,
} from './types.ts'

export type * from './types.ts'
export { benchmarkHash, blocksDuplicate, dedupe, HOLDOUT_AFTER_RUNS, ladderAdvance, nextLadder, transitionState } from './dedupe.ts'
export type { ExposureEvidence } from './dedupe.ts'
export { datasetInputs, HORIZON_TIERS, horizonTier, loadDatasets } from './dataset.ts'
export type { BenchmarkDataset, DatasetTask, HorizonTier } from './dataset.ts'
export { benchmarkOutcomeRow, benchmarkRunDomainSpec } from './outcome.ts'
export type { BenchmarkOutcomeRow } from './outcome.ts'
export { contextPressureOf, CONTEXT_PRESSURE_INPUT } from './pressure.ts'
export type { ContextPressure } from './pressure.ts'
export { runFacts, RUN_FACTS_INPUT, taskScript } from './run.ts'
export type { RunFacts } from './run.ts'
export { benchmarkDomainSpec, benchmarkTaskRow } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Benchmark store growing evaluation tasks from production failures, and running them. */
    evolutionBenchmark: EvolutionBenchmark
  }
}

/** Deployment choices for benchmark staging and execution. */
export interface Config {
  /** Learnable tasks one admission pass may stage. */
  maxAdmit?: number
  /** Tasks one run pass executes. */
  maxTasks?: number
  /** Fresh-process attempts per task in a run pass. */
  attempts?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  maxAdmit: z.number().step(1).min(1).default(20),
  maxTasks: z.number().step(1).min(1).default(20),
  attempts: z.number().step(1).min(1).default(1),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  maxAdmit: number
  maxTasks: number
  attempts: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const { maxAdmit = 20, maxTasks = 20, attempts = 1 } = config
  return { maxAdmit, maxTasks, attempts }
}

/** The state order used by {@link EvolutionBenchmark.tasks} listing. */
const STATE_ORDER: readonly BenchmarkState[] = ['fresh', 'search', 'validation', 'holdout', 'contaminated', 'retired']

/** The `changes` a run that produced no verdict contributed. */
const NO_CHANGES: readonly [] = []

/**
 * How a producer classifies a task mined from recorded evidence. Every producer
 * that derives a task from a failure, an uncertainty signal, or a curriculum
 * proposal reproduces a recorded failure, so the task belongs to the
 * loop/recovery family and states no profile, no step horizon, and no
 * acceptance observable of its own — the recorded failure is its subject, not
 * an authored scenario.
 */
export const MINED_TASK: Pick<BenchmarkInput, 'profile' | 'family' | 'stepSpan' | 'acceptance'> = {
  profile: null,
  family: 'loop-recovery',
  stepSpan: null,
  acceptance: null,
}

/** Everything one attempt of one task observed, plus the sessions it harvested. */
interface AttemptObservation {
  /** The attempt's scored observation. */
  attempt: ScoreAttempt
  /** The attempt's harvested session logs, parent first. */
  logs: readonly HarvestedLog[]
}

/**
 * Benchmark store over durable tasks and the outcomes their runs recorded.
 * Opens the `evolution_benchmark` and `evolution_benchmark_runs` domains at
 * init and closes them through `ctx.effect`.
 */
export class EvolutionBenchmark extends Service {
  static inject = ['storageDomain', 'tokenMeter']

  private table?: KvTable<string, BenchmarkTask>
  private outcomeTable?: KvTable<string, BenchmarkOutcome>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the storage domain and the token meter.
   * @param config - per-pass admission bound, run bound, and attempt count.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionBenchmark')
    this.resolved = resolveConfig(config)
  }

  /** Open the domains and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(benchmarkDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-benchmark.domainClose')
    this.table = domain.table('tasks')
    const runs = await this.ctx.storageDomain.open(benchmarkRunDomainSpec)
    this.ctx.effect(() => () => runs.close(), 'evolution-benchmark.runDomainClose')
    this.outcomeTable = runs.table('outcomes')
  }

  /**
   * Admit candidate tasks, deduplicating against every still-learnable task.
   * Contaminated and retired tasks do not block re-admission. The admission
   * pass stages at most `maxAdmit` new tasks.
   * @param inputs - candidate tasks, in caller order.
   * @returns the admitted tasks and the duplicate texts.
   */
  async admit(inputs: readonly BenchmarkInput[]): Promise<{ admitted: readonly BenchmarkTask[]; duplicates: string[] }> {
    const now = new Date().toISOString()
    const table = this.requireTable()
    const existing = new Set(
      [...table.entries()]
        .filter(([, task]) => blocksDuplicate(task.state))
        .map(([, task]) => task.hash),
    )
    const { admitted: fresh, duplicates } = dedupe(inputs, existing)
    const staged: BenchmarkTask[] = []
    for (const input of fresh.slice(0, this.resolved.maxAdmit)) {
      const task: BenchmarkTask = {
        id: randomUUID(),
        hash: benchmarkHash(input),
        capability: input.capability,
        task: input.task,
        gists: [...input.gists],
        sourceSessions: [...input.sourceSessions],
        profile: input.profile,
        family: input.family,
        stepSpan: input.stepSpan,
        acceptance: input.acceptance,
        at: now,
        state: 'fresh',
      }
      await table.put(task.id, task)
      staged.push(task)
    }
    return { admitted: staged, duplicates }
  }

  /**
   * List every task, optionally filtered by state, learnable states first in
   * pipeline order then newest first.
   * @param state - optional state filter.
   * @returns the tasks, detached from the store.
   */
  tasks(state?: BenchmarkState): readonly BenchmarkTask[] {
    const rows = [...this.requireTable().entries()]
      .map(([, task]) => structuredClone(task))
      .filter(task => state === undefined || task.state === state)
    rows.sort((left, right) =>
      STATE_ORDER.indexOf(left.state) - STATE_ORDER.indexOf(right.state)
      || right.at.localeCompare(left.at)
      || left.capability.localeCompare(right.capability))
    return rows
  }

  /**
   * List every recorded task outcome, newest first.
   * @returns the outcomes, detached from the store.
   */
  outcomes(): readonly BenchmarkOutcome[] {
    return [...this.requireOutcomeTable().entries()]
      .map(([, outcome]) => structuredClone(outcome))
      .sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id))
  }

  /**
   * Execute benchmark tasks and record one durable outcome per task.
   *
   * Each task runs as its own input script through the caller's runner — the
   * same fresh-process seam `evolution-scorer` scores through, so a keyless
   * deployment passes a replay runner and a live one passes a recording
   * runner. The attempts are reduced by the scorer's own `scoreRun`, so the
   * verdict, the billed tokens, and the wall time mean exactly what they mean
   * everywhere else. A run that fails is recorded as a failed outcome with its
   * reason rather than aborting the pass, so one unrunnable task cannot hide
   * the outcomes of the tasks around it. At most `maxTasks` tasks run per pass;
   * the rest are reported as deferred.
   * @param request - the tasks, the runner, and the wiring every run boots with.
   * @returns the recorded outcomes and the pass's counts.
   */
  async run(request: BenchmarkRunRequest): Promise<BenchmarkRunReport> {
    const table = this.requireOutcomeTable()
    const selected = request.tasks.slice(0, this.resolved.maxTasks)
    const runs = request.attempts ?? this.resolved.attempts
    const outcomes: BenchmarkOutcome[] = []
    for (const task of selected) {
      outcomes.push(await this.execute(task, request, runs, table))
    }
    return {
      outcomes,
      scored: outcomes.filter(outcome => outcome.status === 'scored').length,
      passed: outcomes.filter(outcome => outcome.pass).length,
      failed: outcomes.filter(outcome => outcome.status === 'failed').length,
      deferred: request.tasks.length - selected.length,
    }
  }

  /**
   * Execute one task and record its outcome. Every attempt boots the task's
   * script; the verdict, the billed tokens, and the wall time are the scorer's
   * median over those attempts, while the §13.5 facts describe the first
   * attempt alone — the attempt `trajectory` names — so one outcome never mixes
   * a sum over three runs with a median of one.
   * @param task - the task to execute.
   * @param request - the runner and wiring.
   * @param runs - attempts this task buys.
   * @param table - the outcome table the row is written to.
   * @returns the recorded outcome.
   */
  private async execute(
    task: BenchmarkTask,
    request: BenchmarkRunRequest,
    runs: number,
    table: KvTable<string, BenchmarkOutcome>,
  ): Promise<BenchmarkOutcome> {
    const observed: AttemptObservation[] = []
    const script = taskScript(task)
    let outcome: BenchmarkOutcome
    try {
      for (let index = 0; index < runs; index += 1) {
        const startedAt = Date.now()
        const result = await request.run(script, request.options)
        observed.push({
          logs: result.sessionLogs,
          attempt: {
            initial: result.initialWorkspace,
            final: result.finalWorkspace,
            tokens: measureRunTokens(this.ctx.tokenMeter, result.sessionLogs),
            wallTimeMs: Date.now() - startedAt,
            ...result.sessionLogs[0] === undefined ? {} : { sessionId: result.sessionLogs[0].id },
          },
        })
      }
      const attempts = observed.map(entry => entry.attempt)
      const expected = request.expected?.(task)
      const score = scoreRun({
        scenario: task.capability,
        ...expected === undefined ? {} : { expected },
        attempts,
        // A task's fixed input is its own definition, so its content address
        // identifies which generation this score validated.
        fixtureDigest: task.hash,
      })
      const logs = [...observed[0]?.logs ?? []]
      outcome = {
        ...this.identity(task),
        pass: score.pass,
        status: 'scored',
        reason: null,
        attempts: attempts.length,
        tokens: score.tokens,
        wallTimeMs: score.wallTimeMs,
        samples: score.samples,
        changes: score.changes,
        ...runFacts(logs),
        trajectory: score.trajectory,
        sessionIds: logs.map(log => log.id),
      }
    } catch (error) {
      const logs = [...observed[0]?.logs ?? []]
      outcome = {
        ...this.identity(task),
        pass: false,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        attempts: 0,
        tokens: 0,
        wallTimeMs: 0,
        samples: [],
        changes: NO_CHANGES,
        ...runFacts(logs),
        trajectory: null,
        sessionIds: logs.map(log => log.id),
      }
    }
    await table.put(outcome.id, outcome)
    return outcome
  }

  /**
   * The identity half of one outcome: which task ran, what it declares, and
   * when the pass recorded it.
   * @param task - the task being executed.
   * @returns the identity fields every outcome carries.
   */
  private identity(task: BenchmarkTask): Pick<
    BenchmarkOutcome,
    'id' | 'at' | 'taskId' | 'capability' | 'family' | 'profile' | 'stepSpan' | 'tier'
  > {
    return {
      id: randomUUID(),
      at: new Date().toISOString(),
      taskId: task.id,
      capability: task.capability,
      family: task.family,
      profile: task.profile,
      stepSpan: task.stepSpan,
      tier: task.stepSpan === null ? null : horizonTier(task.stepSpan) ?? null,
    }
  }

  /**
   * Move one task to another state. Learning advances one step per call
   * (fresh → search → validation → holdout), any learnable state may derail to
   * `contaminated` or `retired`, a same-state call resolves without writing,
   * and terminal states never leave. Unknown ids and illegal transitions
   * reject loudly.
   * @param id - task identity.
   * @param to - requested state.
   * @returns the stored task after the transition.
   */
  async transition(id: string, to: BenchmarkState): Promise<BenchmarkTask> {
    const table = this.requireTable()
    const current = table.get(id)
    if (current === undefined) throw new Error(`evolution-benchmark: unknown task '${id}'`)
    if (!transitionState(current.state, to)) {
      throw new Error(`evolution-benchmark: illegal transition ${current.state} → ${to} for '${id}'`)
    }
    if (current.state === to) return structuredClone(current)
    const next = { ...current, state: to }
    await table.put(id, next)
    return structuredClone(next)
  }

  private requireTable(): KvTable<string, BenchmarkTask> {
    if (this.table === undefined) throw new Error('evolution benchmark is not started yet')
    return this.table
  }

  private requireOutcomeTable(): KvTable<string, BenchmarkOutcome> {
    if (this.outcomeTable === undefined) throw new Error('evolution benchmark is not started yet')
    return this.outcomeTable
  }
}

export default EvolutionBenchmark
