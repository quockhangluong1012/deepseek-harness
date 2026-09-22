/**
 * The evolution-islands domain declaration: durable islands and the migration
 * records between them. Zod validates the shipped format at the durability
 * boundary.
 * @module @deepseek-ai/dsh-evolution-islands/src/spec
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Island, Migration } from './types.ts'

/** Durable shape of one island. */
export const islandRow = z.object({
  islandId: z.string(),
  name: z.string(),
  objective: z.enum(['conservative', 'performance', 'cost', 'novelty', 'adversarial']),
  skill: z.string(),
  generation: z.number(),
  lastActivityAt: z.string().nullable(),
  at: z.string(),
})

/** Durable shape of one migration record. */
export const migrationRow = z.object({
  migrationId: z.string(),
  fromIslandId: z.string(),
  toIslandId: z.string(),
  candidateId: z.string(),
  skill: z.string(),
  reason: z.enum(['schedule', 'elite', 'diversity']),
  at: z.string(),
})

/** One stored island, inferred from {@link islandRow}. */
export type IslandRow = z.infer<typeof islandRow>

/** One stored migration, inferred from {@link migrationRow}. */
export type MigrationRow = z.infer<typeof migrationRow>

/**
 * The evolution-islands domain spec: an `islands` table keyed by island
 * identity and a `migrations` table keyed by migration identity.
 * `per-record` because both kinds of row are independent. Invalid rows fail
 * the domain open loudly: islands and migrations steer evolution direction.
 */
export const islandsDomainSpec = defineDomain({
  name: 'evolution_islands',
  version: 1,
  layout: 'per-record',
  tables: {
    islands: domainTable<string, Island>(islandRow),
    migrations: domainTable<string, Migration>(migrationRow),
  },
})
