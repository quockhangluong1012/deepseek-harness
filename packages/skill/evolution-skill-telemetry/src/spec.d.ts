/**
 * The evolution-skill-telemetry domain declaration: record schema and the
 * `defineDomain` spec the store opens. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-skill-telemetry/src/spec
 */
import { z } from 'zod';
import type { SkillUsageRecord } from './types.ts';
/**
 * Durable shape of one skill-usage record. Compatible reshapes add an
 * optional or defaulted field, never a version bump.
 */
export declare const skillUsageRecord: z.ZodObject<{
    useCount: z.ZodNumber;
    viewCount: z.ZodNumber;
    patchCount: z.ZodNumber;
    lastUsedAt: z.ZodNullable<z.ZodString>;
    lastViewedAt: z.ZodNullable<z.ZodString>;
    lastPatchedAt: z.ZodNullable<z.ZodString>;
    createdAt: z.ZodString;
    state: z.ZodEnum<{
        active: "active";
        stale: "stale";
        archived: "archived";
    }>;
    pinned: z.ZodBoolean;
    createdBy: z.ZodNullable<z.ZodEnum<{
        foreground: "foreground";
        agent: "agent";
    }>>;
    absorbedInto: z.ZodNullable<z.ZodString>;
    archivedAt: z.ZodNullable<z.ZodString>;
}, z.core.$strip>;
/** One stored record, inferred from {@link skillUsageRecord}. */
export type SkillUsageRecordRow = z.infer<typeof skillUsageRecord>;
/**
 * The evolution-skill-telemetry domain spec: one `records` table keyed by
 * skill name. `per-record` because skills are independent. Invalid records
 * fail the domain open loudly: counters back curation decisions, not
 * disposable derived data. No global slot, no migration facility.
 */
export declare const skillUsageDomainSpec: {
    name: string;
    version: number;
    layout: "per-record";
    tables: {
        records: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, SkillUsageRecord>;
    };
};
export type { SkillUsageRecord };
//# sourceMappingURL=spec.d.ts.map