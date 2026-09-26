/**
 * Dependency-aware evolution (`ctx.evolutionLineage`): a durable log of
 * dependency-versioned experiment envelopes — one per evaluated candidate —
 * with comparability checks and ablation attribution (§34), plus a linear
 * revision chain per policy and the diff between consecutive revisions
 * (§14.5 policy versioning). Every result records the dependency versions it
 * ran under, so a metric comparison is provably apples-to-apples: two
 * envelopes compare only when none of the configured compared keys changed
 * between them. Ablation attribution says which change caused an improvement
 * (§36), and every envelope carries the seeds it ran, so any experiment
 * replays from its record (§48).
 * Comparisons are recorded facts, never gates: nothing here permits or
 * refuses an optimization (§58.12). Nothing here calls a model; the
 * optimizer records envelopes through the optional recorder seam.
 * @module @deepseek-ai/dsh-evolution-lineage
 */

import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { changedDependencies, DEPENDENCY_KEYS, lineDiff, revisionKey } from './lineage.ts'
import { lineageDomainSpec } from './spec.ts'
import type {
  DependencyKey,
  ExperimentComparison,
  ExperimentEnvelope,
  ExperimentInput,
  ExperimentOutcome,
  PolicyRevision,
  PolicyRevisionInput,
} from './types.ts'

export type * from './types.ts'
export { changedDependencies, comparable, attributeImprovement, DEPENDENCY_KEYS, lineDiff, revisionKey } from './lineage.ts'
export { lineageDomainSpec, experimentEnvelopeRow, policyRevisionRow } from './spec.ts'

/** Deployment choices of the lineage store; an omitted field takes its default. */
export interface Config {
  /** Dependency keys two envelopes must agree on to compare; defaults to the skill, evaluator, retriever, and model. */
  comparedKeys?: DependencyKey[]
}

/** Validated deployment choices, every default applied. */
export interface ResolvedConfig {
  /** Dependency keys two envelopes must agree on to compare. */
  comparedKeys: DependencyKey[]
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { comparedKeys = ['skill', 'evaluator', 'retriever', 'model'] } = config
  return { comparedKeys }
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

  private readonly resolved: ResolvedConfig

  private experimentTable?: KvTable<string, ExperimentEnvelope>

