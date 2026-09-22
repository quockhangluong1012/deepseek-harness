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
import { Context, Service } from '@deepseek-ai/cordis';
import z from 'zod';
import type { Island, IslandInput, IslandObjective, IslandSchedule, Migration, MigrationInput } from './types.ts';
export type * from './types.ts';
export { headIsland, migrationDue } from './islands.ts';
export { islandRow, islandsDomainSpec, migrationRow } from './spec.ts';
/** The five §7 island objectives, in canonical order. */
export declare const ISLAND_OBJECTIVES: readonly IslandObjective[];
/** Validated configuration of the island store. */
export interface IslandsConfig {
    /** Scheduled-migration cadence, in milliseconds. */
    migrationCadence: number;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Island store growing per-skill evolution lanes and migration records. */
        evolutionIslands: EvolutionIslands;
    }
}
/**
 * Island store over durable islands and migrations. Opens the
 * `evolution_islands` domain at init and closes it through `ctx.effect`.
 */
export declare class EvolutionIslands extends Service {
    static inject: string[];
    /** Deployment choices of the island schedule; the default is one day. */
    static Config: z.ZodObject<{
        migrationCadence: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>;
    /** Deployment choices of the island schedule. */
    readonly config: IslandsConfig;
    private islandTable?;
    private migrationTable?;
    /**
     * @param ctx - host context carrying the storage domain.
     * @param config - validated island choices.
     */
    constructor(ctx: Context, config: IslandsConfig);
    /** Open the domain and publish the table handles. */
    protected [Service.init](): Promise<void>;
    /**
     * Register one island for a skill's evolution job. A duplicate island id
     * rejects loudly: an island is a durable lane, not a replaceable row.
     * @param input - the island to register.
     * @returns the stored island.
     */
    register(input: IslandInput): Promise<Island>;
    /**
     * Record one generation tick for a skill's evolution job: the head island
     * of the skill — the newest registered — advances its generation and
     * last-activity instant. Returns `undefined` when the skill has no island
     * yet, so the optimizer seam stays a no-op until an operator registers one.
     * @param skill - the skill whose job advances.
     * @returns the advanced island, or undefined without one.
     */
    advance(skill: string): Promise<Island | undefined>;
    /**
     * Record one migration between two islands. Both islands must exist, and
     * they must serve the same skill — a candidate migrating across jobs is
     * meaningless. The migration is keyed by a fresh identity, so a candidate
     * may migrate repeatedly and every move stays on record.
     * @param input - the migration to record.
     * @returns the stored migration.
     */
    migrate(input: MigrationInput): Promise<Migration>;
    /**
     * List every island, optionally filtered by skill, newest registration
     * first.
     * @param skill - optional skill filter.
     * @returns the islands, detached from the store.
     */
    islands(skill?: string): readonly Island[];
    /**
     * List every migration, optionally filtered by skill, newest first.
     * @param skill - optional skill filter.
     * @returns the migrations, detached from the store.
     */
    migrations(skill?: string): readonly Migration[];
    /**
     * The schedule view of every island (optionally per skill): each island
     * with its last migration instant and whether a scheduled migration is due
     * under the configured cadence, ordered by island id for a stable render.
     * @param skill - optional skill filter.
     * @returns the schedule rows, detached from the store.
     */
    schedule(skill?: string): readonly IslandSchedule[];
    private requireIslands;
    private requireMigrations;
}
export default EvolutionIslands;
//# sourceMappingURL=index.d.ts.map