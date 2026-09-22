/**
 * Novelty search (`ctx.evolutionNovelty`): a durable per-skill archive of
 * behavior descriptors — one entry per staged optimizer write — that measures
 * each new descriptor's novelty against everything the skill has seen before
 * (§31). Novelty is one minus the maximum Jaccard similarity to any archived
 * entry, so a candidate that restates known instructions is not novel while
 * one carrying new material is. The archive rewards meaningfully different
 * candidates: selection that blends fitness and novelty keeps the skill from
 * converging on the first "pretty good" body. Nothing here calls a model; the
 * optimizer records candidates through the optional recorder seam.
 * @module @deepseek-ai/dsh-evolution-novelty-search
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { archiveNovelty, noveltyMean } from './novelty.ts'
import { noveltyDomainSpec } from './spec.ts'
import type { NoveltyArchiveEntry, NoveltyArchiveInput } from './types.ts'

export type * from './types.ts'
export { archiveNovelty, noveltyMean, similarity } from './novelty.ts'
export { noveltyArchiveEntryRow, noveltyDomainSpec } from './spec.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Novelty archive growing per-skill behavior descriptors from optimizer writes. */
    evolutionNovelty: EvolutionNovelty
  }
}

/**
 * Novelty-search store over the durable archive. Opens the `evolution_novelty`
 * domain at init and closes it through `ctx.effect`.
 */
export class EvolutionNovelty extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, NoveltyArchiveEntry>

  /**
   * @param ctx - host context carrying the storage domain.
   */
  constructor(ctx: Context) {
    super(ctx, 'evolutionNovelty')
  }

  /** Open the domain and publish the table handle. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(noveltyDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-novelty-search.domainClose')
    this.table = domain.table('archive')
  }

  /**
   * Record one descriptor, measuring its novelty against the skill's archive
   * excluding the descriptor itself, so re-recording a candidate keeps its
   * original novelty instead of degrading to zero. One entry per staged write:
   * the archive is keyed by candidate identity.
   * @param input - the descriptor to archive.
   * @returns the stored entry with its measured novelty.
   */
  async record(input: NoveltyArchiveInput): Promise<NoveltyArchiveEntry> {
    const table = this.requireTable()
    const seen = [...table.entries()]
      .map(([, entry]) => entry)
      .filter(entry => entry.skill === input.skill && entry.candidateId !== input.candidateId)
    const entry: NoveltyArchiveEntry = {
      candidateId: input.candidateId,
      skill: input.skill,
      features: [...input.features],
      novelty: archiveNovelty(input.features, seen),
      at: new Date().toISOString(),
    }
    await table.put(entry.candidateId, entry)
    return structuredClone(entry)
  }

  /**
   * List every archive entry, optionally filtered by skill, newest first.
   * @param skill - optional skill filter.
   * @returns the entries, detached from the store.
   */
  entries(skill?: string): readonly NoveltyArchiveEntry[] {
    const rows = [...this.requireTable().entries()]
      .map(([, entry]) => structuredClone(entry))
      .filter(entry => skill === undefined || entry.skill === skill)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.candidateId.localeCompare(right.candidateId))
    return rows
  }

  /**
   * Mean archive novelty of one skill, in 0..1, or zero when the skill has no
   * entries. A falling mean is the frontier-stagnation signal the command
   * plane renders.
   * @param skill - the skill to summarize.
   * @returns the skill's mean archive novelty.
   */
  mean(skill: string): number {
    const rows = [...this.requireTable().entries()]
      .map(([, entry]) => entry)
      .filter(entry => entry.skill === skill)
    return noveltyMean(rows)
  }

  private requireTable(): KvTable<string, NoveltyArchiveEntry> {
    if (this.table === undefined) throw new Error('evolution novelty archive is not started yet')
    return this.table
  }
}

export default EvolutionNovelty
