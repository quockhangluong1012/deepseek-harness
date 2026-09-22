/**
 * Benchmark growth from production failures (`ctx.evolutionBenchmark`): a
 * durable store of evaluation tasks with content deduplication and the
 * contamination lifecycle (§14, §35). Failures promoted into tasks enter as
 * `fresh`; a task advances fresh → search → validation → holdout as it is
 * used, and any learnable task can be derailed to `contaminated` or
 * `retired`. A duplicate is never admitted while its twin is still learnable,
 * and contaminated or retired tasks do not block re-admission. The ladder
 * itself has a recorded-evidence rule (`ladderAdvance`, §15): a rung is earned
 * by the candidate exposure recorded for the task's capability, so the
 * holdout partition is not purely a manual decision. Nothing here calls a
 * model.
 * @module @deepseek-ai/dsh-evolution-benchmark
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-evolution-curriculum'
import { benchmarkHash, blocksDuplicate, dedupe, transitionState } from './dedupe.ts'
import { benchmarkDomainSpec } from './spec.ts'
import type { BenchmarkInput, BenchmarkState, BenchmarkTask } from './types.ts'

export type * from './types.ts'
export { benchmarkHash, blocksDuplicate, dedupe, HOLDOUT_AFTER_RUNS, ladderAdvance, nextLadder, transitionState } from './dedupe.ts'
export type { ExposureEvidence } from './dedupe.ts'
export { benchmarkDomainSpec, benchmarkTaskRow } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Benchmark store growing evaluation tasks from production failures. */
    evolutionBenchmark: EvolutionBenchmark
  }
}

/** Deployment choices for benchmark staging. */
export interface Config {
  /** Learnable tasks one admission pass may stage. */
  maxAdmit?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  maxAdmit: z.number().step(1).min(1).default(20),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  maxAdmit: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const { maxAdmit = 20 } = config
  return { maxAdmit }
}

/** The state order used by {@link EvolutionBenchmark.tasks} listing. */
const STATE_ORDER: readonly BenchmarkState[] = ['fresh', 'search', 'validation', 'holdout', 'contaminated', 'retired']

/**
 * Benchmark store over durable tasks. Opens the `evolution_benchmark` domain
 * at init and closes it through `ctx.effect`.
 */
export class EvolutionBenchmark extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, BenchmarkTask>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - per-pass admission bound.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionBenchmark')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(benchmarkDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-benchmark.domainClose')
    this.table = domain.table('tasks')
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
}

export default EvolutionBenchmark
