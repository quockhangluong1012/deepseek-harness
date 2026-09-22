/**
 * Dependency-aware evolution (`ctx.evolutionLineage`): a durable log of
 * dependency-versioned experiment envelopes — one per evaluated candidate —
 * with comparability checks and ablation attribution (§34). Every result
 * records the dependency versions it ran under, so a metric comparison is
 * provably apples-to-apples: two envelopes compare only when none of the
 * configured compared keys changed between them. Ablation attribution says
 * which change caused an improvement (§36), and every envelope carries the
 * seeds it ran, so any experiment replays from its record (§48).
 * Comparisons are recorded facts, never gates: nothing here permits or
 * refuses an optimization (§58.12). Nothing here calls a model; the
 * optimizer records envelopes through the optional recorder seam.
 * @module @deepseek-ai/dsh-evolution-lineage
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { changedDependencies, DEPENDENCY_KEYS } from './lineage.ts'
import { lineageDomainSpec } from './spec.ts'
import type { DependencyKey, ExperimentComparison, ExperimentEnvelope, ExperimentInput } from './types.ts'

export type * from './types.ts'
export { changedDependencies, comparable, attributeImprovement, DEPENDENCY_KEYS } from './lineage.ts'
export { lineageDomainSpec, experimentEnvelopeRow } from './spec.ts'

/** Validated configuration of the lineage store. */
export interface LineageConfig {
  /** Dependency keys two envelopes must agree on to compare. */
  comparedKeys: DependencyKey[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Lineage store growing dependency-versioned experiment envelopes. */
    evolutionLineage: EvolutionLineage
  }
}

/**
 * Dependency-aware lineage store over durable experiment envelopes. Opens
 * the `evolution_lineage` domain at init and closes it through
 * `ctx.effect`.
 */
export class EvolutionLineage extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the store; defaults compare the skill, evaluator, retriever, and model. */
  static Config = z.object({
    comparedKeys: z.array(z.enum(DEPENDENCY_KEYS)).min(1).default(['skill', 'evaluator', 'retriever', 'model']),
  })

  /** Deployment choices of the lineage store. */
  readonly config: LineageConfig

  private experimentTable?: KvTable<string, ExperimentEnvelope>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated store choices.
   */
  constructor(ctx: Context, config: LineageConfig) {
    super(ctx, 'evolutionLineage')
    this.config = config
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(lineageDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-lineage.domainClose')
    this.experimentTable = domain.table('experiments')
  }

  /**
   * Record one experiment envelope, stamping its recording instant.
   * @param input - the experiment to record.
   * @returns the stored envelope.
   */
  async record(input: ExperimentInput): Promise<ExperimentEnvelope> {
    const table = this.requireTable()
    const envelope: ExperimentEnvelope = {
      experimentId: input.experimentId,
      skill: input.skill,
      hypothesis: input.hypothesis,
      candidate: input.candidate,
      operator: input.operator,
      tasks: [...input.tasks],
      metrics: { ...input.metrics },
      outcome: input.outcome,
      regressions: [...input.regressions],
      rejectedReason: input.rejectedReason,
      lessons: input.lessons,
      dependencies: { ...input.dependencies },
      seeds: [...input.seeds],
      at: new Date().toISOString(),
    }
    await table.put(envelope.experimentId, envelope)
    return structuredClone(envelope)
  }

  /**
   * List every envelope, optionally filtered by skill, newest first.
   * @param skill - optional skill filter.
   * @returns the envelopes, detached from the store.
   */
  experiments(skill?: string): readonly ExperimentEnvelope[] {
    const rows = [...this.requireTable().entries()]
      .map(([, envelope]) => structuredClone(envelope))
      .filter(envelope => skill === undefined || envelope.skill === skill)
    rows.sort(
      (left, right) => right.at.localeCompare(left.at) || left.experimentId.localeCompare(right.experimentId),
    )
    return rows
  }

  /**
   * Read one envelope by identity, detached from the store.
   * @param id - the experiment identity.
   * @returns the envelope, or undefined when unknown.
   */
  envelope(id: string): ExperimentEnvelope | undefined {
    const found = this.requireTable().get(id)
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * Compare two envelopes over the configured compared keys: comparable
   * exactly when none of those keys changed versions between them.
   * @param idA - the first experiment identity.
   * @param idB - the second experiment identity.
   * @returns the comparability verdict, or undefined when either id is unknown.
   */
  compare(idA: string, idB: string): ExperimentComparison | undefined {
    const table = this.requireTable()
    const a = table.get(idA)
    const b = table.get(idB)
    if (a === undefined || b === undefined) return undefined
    const changed = changedDependencies(a.dependencies, b.dependencies, this.config.comparedKeys)
    return { comparable: changed.length === 0, changed }
  }

  /**
   * Replay one experiment from its record: the envelope carries the seeds
   * it ran, so the run is reproducible from what this returns (§48).
   * @param id - the experiment identity.
   * @returns the envelope, detached, or undefined when unknown.
   */
  replay(id: string): ExperimentEnvelope | undefined {
    const found = this.requireTable().get(id)
    return found === undefined ? undefined : structuredClone(found)
  }

  private requireTable(): KvTable<string, ExperimentEnvelope> {
    if (this.experimentTable === undefined) throw new Error('evolution lineage store is not started yet')
    return this.experimentTable
  }
}

export default EvolutionLineage
