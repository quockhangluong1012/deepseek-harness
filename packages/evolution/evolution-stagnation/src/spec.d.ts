/**
 * The evolution-stagnation domain declaration: durable evaluation runs with
 * their measured triple and improvement flag. Zod validates the shipped
 * format at the durability boundary.
 * @module @deepseek-ai/dsh-evolution-stagnation/src/spec
 */
import { z } from 'zod';
import type { StagnationRun } from './types.ts';
/** Durable shape of one evaluation run. */
export declare const stagnationRunRow: z.ZodObject<{
    runId: z.ZodString;
    skill: z.ZodString;
    generation: z.ZodNumber;
    score: z.ZodObject<{
        pass: z.ZodBoolean;
        tokens: z.ZodNumber;
        wallTimeMs: z.ZodNumber;
    }, z.core.$strip>;
    improved: z.ZodBoolean;
    at: z.ZodString;
}, z.core.$strip>;
/** One stored run, inferred from {@link stagnationRunRow}. */
export type StagnationRunRow = z.infer<typeof stagnationRunRow>;
/**
 * The evolution-stagnation domain spec: one `runs` table keyed by run
 * identity. `per-record` because runs are independent. Invalid rows fail the
 * domain open loudly: the runs drive evolution-strategy decisions.
 */
export declare const stagnationDomainSpec: {
    name: string;
    version: number;
    layout: "per-record";
    tables: {
        runs: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<string, StagnationRun>;
    };
};
//# sourceMappingURL=spec.d.ts.map