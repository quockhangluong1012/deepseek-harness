/**
 * Automatic curriculum (`ctx.evolutionCurriculum`): proposes training and
 * evaluation tasks from measured capability gaps — the most decisive failure
 * gists of each tracked skill — and keeps the proposals durable so a task
 * survives restarts and is retired only deliberately. Nothing here calls a
 * model: the gap evidence is the curriculum signal.
 * @module @deepseek-ai/dsh-evolution-curriculum
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type {} from '@deepseek-ai/dsh-evolution-trace'
import { deriveTasks } from './derive.ts'
import { curriculumDomainSpec } from './spec.ts'
import type { CurriculumGap, CurriculumProposal } from './types.ts'

export type * from './types.ts'
export { deriveTasks, TASK_GIST_LIMIT, TASK_TEXT_LIMIT } from './derive.ts'
export { curriculumDomainSpec, curriculumProposalRow } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Automatic curriculum proposing tasks from measured capability gaps. */
    evolutionCurriculum: EvolutionCurriculum
  }
}

/** Deployment choices for curriculum staging. */
export interface Config {
  /** Distinct failure gists a capability needs before a task is proposed. */
  minGists?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  minGists: z.number().step(1).min(1).default(1),
})

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  minGists: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const { minGists = 1 } = config
  return { minGists }
}

/**
 * Automatic curriculum over durable proposals. Opens the `evolution_curriculum`
 * domain at init and closes it through `ctx.effect`.
 */
export class EvolutionCurriculum extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, CurriculumProposal>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - minimum-evidence floor for a staged task.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionCurriculum')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(curriculumDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-curriculum.domainClose')
    this.table = domain.table('proposals')
  }

  /**
   * Measure current capability gaps from the mounted seams: for every tracked
   * skill with sessions, the distinct failure gists of its compressed trace
   * rows. Without either seam nothing is measured.
   * @returns the measured gaps, in caller order.
   */
  async gaps(): Promise<readonly CurriculumGap[]> {
    const telemetry = this.ctx.get('evolutionSkillTelemetry')
    const trace = this.ctx.get('evolutionTrace')
    if (telemetry === undefined || trace === undefined) return []
    const gaps: CurriculumGap[] = []
    for (const { name, usage } of telemetry.entries()) {
      if (usage.sessionIds.length === 0) continue
      const rows = await trace.summary(usage.sessionIds, 10)
      const gists = [...new Set(rows.flatMap(row => row.failureGists))]
      if (gists.length === 0) continue
      gaps.push({ capability: name, sourceSessions: [...usage.sessionIds], failureGists: gists })
    }
    return gaps
  }

  /**
   * Stage one task per gap that clears the evidence floor, skipping any
   * already-open proposal for the same capability and task. A capability with
   * no proposed task contributes nothing.
   * @param gaps - measured capability gaps, in caller order.
   * @returns the staged proposals.
   */
  async propose(gaps: readonly CurriculumGap[]): Promise<readonly CurriculumProposal[]> {
    const now = new Date().toISOString()
    const table = this.requireTable()
    const existing = new Set(
      [...table.entries()]
        .filter(([, row]) => row.state === 'open')
        .map(([, row]) => `${row.capability}${row.task}`),
    )
    const staged: CurriculumProposal[] = []
    for (const derived of deriveTasks(gaps)) {
      if (derived.gists.length < this.resolved.minGists) continue
      if (existing.has(`${derived.capability}${derived.task}`)) continue
      const proposal: CurriculumProposal = {
        id: randomUUID(),
        capability: derived.capability,
        task: derived.task,
        sourceSessions: [...derived.sourceSessions],
        gists: [...derived.gists],
        at: now,
        state: 'open',
      }
      await table.put(proposal.id, proposal)
      staged.push(proposal)
    }
    return staged
  }

  /**
   * List every staged proposal, open first then retired, each group newest
   * first.
   * @returns the proposals, detached from the store.
   */
  proposals(): readonly CurriculumProposal[] {
    const rows = [...this.requireTable().entries()].map(([, row]) => structuredClone(row))
    rows.sort((left, right) =>
      (left.state === 'retired' ? 1 : 0) - (right.state === 'retired' ? 1 : 0)
      || right.at.localeCompare(left.at)
      || left.capability.localeCompare(right.capability))
    return rows
  }

  /**
   * Retire one proposal; an absent id rejects loudly, and an already-retired
   * proposal resolves without writing.
   * @param id - proposal identity.
   * @returns the stored proposal after retirement.
   */
  async retire(id: string): Promise<CurriculumProposal> {
    const table = this.requireTable()
    const current = table.get(id)
    if (current === undefined) throw new Error(`evolution-curriculum: unknown proposal '${id}'`)
    if (current.state === 'retired') return structuredClone(current)
    const next = { ...current, state: 'retired' as const }
    await table.put(id, next)
    return structuredClone(next)
  }

  private requireTable(): KvTable<string, CurriculumProposal> {
    if (this.table === undefined) throw new Error('evolution curriculum is not started yet')
    return this.table
  }
}

export default EvolutionCurriculum
