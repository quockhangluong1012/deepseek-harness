/**
 * Island evolution (`ctx.evolutionIslands`): durable per-skill evolution
 * lanes, each carrying one of §7's objectives — conservative, performance,
 * cost, novelty, adversarial — plus the migration records that move
 * candidates between islands and the schedule view that flags migrations due
 * on a cadence (§7). Islands preserve diversity: without them the harness
 * converges on the first "pretty good" skill and stops discovering
 * alternatives. The optimizer advances an island's generation tick through
 * the optional recorder seam; operators register islands, record migrations,
 * and read the schedule through `/islands`. Nothing here calls a model.
 * @module @deepseek-ai/dsh-evolution-islands
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import z from 'zod'
import { headIsland, migrationDue } from './islands.ts'
import { islandsDomainSpec } from './spec.ts'
import type { Island, IslandInput, IslandObjective, IslandSchedule, Migration, MigrationInput } from './types.ts'

export type * from './types.ts'
export { headIsland, migrationDue } from './islands.ts'
export { islandRow, islandsDomainSpec, migrationRow } from './spec.ts'

/** The five §7 island objectives, in canonical order. */
export const ISLAND_OBJECTIVES: readonly IslandObjective[] = ['conservative', 'performance', 'cost', 'novelty', 'adversarial']

/** Deployment choices of the island schedule; an omitted field takes its default. */
export interface Config {
  /** Scheduled-migration cadence, in milliseconds; default one day. */
  migrationCadence?: number
}

/** Normalized configuration used by the store. */
export interface ResolvedConfig {
  /** Scheduled-migration cadence, in milliseconds. */
  migrationCadence: number
}

/**
 * Resolve defaults for the optional fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { migrationCadence = 86_400_000 } = config
  return { migrationCadence }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Island store growing per-skill evolution lanes and migration records. */
    evolutionIslands: EvolutionIslands
  }
}

/**
 * Island store over durable islands and migrations. Opens the
 * `evolution_islands` domain at init and closes it through `ctx.effect`.
 */
export class EvolutionIslands extends Service {
  static inject = ['storageDomain']

  /** Deployment choices of the island schedule; the default is one day. */
  static Config = z.object({
    migrationCadence: z.number().int().min(1).default(86_400_000),
  })

  private islandTable?: KvTable<string, Island>
  private migrationTable?: KvTable<string, Migration>
  private readonly resolved: ResolvedConfig

  /**
   * @param ctx - host context carrying the storage domain.
   * @param config - the island schedule's migration cadence.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionIslands')
    this.resolved = resolveConfig(config)
  }

  /** Open the domain and publish the table handles. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(islandsDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-islands.domainClose')
    this.islandTable = domain.table('islands')
    this.migrationTable = domain.table('migrations')
  }

  /**
   * Register one island for a skill's evolution job. A duplicate island id
   * rejects loudly: an island is a durable lane, not a replaceable row.
   * @param input - the island to register.
   * @returns the stored island.
   */
  async register(input: IslandInput): Promise<Island> {
    const table = this.requireIslands()
    if (table.get(input.islandId) !== undefined) {
      throw new Error(`evolution-islands: island '${input.islandId}' already exists`)
    }
    const island: Island = {
      islandId: input.islandId,
      name: input.name,
      objective: input.objective,
      skill: input.skill,
      generation: 0,
      lastActivityAt: null,
      at: new Date().toISOString(),
    }
    await table.put(island.islandId, island)
    return structuredClone(island)
  }

  /**
   * Record one generation tick for a skill's evolution job: the head island
   * of the skill — the newest registered — advances its generation and
   * last-activity instant. Returns `undefined` when the skill has no island
   * yet, so the optimizer seam stays a no-op until an operator registers one.
   * @param skill - the skill whose job advances.
   * @returns the advanced island, or undefined without one.
   */
  async advance(skill: string): Promise<Island | undefined> {
    const table = this.requireIslands()
    const head = headIsland([...table.entries()].map(([, island]) => island), skill)
    if (head === undefined) return undefined
    const next: Island = {
      ...head,
      generation: head.generation + 1,
      lastActivityAt: new Date().toISOString(),
    }
    await table.put(next.islandId, next)
    return structuredClone(next)
  }

