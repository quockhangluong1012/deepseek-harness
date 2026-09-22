/**
 * Stagnation detection (`ctx.evolutionStagnation`): a durable per-skill log
 * of evaluation runs — one per staged optimizer write — that counts runs
 * without meaningful improvement and names the next strategy when a skill's
 * frontier stalls (§32). Improvement is measured against the skill's best
 * score with a configured relative-gain floor, so token or wall-time jitter
 * below the floor is not an improvement. Once a skill has stalled past the
 * configured threshold, the strategy ladder climbs from diversity over new
 * mutation operators, new tasks, and new evaluators, capped at switching the
 * model — this prevents silent evolutionary death. Nothing here calls a
 * model; the optimizer records runs through the optional recorder seam.
 * @module @deepseek-ai/dsh-evolution-stagnation
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { bestOf, betterThan, generationsSince, strategyFor } from './stagnation.ts'
import { stagnationDomainSpec } from './spec.ts'
import type { StagnationRun, StagnationRunInput, StagnationStatus } from './types.ts'

export type * from './types.ts'
export { betterThan, bestOf, generationsSince, strategyFor } from './stagnation.ts'
export { stagnationDomainSpec, stagnationRunRow } from './spec.ts'

/** Validated configuration of the stagnation detector. */
export interface StagnationConfig {
  /** Runs without meaningful improvement before the skill is stagnant. */
  threshold: number
  /** Minimum relative token or wall-time gain that counts as meaningful. */
  relativeImprovement: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Stagnation store growing per-skill evaluation runs from optimizer writes. */
    evolutionStagnation: EvolutionStagnation
  }
}

/**
 * Stagnation-detection store over durable runs. Opens the
 * `evolution_stagnation` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionStagnation extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the detector; defaults assume an ordinary cadence. */
  static Config = z.object({
    threshold: z.number().int().min(1).default(5),
    relativeImprovement: z.number().min(0).max(1).default(0.05),
  })

  /** Deployment choices of the stagnation detector. */
  readonly config: StagnationConfig

  private table?: KvTable<string, StagnationRun>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated detector choices.
   */
  constructor(ctx: Context, config: StagnationConfig) {
    super(ctx, 'evolutionStagnation')
    this.config = config
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(stagnationDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-stagnation.domainClose')
    this.table = domain.table('runs')
  }

  /**
   * Record one run, numbering its generation tick one past the skill's run
   * count and flagging whether it meaningfully improved the skill's best
   * score so far.
   * @param input - the run to record.
   * @returns the stored run.
   */
  async recordRun(input: StagnationRunInput): Promise<StagnationRun> {
    const table = this.requireTable()
    const prior = [...table.entries()]
      .map(([, run]) => run)
      .filter(run => run.skill === input.skill)
    const run: StagnationRun = {
      runId: input.runId,
      skill: input.skill,
      generation: prior.length + 1,
      score: { ...input.score },
      improved: betterThan(input.score, bestOf(prior, this.config.relativeImprovement), this.config.relativeImprovement),
      at: new Date().toISOString(),
    }
    await table.put(run.runId, run)
    return structuredClone(run)
  }

  /**
   * List every run, optionally filtered by skill, newest first.
   * @param skill - optional skill filter.
   * @returns the runs, detached from the store.
   */
  runs(skill?: string): readonly StagnationRun[] {
    const rows = [...this.requireTable().entries()]
      .map(([, run]) => structuredClone(run))
      .filter(run => skill === undefined || run.skill === skill)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.runId.localeCompare(right.runId))
    return rows
  }

  /**
   * The derived stagnation status of one skill: best score, runs since the
   * last meaningful improvement, the stagnant flag against the configured
   * threshold, and the strategy the skill should follow now. A skill with no
   * runs reports zero runs and normal exploitation.
   * @param skill - the skill to inspect.
   * @returns the stagnation status.
   */
  status(skill: string): StagnationStatus {
    const rows = [...this.requireTable().entries()]
      .map(([, run]) => structuredClone(run))
      .filter(run => run.skill === skill)
    rows.sort((left, right) => left.generation - right.generation)
    const since = generationsSince(rows)
    return {
      skill,
      runs: rows.length,
      bestScore: bestOf(rows, this.config.relativeImprovement),
      generationsSinceImprovement: since,
      stagnant: since >= this.config.threshold,
      threshold: this.config.threshold,
      strategy: strategyFor(since, this.config.threshold),
    }
  }

  /**
   * Drop every recorded run of one skill, returning the count removed. Used
   * when a task regime changes and the skill's history no longer applies.
   * @param skill - the skill to reset.
   * @returns the number of runs removed.
   */
  async reset(skill: string): Promise<number> {
    const table = this.requireTable()
    let removed = 0
    for (const [runId, run] of [...table.entries()]) {
      if (run.skill === skill) {
        await table.delete(runId)
        removed += 1
      }
    }
    return removed
  }

  private requireTable(): KvTable<string, StagnationRun> {
    if (this.table === undefined) throw new Error('evolution stagnation store is not started yet')
    return this.table
  }
}

export default EvolutionStagnation
