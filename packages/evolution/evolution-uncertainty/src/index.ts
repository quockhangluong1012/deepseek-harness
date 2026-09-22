/**
 * Uncertainty-driven learning (`ctx.evolutionUncertainty`): durable uncertainty
 * signals of the five §43 kinds — evaluator disagreement, low confidence,
 * cross-seed instability, retrieval ambiguity, conflicting evidence — aggregated
 * into a prioritized queue of high-value evaluation tasks (the §43
 * active-learning loop). Signals sharing a skill and task corroborate: each
 * distinct kind past the first adds the configured bonus to the task's priority,
 * capped at 1, so a task several kinds flag outranks a hotter single-kind one.
 * Resolving a task drops its signals and the queue re-derives from what remains.
 * Nothing here calls a model; the store only records signals.
 * @module @deepseek-ai/dsh-evolution-uncertainty
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { queueFor } from './uncertainty.ts'
import { uncertaintyDomainSpec } from './spec.ts'
import type { EvaluationTask, UncertaintySignal, UncertaintySignalInput } from './types.ts'

export type * from './types.ts'
export { UNCERTAINTY_KINDS, priorityOf, queueFor } from './uncertainty.ts'
export { uncertaintyDomainSpec, uncertaintySignalRow } from './spec.ts'

/** Validated configuration of the uncertainty queue. */
export interface UncertaintyConfig {
  /** Maximum tasks `queue` returns when the caller passes no limit. */
  queueLimit: number
  /** Priority added per distinct signal kind past the first in one task. */
  corroborationBonus: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Uncertainty store aggregating §43 signals into evaluation tasks. */
    evolutionUncertainty: EvolutionUncertainty
  }
}

/**
 * Uncertainty-signal store over durable signals. Opens the
 * `evolution_uncertainty` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionUncertainty extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the queue; defaults suit an ordinary cadence. */
  static Config = z.object({
    queueLimit: z.number().int().min(1).default(50),
    corroborationBonus: z.number().min(0).max(1).default(0.15),
  })

  /** Deployment choices of the uncertainty queue. */
  readonly config: UncertaintyConfig

  private signalTable?: KvTable<string, UncertaintySignal>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated queue choices.
   */
  constructor(ctx: Context, config: UncertaintyConfig) {
    super(ctx, 'evolutionUncertainty')
    this.config = config
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(uncertaintyDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-uncertainty.domainClose')
    this.signalTable = domain.table('signals')
  }

  /**
   * Record one uncertainty signal, stamping it with the current instant.
   * @param input - the signal to record.
   * @returns the stored signal.
   */
  async record(input: UncertaintySignalInput): Promise<UncertaintySignal> {
    const table = this.requireTable()
    const signal: UncertaintySignal = {
      signalId: input.signalId,
      skill: input.skill,
      taskId: input.taskId,
      kind: input.kind,
      score: input.score,
      detail: input.detail,
      at: new Date().toISOString(),
    }
    await table.put(signal.signalId, signal)
    return structuredClone(signal)
  }

  /**
   * List every signal, optionally filtered by skill, newest first with signal
   * identity breaking same-instant ties for determinism.
   * @param skill - optional skill filter.
   * @returns the signals, detached from the store.
   */
  signals(skill?: string): readonly UncertaintySignal[] {
    const rows = [...this.requireTable().entries()]
      .map(([, signal]) => structuredClone(signal))
      .filter(signal => skill === undefined || signal.skill === skill)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.signalId.localeCompare(right.signalId))
    return rows
  }

  /**
   * The prioritized evaluation-task queue over the filtered signals, capped at
   * the caller's limit or the configured queue limit.
   * @param skill - optional skill filter.
   * @param limit - optional task cap, defaulting to the configured queue limit.
   * @returns the top evaluation tasks, highest priority first.
   */
  queue(skill?: string, limit?: number): readonly EvaluationTask[] {
    return queueFor(this.signals(skill), this.config.corroborationBonus).slice(0, limit ?? this.config.queueLimit)
  }

  /**
   * Drop the signals behind one evaluation task — without a task identity only
   * the skill-wide (null-task) signals of the skill — returning the count
   * removed. The queue re-derives from the signals that remain.
   * @param skill - the skill whose signals to drop.
   * @param taskId - optional task identity to drop; undefined drops only skill-wide signals.
   * @returns the number of signals removed.
   */
  async resolve(skill: string, taskId?: string): Promise<number> {
    const table = this.requireTable()
    let removed = 0
    for (const [signalId, signal] of [...table.entries()]) {
      const matches = signal.skill === skill && (taskId === undefined ? signal.taskId === null : signal.taskId === taskId)
      if (matches) {
        await table.delete(signalId)
        removed += 1
      }
    }
    return removed
  }

  private requireTable(): KvTable<string, UncertaintySignal> {
    if (this.signalTable === undefined) throw new Error('evolution uncertainty store is not started yet')
    return this.signalTable
  }
}

export default EvolutionUncertainty