  private revisionTable?: KvTable<string, PolicyRevision>

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - validated store choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionLineage')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish both table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(lineageDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-lineage.domainClose')
    this.experimentTable = domain.table('experiments')
    this.revisionTable = domain.table('revisions')
  }

  /**
   * Record one experiment envelope, stamping its recording instant.
   * @param input - the experiment to record.
   * @returns the stored envelope.
   */
  async record(input: ExperimentInput): Promise<ExperimentEnvelope> {
    const table = this.requireExperimentTable()
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
   * Amend the recorded outcome of an existing envelope. A deployment's real
   * outcome is not known at proposal time — the optimizer stamps a measured
   * verdict when it records the envelope, but whether the candidate is later
   * rolled back or rejected is an operator decision that happens afterward.
   * This keeps the recorded fact truthful once that decision lands, without
   * refusing or gating anything the operator does (§58.12: recorded, never
   * enforced).
   * @param id - the experiment identity.
   * @param outcome - the outcome to record in place of the measured verdict.
   * @param rejectedReason - why the outcome changed, when the caller has one.
   * @returns the amended envelope.
   * @throws when the experiment identity is unknown.
   */
  async amendOutcome(id: string, outcome: ExperimentOutcome, rejectedReason?: string): Promise<ExperimentEnvelope> {
    const table = this.requireExperimentTable()
    const current = table.get(id)
    if (current === undefined) throw new Error(`evolution-lineage: unknown experiment '${id}'`)
    const next: ExperimentEnvelope = {
      ...current,
      outcome,
      ...rejectedReason === undefined ? {} : { rejectedReason },
    }
    await table.put(id, next)
    return structuredClone(next)
  }

  /**
   * List every envelope, optionally filtered by skill, newest first.
   * @param skill - optional skill filter.
   * @returns the envelopes, detached from the store.
   */
  experiments(skill?: string): readonly ExperimentEnvelope[] {
    const rows = [...this.requireExperimentTable().entries()]
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
    const found = this.requireExperimentTable().get(id)
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
    const table = this.requireExperimentTable()
    const a = table.get(idA)
    const b = table.get(idB)
    if (a === undefined || b === undefined) return undefined
    const changed = changedDependencies(a.dependencies, b.dependencies, this.resolved.comparedKeys)
    return { comparable: changed.length === 0, changed }
  }

  /**
   * Replay one experiment from its record: the envelope carries the seeds
   * it ran, so the run is reproducible from what this returns (§48).
   * @param id - the experiment identity.
   * @returns the envelope, detached, or undefined when unknown.
   */
  replay(id: string): ExperimentEnvelope | undefined {
    const found = this.requireExperimentTable().get(id)
    return found === undefined ? undefined : structuredClone(found)
  }

  /**
   * Record one policy revision. The store assigns the next version number,
   * hashes the body, and diffs it against the revision it replaces, so a
   * policy's history is versioned, diffable, reproducible, and reversible from
   * the stored bodies (§14.5) without trusting the caller for any of it. The
   * same bytes as the chain's head is a no-op: re-recording the current body
   * would add a version that changed nothing. Committing an older revision's
   * bytes is a real revision, so a revert lands as a new version rather than
   * rewriting history.
   * @param input - the policy identity, its body, and the benchmark it was measured under.
   * @returns the stored revision, or the recorded head when the body is unchanged.
   */
  async recordRevision(input: PolicyRevisionInput): Promise<PolicyRevision> {
    const table = this.requireRevisionTable()
    const head = this.headRevision(input.policy)
    const digest = createHash('sha256').update(input.body, 'utf8').digest('hex')
    if (head !== undefined && head.digest === digest) return structuredClone(head)
    const revision: PolicyRevision = {
      policy: input.policy,
      version: head === undefined ? 1 : head.version + 1,
      digest,
      parentDigest: head?.digest ?? null,
      diff: head === undefined ? { addedLines: 0, removedLines: 0 } : lineDiff(head.body, input.body),
      ...input.benchmark === undefined ? {} : { benchmark: input.benchmark },
      body: input.body,
      at: new Date().toISOString(),
    }
    await table.put(revisionKey(revision.policy, revision.version), revision)
    return structuredClone(revision)
  }

  /**
   * List one policy's committed revisions, oldest first: the whole chain, in
   * the order it was committed, with each revision's body so a reader can diff
   * or restore any pair without reading the file the body came from.
   * @param policy - policy identity.
   * @returns the detached revisions, oldest first; empty when the policy has none.
   */
  revisions(policy: string): readonly PolicyRevision[] {
    return [...this.requireRevisionTable().entries()]
      .map(([, row]) => row)
      .filter(row => row.policy === policy)
      .sort((left, right) => left.version - right.version)
      .map(row => structuredClone(row))
  }

  /**
   * The newest revision committed for one policy, undetached for internal use.
   * @param policy - policy identity.
   * @returns the head revision, or undefined for a policy with no history.
   */
  private headRevision(policy: string): PolicyRevision | undefined {
    let head: PolicyRevision | undefined
    for (const [, row] of this.requireRevisionTable().entries()) {
      if (row.policy !== policy) continue
      if (head === undefined || row.version > head.version) head = row
    }
    return head
  }

  /**
   * Read the open experiment table.
   * @returns the experiments table.
   * @throws when the domain was never opened.
   */
  private requireExperimentTable(): KvTable<string, ExperimentEnvelope> {
    const table = this.experimentTable
    if (table === undefined) throw new Error('evolution lineage store is not started yet')
    return table
  }

  /**
   * Read the open revision table.
   * @returns the revisions table.
   * @throws when the domain was never opened.
   */
  private requireRevisionTable(): KvTable<string, PolicyRevision> {
    const table = this.revisionTable
    if (table === undefined) throw new Error('evolution lineage store is not started yet')
    return table
  }
}

export default EvolutionLineage
