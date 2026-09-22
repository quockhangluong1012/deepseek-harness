/**
 * Evaluator ensemble health (`ctx.evolutionEvaluatorHealth`): durable recorded
 * behavior-evaluation verdicts and the aggregated health facts — per-channel
 * approval, unanimous agreement, approval-rate drift, and false positives —
 * that tell whether the evaluator itself is drifting or being gamed (§13,
 * §46). Nothing here calls a model; the scorer's behavior evaluation records
 * into it.
 * @module @deepseek-ai/dsh-evolution-evaluator-health
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { evaluatorHealthDomainSpec } from './spec.ts'
import { judgeCalibration, summarizeHealth } from './stats.ts'
import type { EvaluatorHealthSummary, EvaluatorRun, EvaluatorRunInput, JudgeCalibration, RunJudgmentInput } from './types.ts'

export type * from './types.ts'
export { channelHealth, judgeCalibration, summarizeHealth } from './stats.ts'
export { evaluatorHealthDomainSpec, evaluatorRunRow } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Evaluator ensemble health over recorded behavior-evaluation verdicts. */
    evolutionEvaluatorHealth: EvolutionEvaluatorHealth
  }
}

/** Deployment choices for health aggregation. */
export interface Config {
  /** Verdicts the recent-drift window covers. */
  driftWindow?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  driftWindow: z.number().step(1).min(1).default(20),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  driftWindow: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const { driftWindow = 20 } = config
  return { driftWindow }
}

/**
 * Evaluator ensemble health over durable verdicts. Opens the
 * `evolution_evaluator_health` domain at init and closes it through
 * `ctx.effect`.
 */
export class EvolutionEvaluatorHealth extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, EvaluatorRun>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - drift-window choice.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionEvaluatorHealth')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(evaluatorHealthDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-evaluator-health.domainClose')
    this.table = domain.table('runs')
  }

  /**
   * Record one behavior-evaluation verdict. A skipped evaluation has no
   * judgment and rejects loudly.
   * @param input - the verdict to record.
   * @returns the stored run.
   */
  async observe(input: EvaluatorRunInput): Promise<EvaluatorRun> {
    if (input.status === 'skipped') {
      throw new Error('evolution-evaluator-health: a skipped evaluation records no health verdict')
    }
    const run: EvaluatorRun = {
      id: randomUUID(),
      skill: input.skill,
      unanimous: input.unanimous,
      status: input.status,
      approved: input.approved,
      approving: [...input.approving],
      dissenting: [...input.dissenting],
      at: new Date().toISOString(),
    }
    await this.requireTable().put(run.id, run)
    return structuredClone(run)
  }

  /**
   * List recorded verdicts, newest first, optionally for one skill.
   * @param skill - optional skill filter.
   * @returns the runs, detached from the store.
   */
  runs(skill?: string): readonly EvaluatorRun[] {
    const rows = [...this.requireTable().entries()]
      .map(([, run]) => structuredClone(run))
      .filter(run => skill === undefined || run.skill === skill)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.id.localeCompare(right.id))
    return rows
  }

  /**
   * Summarize evaluator health over every recorded verdict.
   * @returns the aggregated health facts.
   */
  summary(): EvaluatorHealthSummary {
    return summarizeHealth(this.runs(), this.resolved.driftWindow)
  }

  /**
   * Record the later ground truth that judged one verdict (§13): whether it
   * agreed with the evaluator, and whether it was measured independently. An
   * unknown verdict identity rejects loudly, so a ground truth is never
   * attached to a verdict that does not exist.
   * @param runId - the recorded verdict being judged.
   * @param judgment - the ground truth's reading.
   * @returns the updated verdict.
   */
  async judge(runId: string, judgment: RunJudgmentInput): Promise<EvaluatorRun> {
    const table = this.requireTable()
    const current = table.get(runId)
    if (current === undefined) {
      throw new Error(`evolution-evaluator-health: unknown verdict '${runId}'`)
    }
    const next: EvaluatorRun = {
      ...current,
      judgment: { agrees: judgment.agrees, independent: judgment.independent, at: new Date().toISOString() },
    }
    await table.put(runId, next)
    return structuredClone(next)
  }

  /**
   * The calibration facts of the recorded verdicts (§13): the false-negative
   * rate beside the summary's false-positive rate, and how the evaluator
   * correlates with the independent ground truths that later judged it.
   * @returns the calibration facts.
   */
  calibration(): JudgeCalibration {
    return judgeCalibration(this.runs())
  }

  private requireTable(): KvTable<string, EvaluatorRun> {
    if (this.table === undefined) throw new Error('evolution evaluator health is not started yet')
    return this.table
  }
}

export default EvolutionEvaluatorHealth
