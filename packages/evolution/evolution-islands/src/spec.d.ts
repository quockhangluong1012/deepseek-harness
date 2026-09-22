/**
 * The evolution-islands domain declaration: durable islands and the migration
 * records between them. Zod validates the shipped format at the durability
 * boundary.
 * @module @deepseek-ai/dsh-evolution-islands/src/spec
 */
import { z } from 'zod';
import type { Island, Migration } from './types.ts';
/** Durable shape of one island. */
export declare const islandRow: z.ZodObject<{
    islandId: z.ZodString;
    name: z.ZodString;
    objective: z.ZodEnum<{
        conservative: "conservative";
        performance: "performance";
        cost: "cost";
        novelty: "novelty";
        adversarial: "adversarial";
    }>;
    skill: z.ZodString;
    generation: z.ZodNumber;
    lastActivityAt: z.ZodNullable<z.ZodString>;
    at: z.ZodString;
}, z.core.$strip>;
/** Durable shape of one migration record. */
export declare const migrationRow: z.ZodObject<{
    migrationId: z.ZodString;
    fromIslandId: z.ZodString;
    toIslandId: z.ZodString;
    candidateId: z.ZodString;
    skill: z.ZodString;
    reason: z.ZodEnum<{
        schedule: "schedule";
        elite: "elite";
        diversity: "diversity";
    }>;
    at: z.ZodString;
}, z.core.$strip>;
/** One stored island, inferred from {@link islandRow}. */
export type IslandRow = z.infer<typeof islandRow>;
/** One stored migration, inferred from {@link migrationRow}. */
export type MigrationRow = z.infer<typeof migrationRow>;
/**
 * The evolution-islands domain spec: an `islands` table keyed by island
 * identity and a `migrations` table keyed by migration identity.
 * `per-record` because both kinds of row are independent. Invalid rows fail
 * the domain open loudly: islands and migrations steer evolution direction.
 */
export declare const islandsDomainSpec: {
    name: string;
    version: number;
    layout: "per-record";
    tables: {
        islands: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, Island>;
        migrations: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, Migration>;
    };
};
//# sourceMappingURL=spec.d.ts.map