  /**
   * Record one migration between two islands. Both islands must exist, and
   * they must serve the same skill — a candidate migrating across jobs is
   * meaningless. The migration is keyed by a fresh identity, so a candidate
   * may migrate repeatedly and every move stays on record.
   * @param input - the migration to record.
   * @returns the stored migration.
   */
  async migrate(input: MigrationInput): Promise<Migration> {
    const islands = this.requireIslands()
    const from = islands.get(input.fromIslandId)
    if (from === undefined) {
      throw new Error(`evolution-islands: unknown island '${input.fromIslandId}'`)
    }
    const to = islands.get(input.toIslandId)
    if (to === undefined) {
      throw new Error(`evolution-islands: unknown island '${input.toIslandId}'`)
    }
    if (from.skill !== to.skill) {
      throw new Error(`evolution-islands: islands '${input.fromIslandId}' and '${input.toIslandId}' serve different skills`)
    }
    const migration: Migration = {
      migrationId: randomUUID(),
      fromIslandId: input.fromIslandId,
      toIslandId: input.toIslandId,
      candidateId: input.candidateId,
      skill: from.skill,
      reason: input.reason,
      at: new Date().toISOString(),
    }
    await this.requireMigrations().put(migration.migrationId, migration)
    return structuredClone(migration)
  }

  /**
   * List every island, optionally filtered by skill, newest registration
   * first.
   * @param skill - optional skill filter.
   * @returns the islands, detached from the store.
   */
  islands(skill?: string): readonly Island[] {
    const rows = [...this.requireIslands().entries()]
      .map(([, island]) => structuredClone(island))
      .filter(island => skill === undefined || island.skill === skill)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.islandId.localeCompare(right.islandId))
    return rows
  }

  /**
   * List every migration, optionally filtered by skill, newest first.
   * @param skill - optional skill filter.
   * @returns the migrations, detached from the store.
   */
  migrations(skill?: string): readonly Migration[] {
    const rows = [...this.requireMigrations().entries()]
      .map(([, migration]) => structuredClone(migration))
      .filter(migration => skill === undefined || migration.skill === skill)
    rows.sort((left, right) => right.at.localeCompare(left.at) || left.migrationId.localeCompare(right.migrationId))
    return rows
  }

  /**
   * The schedule view of every island (optionally per skill): each island
   * with its last migration instant and whether a scheduled migration is due
   * under the configured cadence, ordered by island id for a stable render.
   * @param skill - optional skill filter.
   * @returns the schedule rows, detached from the store.
   */
  schedule(skill?: string): readonly IslandSchedule[] {
    const migrations = this.migrations()
    const now = new Date().toISOString()
    return this.islands(skill)
      .slice()
      .sort((left, right) => left.islandId.localeCompare(right.islandId))
      .map((island) => {
        const lastMigrationAt = migrations
          .filter(migration => migration.fromIslandId === island.islandId || migration.toIslandId === island.islandId)
          .map(migration => migration.at)
          .sort((left, right) => right.localeCompare(left))[0] ?? null
        return {
          island,
          lastMigrationAt,
          due: migrationDue(lastMigrationAt, island.at, now, this.resolved.migrationCadence),
        }
      })
  }

  private requireIslands(): KvTable<string, Island> {
    if (this.islandTable === undefined) throw new Error('evolution islands store is not started yet')
    return this.islandTable
  }

  private requireMigrations(): KvTable<string, Migration> {
    if (this.migrationTable === undefined) throw new Error('evolution islands store is not started yet')
    return this.migrationTable
  }
}

export default EvolutionIslands
