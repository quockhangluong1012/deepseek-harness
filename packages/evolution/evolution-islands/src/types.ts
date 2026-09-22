/**
 * Public type vocabulary of the island-evolution store: durable per-skill
 * evolution lanes, each with one of §7's objectives, plus the migration
 * records that move candidates between islands and the schedule view that
 * flags migrations due on a cadence. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-islands/src/types
 */

/** The five §7 island objectives. */
export type IslandObjective =
  | 'conservative'
  | 'performance'
  | 'cost'
  | 'novelty'
  | 'adversarial'

/** Why a candidate migrated between islands. */
export type MigrationReason = 'schedule' | 'elite' | 'diversity'

/** One durable island. */
export interface Island {
  /** Island identity. */
  islandId: string
  /** Human-readable island name. */
  name: string
  /** The objective the island's evolution lane optimizes. */
  objective: IslandObjective
  /** Skill whose evolution job the island belongs to. */
  skill: string
  /** Generation ticks recorded for the island, starting at 0. */
  generation: number
  /** ISO-8601 instant of the island's last recorded activity, or null. */
  lastActivityAt: string | null
  /** ISO-8601 instant the island was registered. */
  at: string
}

/** One island offered for registration. */
export interface IslandInput {
  /** Island identity. */
  islandId: string
  /** Human-readable island name. */
  name: string
  /** The objective the island's evolution lane optimizes. */
  objective: IslandObjective
  /** Skill whose evolution job the island belongs to. */
  skill: string
}

/** One durable migration record. */
export interface Migration {
  /** Migration identity. */
  migrationId: string
  /** Island the candidate left. */
  fromIslandId: string
  /** Island the candidate entered. */
  toIslandId: string
  /** Candidate that migrated. */
  candidateId: string
  /** Skill the migration belongs to (both islands' skill). */
  skill: string
  /** Why the candidate migrated. */
  reason: MigrationReason
  /** ISO-8601 instant the migration was recorded. */
  at: string
}

/** One migration offered for recording. */
export interface MigrationInput {
  /** Island the candidate left. */
  fromIslandId: string
  /** Island the candidate entered. */
  toIslandId: string
  /** Candidate that migrated. */
  candidateId: string
  /** Why the candidate migrated. */
  reason: MigrationReason
}

/** One island's schedule view: its due flag on the migration cadence. */
export interface IslandSchedule {
  /** The island itself. */
  island: Island
  /** The island's last migration instant, or null when none exists. */
  lastMigrationAt: string | null
  /** Whether a scheduled migration is due now. */
  due: boolean
}
