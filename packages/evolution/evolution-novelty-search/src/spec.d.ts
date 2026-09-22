/**
 * The evolution-novelty-search domain declaration: durable archive entries
 * with their behavior descriptor and measured archive novelty. Zod validates
 * the shipped format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-novelty-search/src/spec
 */
import { z } from 'zod';
import type { NoveltyArchiveEntry } from './types.ts';
/** Durable shape of one novelty-archive entry. */
export declare const noveltyArchiveEntryRow: z.ZodObject<{
    candidateId: z.ZodString;
    skill: z.ZodString;
    features: z.ZodArray<z.ZodString>;
    novelty: z.ZodNumber;
    at: z.ZodString;
}, z.core.$strip>;
/** One stored archive entry, inferred from {@link noveltyArchiveEntryRow}. */
export type NoveltyArchiveEntryRow = z.infer<typeof noveltyArchiveEntryRow>;
/**
 * The evolution-novelty-search domain spec: one `archive` table keyed by
 * staged-write identity. `per-record` because entries are independent.
 * Invalid rows fail the domain open loudly: the archive measures evolution
 * direction, not disposable derived data.
 */
export declare const noveltyDomainSpec: {
    name: string;
    version: number;
    layout: "per-record";
    tables: {
        archive: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, NoveltyArchiveEntry>;
    };
};
//# sourceMappingURL=spec.d.ts.map