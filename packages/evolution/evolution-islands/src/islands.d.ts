/**
 * Pure helpers for the island store: migration-due checks and the head island
 * of a skill. No I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-islands/src/islands
 */
import type { Island } from './types.ts';
/**
 * Whether a scheduled migration is due: the time since the island's last
 * migration — or since its registration when it never migrated — has reached
 * the migration cadence.
 * @param lastMigrationAt - the island's last migration instant, or null.
 * @param islandAt - the instant the island was registered.
 * @param now - the current instant.
 * @param cadenceMs - the migration cadence, in milliseconds.
 * @returns whether a scheduled migration is due.
 */
export declare function migrationDue(lastMigrationAt: string | null, islandAt: string, now: string, cadenceMs: number): boolean;
/**
 * The head island of a skill: the island with the newest registration. Yields
 * `undefined` when the skill has no islands. The head receives the next
 * recorded generation tick; equal registration instants keep the input order,
 * so a same-millisecond batch resolves to the island the caller sees first.
 * @param islands - the registered islands.
 * @param skill - the skill whose job advances.
 * @returns the head island, or undefined without one.
 */
export declare function headIsland(islands: readonly Island[], skill: string): Island | undefined;
//# sourceMappingURL=islands.d.ts.map