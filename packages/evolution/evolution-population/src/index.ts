/**
 * Population-based evolution (`ctx.evolutionPopulation`): a durable store of
 * skill candidates — one per staged optimizer write — with generation
 * numbering, lineage, and the stage → approve/reject lifecycle (§51). Each
 * candidate records which mutation operator produced it, its measured triple,
 * and its novelty. Candidates are the raw material of competition: the elite
 * ranking (pass, then fewer tokens, then faster wall time) decides what a
 * skill keeps. Nothing here calls a model; the optimizer records candidates
 * through the optional recorder seam.
 * @module @deepseek-ai/dsh-evolution-population
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { headOf, lineageChain, nextGeneration, rankElite } from './population.ts'
import { populationDomainSpec } from './spec.ts'
import type { PopulationCandidate, PopulationRecordInput, PopulationStatus } from './types.ts'

export type * from './types.ts'
export { headOf, lineageChain, nextGeneration, rankElite } from './population.ts'
export { populationDomainSpec, populationCandidateRow } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Population store growing per-skill candidate lineages from optimizer writes. */
    evolutionPopulation: EvolutionPopulation
  }
}

/** Allowed status transitions; terminal statuses never leave. */
const STATUS_TRANSITIONS: Readonly<Record<PopulationStatus, readonly PopulationStatus[]>> = {
  staged: ['approved', 'rejected'],
  approved: [],
  rejected: [],
}

/**
 * Population store over durable candidates. Opens the `evolution_population`
 * domain at init and closes it through `ctx.effect`.
 */
export class EvolutionPopulation extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, PopulationCandidate>

  /**
   * @param ctx - host context carrying the storage domain.
   */
  constructor(ctx: Context) {
    super(ctx, 'evolutionPopulation')
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(populationDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-population.domainClose')
    this.table = domain.table('candidates')
  }

  /**
   * Record one candidate, auto-wiring lineage: the previous head of the same
   * skill becomes this candidate's parent, and the generation is one past the
   * skill's current highest. The head is the candidate with the highest
   * generation, newest tie first.
   * @param input - the candidate to record.
   * @returns the stored candidate.
   */
  async record(input: PopulationRecordInput): Promise<PopulationCandidate> {
    const table = this.requireTable()
    const rows = [...table.entries()].map(([, candidate]) => candidate)
    const head = headOf(rows, input.skill)
    const candidate: PopulationCandidate = {
      candidateId: input.candidateId,
      skill: input.skill,
      parentCandidateId: head?.candidateId ?? null,
      operator: input.operator,
      generation: nextGeneration(rows, input.skill),
      novelty: input.novelty,
      triple: input.triple === null ? null : { ...input.triple },
      status: input.status,
      at: new Date().toISOString(),
    }
    await table.put(candidate.candidateId, candidate)
    return structuredClone(candidate)
  }

  /**
   * List every candidate, optionally filtered by skill, newest first.
   * @param skill - optional skill filter.
   * @returns the candidates, detached from the store.
   */
  candidates(skill?: string): readonly PopulationCandidate[] {
    const rows = [...this.requireTable().entries()]
      .map(([, candidate]) => structuredClone(candidate))
      .filter(candidate => skill === undefined || candidate.skill === skill)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.candidateId.localeCompare(right.candidateId))
    return rows
  }

  /**
   * The current generation of a skill: the highest generation present, or 0
   * when the skill has no candidates yet.
   * @param skill - the skill to inspect.
   * @returns the skill's current generation.
   */
  generation(skill: string): number {
    const rows = [...this.requireTable().entries()]
      .map(([, candidate]) => candidate)
      .filter(candidate => candidate.skill === skill)
    return rows.reduce((max, candidate) => Math.max(max, candidate.generation), 0)
  }

  /**
   * The lineage of one candidate within a skill, oldest ancestor first. The
   * chain walks stored parent links; unknown ids yield an empty chain.
   * @param skill - the skill the candidate belongs to.
   * @param candidateId - the candidate to start from.
   * @returns the candidate and its ancestors, oldest first, detached.
   */
  lineage(skill: string, candidateId: string): readonly PopulationCandidate[] {
    const rows = [...this.requireTable().entries()]
      .map(([, candidate]) => structuredClone(candidate))
      .filter(candidate => candidate.skill === skill)
    return lineageChain(rows, candidateId)
  }

  /**
   * The current elite of a skill: approved candidates ranked by pass, then
   * fewer tokens, then faster wall time. Unmeasured candidates rank below every
   * measured one.
   * @param skill - the skill to rank.
   * @returns the approved candidates in elite order, detached.
   */
  elite(skill: string): readonly PopulationCandidate[] {
    const rows = [...this.requireTable().entries()]
      .map(([, candidate]) => structuredClone(candidate))
    return rankElite(rows, skill)
  }

  /**
   * Move one candidate to another status. A staged candidate may be approved or
   * rejected; approved and rejected are terminal. A same-status call resolves
   * without writing, and unknown ids or illegal transitions reject loudly.
   * @param candidateId - candidate identity.
   * @param status - requested status.
   * @returns the stored candidate after the transition.
   */
  async updateStatus(candidateId: string, status: PopulationStatus): Promise<PopulationCandidate> {
    const table = this.requireTable()
    const current = table.get(candidateId)
    if (current === undefined) throw new Error(`evolution-population: unknown candidate '${candidateId}'`)
    if (current.status === status) return structuredClone(current)
    if (!STATUS_TRANSITIONS[current.status].includes(status)) {
      throw new Error(`evolution-population: illegal transition ${current.status} → ${status} for '${candidateId}'`)
    }
    const next = { ...current, status }
    await table.put(candidateId, next)
    return structuredClone(next)
  }

  private requireTable(): KvTable<string, PopulationCandidate> {
    if (this.table === undefined) throw new Error('evolution population is not started yet')
    return this.table
  }
}

export default EvolutionPopulation
