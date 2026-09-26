/**
 * Sleep-time compute (`ctx.evolutionSleeptime`): anticipated future tasks with
 * their likelihood and expected savings, plus the precomputed reasoning
 * artifacts — summaries, retrieval structures, candidate plans — cached for
 * them under an offline-cost economic policy (§25). A heartbeat pass derives
 * what to anticipate from the recurrence the router, skill-telemetry, and
 * trace stores recorded, anticipates each class that recurred often enough,
 * precomputes only the artifacts the offline plan justifies, and accounts the
 * recorded later turns that consumed an artifact already cached. Each
 * precompute is worth it only when its likelihood-weighted expected savings
 * beat its offline cost, and the greedy plan fits the best nets into the
 * offline budget. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-sleeptime
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-evolution-heartbeat'
import type {} from '@deepseek-ai/dsh-evolution-model-routes'
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type {} from '@deepseek-ai/dsh-evolution-trace'
import z from 'zod'
import { anticipationOf, artifactSummaryOf, classKeyOf, newlyConsumed, recurrenceOf, windowStartOf } from './anticipate.ts'
import { planFor } from './sleeptime.ts'
import { sleeptimeDomainSpec } from './spec.ts'
import type {
  AnticipatedTask,
  AnticipationInput,
  PrecomputeArtifact,
  PrecomputeInput,
  SleeptimeDecision,
  TaskOccurrence,
} from './types.ts'

export type * from './types.ts'
export { anticipationOf, artifactSummaryOf, classKeyOf, newlyConsumed, recurrenceOf, windowStartOf } from './anticipate.ts'
export { PRECOMPUTE_KINDS, decideWorth, expectedNet, planFor, savingsOf } from './sleeptime.ts'
export { anticipatedTaskRow, precomputeArtifactRow, sleeptimeDomainSpec } from './spec.ts'

/** Heartbeat task name carrying the automatic anticipation pass. */
export const ANTICIPATION_TASK_NAME = 'sleeptime-anticipation'

/**
 * Deployment choices of the sleep-time store; an omitted field takes its
 * schema default.
 */
