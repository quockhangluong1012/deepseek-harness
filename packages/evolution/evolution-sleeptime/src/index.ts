/**
 * Sleep-time compute (`ctx.evolutionSleeptime`): anticipated future tasks with
 * their likelihood and expected savings, plus the precomputed reasoning
 * artifacts — summaries, retrieval structures, candidate plans — cached for
 * them under an offline-cost economic policy (§25). Idle time anticipates
 * likely future tasks and precomputes what they will need; each precompute is
 * worth it only when its likelihood-weighted expected savings beat its
 * offline cost, and the greedy plan fits the best nets into the offline
 * budget. Artifacts record their hits and saved tokens, so the realized
 * savings stay visible against the offline spend. Nothing here calls a model;
 * heartbeat-driven anticipation stays deferred.
 * @module @deepseek-ai/dsh-evolution-sleeptime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { planFor } from './sleeptime.ts'
import { sleeptimeDomainSpec } from './spec.ts'
import type {
  AnticipatedTask,
  AnticipationInput,
  PrecomputeArtifact,
  PrecomputeInput,
  SleeptimeDecision,
} from './types.ts'

export type * from './types.ts'
export { PRECOMPUTE_KINDS, decideWorth, expectedNet, planFor, savingsOf } from './sleeptime.ts'
export { anticipatedTaskRow, precomputeArtifactRow, sleeptimeDomainSpec } from './spec.ts'

/** Validated configuration of the sleep-time store. */
export interface SleeptimeConfig {
  /** Estimated offline tokens of one precompute, used when the caller names none. */
  defaultEstimatedCostTokens: number
  /** Total offline token budget of one plan, used when the caller names none. */
  maxOfflineTokens: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Sleep-time store growing anticipated tasks and precomputed artifacts. */
    evolutionSleeptime: EvolutionSleeptime
  }
}

/**
 * Sleep-time store over durable anticipated tasks and precomputed artifacts.
 * Opens the `evolution_sleeptime` domain at init and closes it through
 * `ctx.effect`.
 */
export class EvolutionSleeptime extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the idle budget; defaults assume a small nightly window. */
  static Config = z.object({
    defaultEstimatedCostTokens: z.number().int().min(0).default(2000),
    maxOfflineTokens: z.number().int().min(0).default(50000),
  })

  /** Deployment choices of the sleep-time store. */
  readonly config: SleeptimeConfig

  private taskTable?: KvTable<string, AnticipatedTask>
  private artifactTable?: KvTable<string, PrecomputeArtifact>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated sleep-time choices.
   */
  constructor(ctx: Context, config: SleeptimeConfig) {
    super(ctx, 'evolutionSleeptime')
    this.config = config
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sleeptimeDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-sleeptime.domainClose')
    this.taskTable = domain.table('tasks')
    this.artifactTable = domain.table('artifacts')
  }

  /**
   * Anticipate one future task, upserting by task identity so a re-anticipated
   * task refreshes its likelihood and expectations. The stored instant is now.
   * @param input - the task to anticipate.
   * @returns the stored task.
   */
  async anticipate(input: AnticipationInput): Promise<AnticipatedTask> {
    const task: AnticipatedTask = {
      taskId: input.taskId,
      domain: input.domain,
      likelihood: input.likelihood,
      expectedQueries: input.expectedQueries,
      expectedSavingTokens: input.expectedSavingTokens,
      at: new Date().toISOString(),
    }
    if (input.scope !== undefined) task.scope = input.scope
    await this.requireTasks().put(task.taskId, task)
    return structuredClone(task)
  }

  /**
   * List every anticipated task, optionally filtered by domain, likeliest
   * first with task-id ascending tie-break.
   * @param domain - optional domain filter.
   * @returns the tasks, detached from the store.
   */
  tasks(domain?: string): readonly AnticipatedTask[] {
    const rows = [...this.requireTasks().entries()]
      .map(([, task]) => structuredClone(task))
      .filter(task => domain === undefined || task.domain === domain)
    rows.sort((left, right) => right.likelihood - left.likelihood || left.taskId.localeCompare(right.taskId))
    return rows
  }

  /**
   * Precompute one reasoning artifact for an anticipated task. The task must
   * exist: an artifact for a task nobody anticipated is a surprise, not idle
   * work. A fresh artifact has served nothing yet.
   * @param input - the artifact to cache.
   * @returns the stored artifact.
   */
  async precompute(input: PrecomputeInput): Promise<PrecomputeArtifact> {
    if (this.requireTasks().get(input.taskId) === undefined) {
      throw new Error(`evolution-sleeptime: unknown anticipated task '${input.taskId}'`)
    }
    const artifact: PrecomputeArtifact = {
      artifactId: input.artifactId,
      taskId: input.taskId,
      kind: input.kind,
      summary: input.summary,
      offlineCostTokens: input.offlineCostTokens,
      hits: 0,
      savedTokens: 0,
      at: new Date().toISOString(),
    }
    await this.requireArtifacts().put(artifact.artifactId, artifact)
    return structuredClone(artifact)
  }

  /**
   * List every cached artifact, optionally filtered by task, newest first with
   * artifact-id ascending tie-break.
   * @param taskId - optional task filter.
   * @returns the artifacts, detached from the store.
   */
  artifacts(taskId?: string): readonly PrecomputeArtifact[] {
    const rows = [...this.requireArtifacts().entries()]
      .map(([, artifact]) => structuredClone(artifact))
      .filter(artifact => taskId === undefined || artifact.taskId === taskId)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.artifactId.localeCompare(right.artifactId))
    return rows
  }

  /**
   * Record one future query served by a cached artifact, adding the query's
   * saved tokens to the artifact's running total.
   * @param artifactId - the artifact that served the query.
   * @param savedTokens - tokens the served query saved.
   * @returns the updated artifact.
   */
  async hit(artifactId: string, savedTokens: number): Promise<PrecomputeArtifact> {
    const table = this.requireArtifacts()
    const current = table.get(artifactId)
    if (current === undefined) {
      throw new Error(`evolution-sleeptime: unknown artifact '${artifactId}'`)
    }
    const next: PrecomputeArtifact = {
      ...current,
      hits: current.hits + 1,
      savedTokens: current.savedTokens + savedTokens,
    }
    await table.put(next.artifactId, next)
    return structuredClone(next)
  }

  /**
   * The greedy budgeted plan over anticipated tasks that have no cached
   * artifact yet: worth-it decisions, best net first, fitted into the offline
   * budget at the estimated cost each.
   * @param estimatedCostTokens - estimated offline cost of one precompute.
   * @param budgetTokens - total offline budget available.
   * @returns the planned decisions, best net first.
   */
  plan(estimatedCostTokens?: number, budgetTokens?: number): readonly SleeptimeDecision[] {
    const cost = estimatedCostTokens ?? this.config.defaultEstimatedCostTokens
    const budget = budgetTokens ?? this.config.maxOfflineTokens
    const cached = new Set([...this.requireArtifacts().entries()].map(([, artifact]) => artifact.taskId))
    const open = [...this.requireTasks().entries()]
      .map(([, task]) => structuredClone(task))
      .filter(task => !cached.has(task.taskId))
    return planFor(open, cost, budget)
  }

  private requireTasks(): KvTable<string, AnticipatedTask> {
    if (this.taskTable === undefined) throw new Error('evolution sleeptime store is not started yet')
    return this.taskTable
  }

  private requireArtifacts(): KvTable<string, PrecomputeArtifact> {
    if (this.artifactTable === undefined) throw new Error('evolution sleeptime store is not started yet')
    return this.artifactTable
  }
}

export default EvolutionSleeptime
