/**
 * The evolution-memory domain declaration: record schema and the
 * `defineDomain` spec the store opens. Zod validates the shipped format at
 * the durability boundary.
 * @module @deepseek-ai/dsh-evolution-memory/src/spec
 */
import { z } from 'zod';
import type { EvolutionContextItem, EvolutionExtraction, EvolutionMemoryRecord, EvolutionOutput, EvolutionScopeId, StagedResolution, StagedWrite } from './types.ts';
/** One attached context item at the durable boundary. */
export declare const evolutionContextItem: z.ZodDiscriminatedUnion<[z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    sizeBytes: z.ZodNumber;
    addedAt: z.ZodString;
    kind: z.ZodLiteral<"text">;
    text: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    id: z.ZodString;
    label: z.ZodString;
    sizeBytes: z.ZodNumber;
    addedAt: z.ZodString;
    kind: z.ZodLiteral<"file">;
    path: z.ZodString;
}, z.core.$strip>], "kind">;
/** One produced-file index entry at the durable boundary. */
export declare const evolutionOutput: z.ZodObject<{
    path: z.ZodString;
    tool: z.ZodString;
    sessionId: z.ZodString;
    at: z.ZodString;
}, z.core.$strip>;
/** Extraction provenance at the durable boundary. */
export declare const evolutionExtraction: z.ZodObject<{
    at: z.ZodString;
    sessionId: z.ZodString;
    provider: z.ZodString;
    model: z.ZodString;
    origin: z.ZodEnum<{
        foreground: "foreground";
        background_review: "background_review";
        "user-edit": "user-edit";
        rebuild: "rebuild";
    }>;
    inputBytes: z.ZodNumber;
    truncated: z.ZodBoolean;
}, z.core.$strip>;
/**
 * JSON payload of one staged write. `z.json()` enforces the lossless JSON
 * boundary the record must round-trip through; the store reuses this same
 * declaration to refuse a non-JSON payload at the write boundary.
 */
export declare const stagedWritePayload: z.ZodJSONSchema;
/** One staged write at the durable boundary. */
export declare const stagedWrite: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        memory: "memory";
        skill: "skill";
    }>;
    op: z.ZodString;
    payload: z.ZodJSONSchema;
    originSessionId: z.ZodString;
    createdAt: z.ZodString;
    gist: z.ZodString;
}, z.core.$strip>;
/** One decided staged entry at the durable boundary. */
export declare const stagedResolution: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodEnum<{
        memory: "memory";
        skill: "skill";
    }>;
    op: z.ZodString;
    gist: z.ZodString;
    decision: z.ZodEnum<{
        approved: "approved";
        rejected: "rejected";
    }>;
    at: z.ZodString;
    originSessionId: z.ZodString;
}, z.core.$strip>;
/**
 * Durable shape of one evolution-memory record. Compatible reshapes add an
 * optional or defaulted field, never a version bump.
 */
export declare const evolutionMemoryRecord: z.ZodObject<{
    instructions: z.ZodString;
    agentLessons: z.ZodString;
    userProfile: z.ZodString;
    instructionsUpdatedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    lessonsUpdatedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    profileUpdatedAt: z.ZodDefault<z.ZodNullable<z.ZodString>>;
    memoryUpdatedAt: z.ZodNullable<z.ZodString>;
    contextItems: z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        sizeBytes: z.ZodNumber;
        addedAt: z.ZodString;
        kind: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        id: z.ZodString;
        label: z.ZodString;
        sizeBytes: z.ZodNumber;
        addedAt: z.ZodString;
        kind: z.ZodLiteral<"file">;
        path: z.ZodString;
    }, z.core.$strip>], "kind">>;
    outputs: z.ZodArray<z.ZodObject<{
        path: z.ZodString;
        tool: z.ZodString;
        sessionId: z.ZodString;
        at: z.ZodString;
    }, z.core.$strip>>;
    lastExtraction: z.ZodNullable<z.ZodObject<{
        at: z.ZodString;
        sessionId: z.ZodString;
        provider: z.ZodString;
        model: z.ZodString;
        origin: z.ZodEnum<{
            foreground: "foreground";
            background_review: "background_review";
            "user-edit": "user-edit";
            rebuild: "rebuild";
        }>;
        inputBytes: z.ZodNumber;
        truncated: z.ZodBoolean;
    }, z.core.$strip>>;
    staged: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            memory: "memory";
            skill: "skill";
        }>;
        op: z.ZodString;
        payload: z.ZodJSONSchema;
        originSessionId: z.ZodString;
        createdAt: z.ZodString;
        gist: z.ZodString;
    }, z.core.$strip>>;
    resolutions: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        kind: z.ZodEnum<{
            memory: "memory";
            skill: "skill";
        }>;
        op: z.ZodString;
        gist: z.ZodString;
        decision: z.ZodEnum<{
            approved: "approved";
            rejected: "rejected";
        }>;
        at: z.ZodString;
        originSessionId: z.ZodString;
    }, z.core.$strip>>>;
    updatedAt: z.ZodString;
}, z.core.$strip>;
/** One stored record, inferred from {@link evolutionMemoryRecord}. */
export type EvolutionMemoryRecordRow = z.infer<typeof evolutionMemoryRecord>;
/**
 * The evolution-memory domain spec: one `records` table keyed by scope id.
 * `per-record` because scopes are independent. Invalid records fail the
 * domain open loudly: instructions are user-authored, not disposable derived
 * data. No global slot, no migration facility.
 */
export declare const evolutionMemoryDomainSpec: {
    name: string;
    version: number;
    layout: "per-record";
    tables: {
        records: import("@deepseek-ai/dsh-storage-domain").DomainTableSpec<EvolutionScopeId, EvolutionMemoryRecord>;
    };
};
export type { EvolutionContextItem, EvolutionExtraction, EvolutionMemoryRecord, EvolutionOutput, EvolutionScopeId, StagedResolution, StagedWrite, };
//# sourceMappingURL=spec.d.ts.map