export interface Config {
  /** Estimated offline tokens of one precompute, used when the caller names none; defaults to 2000. */
  defaultEstimatedCostTokens?: number
  /** Total offline token budget of one plan, used when the caller names none; defaults to 50000. */
  maxOfflineTokens?: number
  /** Occurrences a class needs inside the window before it counts as recurring; defaults to 3. */
  minRecurrences?: number
  /** Hours back a recorded occurrence still counts as recurrence; defaults to 168. */
  recurrenceWindowHours?: number
  /** Hours between two automatic anticipation passes; defaults to 6. */
  intervalHours?: number
  /** Classes one pass may anticipate and precompute; defaults to 3. */
  maxPerPass?: number
}

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  /** Estimated offline tokens of one precompute, used when the caller names none. */
  defaultEstimatedCostTokens: number
  /** Total offline token budget of one plan, used when the caller names none. */
  maxOfflineTokens: number
  /** Occurrences a class needs inside the window before it counts as recurring. */
  minRecurrences: number
  /** Hours back a recorded occurrence still counts as recurrence. */
  recurrenceWindowHours: number
  /** Hours between two automatic anticipation passes. */
  intervalHours: number
  /** Classes one pass may anticipate and precompute. */
  maxPerPass: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    defaultEstimatedCostTokens = 2000,
    maxOfflineTokens = 50000,
    minRecurrences = 3,
    recurrenceWindowHours = 168,
    intervalHours = 6,
    maxPerPass = 3,
  } = config
  return {
    defaultEstimatedCostTokens,
    maxOfflineTokens,
    minRecurrences,
    recurrenceWindowHours,
    intervalHours,
    maxPerPass,
  }
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

  /** Deployment choices of the idle budget and the automatic anticipation pass. */
  static Config = z.object({
    defaultEstimatedCostTokens: z.number().int().min(0).default(2000),
    maxOfflineTokens: z.number().int().min(0).default(50000),
    minRecurrences: z.number().int().min(1).default(3),
    recurrenceWindowHours: z.number().min(0).default(168),
    intervalHours: z.number().min(1).default(6),
    maxPerPass: z.number().int().min(1).default(3),
  })

  private readonly resolved: ResolvedConfig

  private taskTable?: KvTable<string, AnticipatedTask>
  private artifactTable?: KvTable<string, PrecomputeArtifact>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated sleep-time choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionSleeptime')
    this.resolved = resolveConfig(config)
  }

  /**
   * Open the domain, publish the table handles, and register the automatic
   * anticipation pass with the heartbeat when one is mounted. The heartbeat's
   * idle gate is the trigger: a host that mounted none keeps the operator-driven
   * store.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(sleeptimeDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-sleeptime.domainClose')
    this.taskTable = domain.table('tasks')
    this.artifactTable = domain.table('artifacts')
    const heartbeat = this.ctx.get('evolutionHeartbeat')
    if (heartbeat === undefined) return
    this.ctx.effect(
      () => heartbeat.register({
        name: ANTICIPATION_TASK_NAME,
        intervalHours: this.resolved.intervalHours,
        run: signal => this.anticipateAll(signal),
      }),
      'evolution-sleeptime.anticipation',
    )
  }

  /**
   * Run one anticipation pass over the recurrence the source stores recorded:
   * anticipate each class that recurred often enough inside the window,
   * precompute the artifacts the offline plan justifies for them, and account
   * the recorded turns that consumed an artifact already cached. A class whose
   * recurrence falls outside the window is left to the next pass, and a task
   * the plan rates but no recorded recurrence stands behind is skipped rather
   * than precomputed on the plan's word alone. Every phase is bounded by
   * `maxPerPass` and reads only local storage, so the pass observes disposal at
   * the one unbounded wait — reading traces per skill.
   * @param signal - aborts between skills at plugin teardown.
   */
  async anticipateAll(signal?: AbortSignal): Promise<void> {
    const occurrences = await this.recordedOccurrences(signal)
    const windowStart = windowStartOf(new Date().toISOString(), this.resolved.recurrenceWindowHours)
    const recurrence = recurrenceOf(occurrences, windowStart)
    const byTask = new Map(recurrence.map(row => [classKeyOf(row.source, row.taskClass), row]))
    const anticipated = anticipationOf(recurrence, this.resolved.minRecurrences)
      .slice(0, this.resolved.maxPerPass)
    for (const input of anticipated) {
      await this.anticipate(input)
    }
    for (const decision of this.plan().slice(0, this.resolved.maxPerPass)) {
      const evidence = byTask.get(decision.taskId)
      if (evidence === undefined) continue
      await this.precompute({
        artifactId: decision.taskId,
        taskId: decision.taskId,
        kind: 'summary',
        summary: artifactSummaryOf(evidence),
        offlineCostTokens: this.resolved.defaultEstimatedCostTokens,
        reason: decision.reason,
      })
    }
    for (const artifact of this.artifacts()) {
      await this.hit(artifact.artifactId, occurrences)
    }
  }

  /**
   * Every occurrence the mounted source stores recorded: the model-routes
   * store's outcomes measured per task class, and the sessions the
   * skill-telemetry store
   * recorded for each skill, token-accounted by the trace store. A store that
   * is not mounted contributes nothing, so a host without them anticipates
   * less instead of inventing recurrence.
   * @param signal - aborts between skills at plugin teardown.
   * @returns the recorded occurrences, sources in resolution order.
   */
  private async recordedOccurrences(signal?: AbortSignal): Promise<TaskOccurrence[]> {
    const occurrences: TaskOccurrence[] = []
    const routes = this.ctx.get('evolutionModelRoutes')
    if (routes !== undefined) {
      for (const row of routes.evidence()) {
        // An outcome recorded without a task class names no class to recur on.
        if (row.taskClass === undefined) continue
        occurrences.push({ source: 'route', taskClass: row.taskClass, tokens: row.tokens, at: row.at })
      }
    }
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    const trace = this.ctx.get('evolutionTrace')
    if (telemetry === undefined || trace === undefined) return occurrences
    for (const entry of telemetry.entries()) {
      if (signal?.aborted === true) return occurrences
      const sessions = [...entry.usage.sessionIds]
      if (sessions.length === 0) continue
      for (const row of await trace.summary(sessions, sessions.length)) {
        if (row.updatedAt === null) continue
        occurrences.push({ source: 'skill', taskClass: entry.name, tokens: row.tokens, at: row.updatedAt })
      }
    }
    return occurrences
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
   * work. A fresh artifact has served nothing yet, and its hit cursor starts at
   * its own instant, so the turns recorded before it are never counted as its
   * consumers.
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
      decisionReason: input.reason ?? null,
      hits: 0,
      savedTokens: 0,
      servedThroughAt: null,
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
   * Account the recorded occurrences that consumed a cached artifact: every
   * occurrence of the artifact's own class strictly newer than the instant its
   * hits are accounted through, credited with the tokens its store recorded and
   * counted as one hit each. The per-occurrence saving is what the recorded turn
   * spent, so an artifact with no later occurrence keeps its totals unchanged
   * and a second call at the same instant is a no-op — which is what makes a
   * repeating pass safe.
   * @param artifactId - the artifact to account.
   * @param occurrences - every occurrence the source stores recorded.
   * @returns the updated artifact.
   */
  async hit(artifactId: string, occurrences: readonly TaskOccurrence[]): Promise<PrecomputeArtifact> {
    const table = this.requireArtifacts()
    const current = table.get(artifactId)
    if (current === undefined) {
      throw new Error(`evolution-sleeptime: unknown artifact '${artifactId}'`)
    }
    const consumed = newlyConsumed(current, occurrences)
    if (consumed.length === 0) return structuredClone(current)
    let hits = current.hits
    let savedTokens = current.savedTokens
    let servedThroughAt = current.servedThroughAt ?? current.at
    for (const occurrence of consumed) {
      hits += 1
      savedTokens += occurrence.tokens
      if (occurrence.at > servedThroughAt) servedThroughAt = occurrence.at
    }
    const next: PrecomputeArtifact = { ...current, hits, savedTokens, servedThroughAt }
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
    const cost = estimatedCostTokens ?? this.resolved.defaultEstimatedCostTokens
    const budget = budgetTokens ?? this.resolved.maxOfflineTokens
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
