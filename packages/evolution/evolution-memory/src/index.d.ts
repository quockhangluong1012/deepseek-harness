/**
 * Durable per-scope evolution memory store (`ctx.evolutionMemory`): the
 * user-authored instructions, the model-maintained lessons and profile
 * documents with provenance and per-family stamps, attached text and file
 * context items, the produced-file index, staged writes awaiting approval,
 * and the newest-first log of decided staged entries, over the
 * `evolution_memory` domain.
 *
 * Reads are synchronous from the domain's validated memory. Every cap is
 * checked before the write chain is entered, and a rejected write never
 * mutates the record. Stored objects never leak by reference.
 * @module @deepseek-ai/dsh-evolution-memory
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { EvolutionContextItemInput, EvolutionExtraction, EvolutionMemoryRecord, EvolutionMemoryUsage, EvolutionOutput, EvolutionScopeId as EvolutionScopeIdBrand, StagedWrite, StagedWriteInput } from './types.ts';
export type { EvolutionContextItem, EvolutionContextItemInput, EvolutionExtraction, EvolutionMemoryRecord, EvolutionMemoryUsage, EvolutionOutput, MemoryStagedRemovePayload, MemoryStagedReplacePayload, MemoryStagedTextPayload, StagedResolution, StagedWrite, StagedWriteInput, } from './types.ts';
export { evolutionMemoryDomainSpec } from './spec.ts';
export { digestOf, usedBytesOf, EMPTY_DIGEST, truncateUtf8, utf8Bytes } from './digest.ts';
/**
 * Label prefix marking context the reviewer recalled from session history
 * rather than the user attaching it. Writers label recalled items with it and
 * consumers order them last, so a recalled item is the first context material
 * a brief drops under its byte budget.
 */
export declare const RECALL_LABEL_PREFIX = "Recall: ";
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Durable per-scope evolution memory record owner. */
        evolutionMemory: EvolutionMemoryStore;
    }
}
/** Identifies one evolution scope (see `src/types.ts` for the brand rationale). */
export type EvolutionScopeId = EvolutionScopeIdBrand;
/**
 * Build the opaque scope identity for one scope: `profile:workspaceId`, or
 * `profile:global` for the profile-wide record. Use {@link storageKey} for
 * the path-safe record key handed to the domain.
 * @param profile - owning profile name; non-empty and free of `:`.
 * @param workspaceId - workspace key within the profile; omit for the global record.
 * @returns the opaque scope identity.
 */
export declare function EvolutionScopeId(profile: string, workspaceId?: string): EvolutionScopeId;
/**
 * Internal file encoding for one scope: `<profile>--<workspaceId>` or
 * `<profile>--global`. The external identity stays the opaque
 * `profile:workspaceId` key because `:` is unambiguous when profiles and
 * scopes never contain it; the JSON backend forbids `:` in per-record keys,
 * so the store never hands the opaque key to the domain.
 * @param id - opaque scope identity.
 * @returns the path-safe record key used as the domain table key.
 */
export declare function storageKey(id: EvolutionScopeId): string;
/**
 * Decode one storage key back to its opaque scope identity, splitting on the
 * last `--` so profiles containing `--` still round-trip (workspace keys are
 * UUIDs without `--`, and the global record ends in `--global`).
 * @param key - path-safe record key.
 * @returns the opaque scope identity.
 */
export declare function scopeIdFromStorageKey(key: string): EvolutionScopeId;
/** Deployment-chosen caps for stored evolution memory. */
export interface Config {
    /** Capacity-bar denominator and hard ceiling on stored bytes. */
    capacityBytes: number;
    /** Lessons document cap in UTF-8 bytes. */
    maxAgentBytes?: number;
    /** User profile document cap in UTF-8 bytes. */
    maxUserBytes?: number;
    /** Per-item cap in UTF-8 bytes, and ceiling on a file item's observed size. */
    maxContextItemBytes?: number;
    /** Item count cap. */
    maxContextItems?: number;
    /** Produced-file index size. */
    maxOutputs?: number;
    /** Decided staged entries retained per scope. */
    maxResolutions?: number;
}
/** Validated deployment choices; `capacityBytes` is required. */
export declare const Config: z<Config>;
/** Normalized configuration used by the store. */
export interface ResolvedConfig {
    capacityBytes: number;
    maxAgentBytes: number;
    maxUserBytes: number;
    maxContextItemBytes: number;
    maxContextItems: number;
    maxOutputs: number;
    maxResolutions: number;
}
/**
 * Resolve defaults for optional caps.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export declare function resolveConfig(config: Config): ResolvedConfig;
/**
 * Durable per-scope evolution memory store. Opens the `evolution_memory`
 * domain at init and closes it through `ctx.effect`.
 */
export declare class EvolutionMemoryStore extends Service {
    static inject: string[];
    private table?;
    private readonly resolved;
    /**
     * @param ctx - Host context carrying the storage domain.
     * @param config - capacity and per-field caps from the composition.
     */
    constructor(ctx: Context, config: Config);
    /** Open the domain and publish the table handle. */
    protected [Service.init](): Promise<void>;
    /**
     * Read one scope's record.
     * @param id - scope identity.
     * @returns a detached copy, or undefined when absent.
     */
    read(id: EvolutionScopeId): EvolutionMemoryRecord | undefined;
    /**
     * Capacity accounting for one scope.
     * @param id - scope identity.
     * @returns charged bytes and the configured ceiling.
     */
    usage(id: EvolutionScopeId): EvolutionMemoryUsage;
    /**
     * Digest of the brief's inputs for one scope.
     * @param id - scope identity.
     * @returns `'empty'` when absent, else the sha1 of the covered inputs.
     */
    digest(id: EvolutionScopeId): string;
    /**
     * Replace the user-authored instruction text. Instructions carry no
     * per-field cap; only the scope capacity bounds them.
     * @param id - scope identity.
     * @param instructions - new rules.
     * @returns the stored record.
     */
    setInstructions(id: EvolutionScopeId, instructions: string): Promise<EvolutionMemoryRecord>;
    /**
     * Replace the whole lessons document by hand or from extraction.
     * @param id - scope identity.
     * @param text - replacement lessons document.
     * @param extraction - provenance when model-written.
     * @returns the stored record.
     */
    setLessons(id: EvolutionScopeId, text: string, extraction?: EvolutionExtraction): Promise<EvolutionMemoryRecord>;
    /**
     * Append one lesson. An exact duplicate resolves without writing.
     * @param id - scope identity.
     * @param text - non-empty lesson text to append.
     * @returns the stored record, unchanged when the lesson already exists.
     */
    addLesson(id: EvolutionScopeId, text: string): Promise<EvolutionMemoryRecord>;
    /**
     * Replace one uniquely-matching lesson substring.
     * @param id - scope identity.
     * @param oldText - non-empty substring expected exactly once.
     * @param content - replacement text.
     * @returns the stored record.
     */
    replaceLesson(id: EvolutionScopeId, oldText: string, content: string): Promise<EvolutionMemoryRecord>;
    /**
     * Remove one uniquely-matching lesson substring.
     * @param id - scope identity.
     * @param oldText - non-empty substring expected exactly once.
     * @returns the stored record.
     */
    removeLesson(id: EvolutionScopeId, oldText: string): Promise<EvolutionMemoryRecord>;
    /**
     * Replace the whole user profile document by hand or from extraction.
     * @param id - scope identity.
     * @param text - replacement profile document.
     * @param extraction - provenance when model-written.
     * @returns the stored record.
     */
    setUserProfile(id: EvolutionScopeId, text: string, extraction?: EvolutionExtraction): Promise<EvolutionMemoryRecord>;
    /**
     * Attach pasted text or a scope file.
     * @param id - scope identity.
     * @param input - label plus text or path with its observed size.
     * @returns the stored record.
     */
    addContextItem(id: EvolutionScopeId, input: EvolutionContextItemInput): Promise<EvolutionMemoryRecord>;
    /**
     * Detach one context item.
     * @param id - scope identity.
     * @param itemId - context item identity.
     * @returns the stored record.
     */
    removeContextItem(id: EvolutionScopeId, itemId: string): Promise<EvolutionMemoryRecord>;
    /**
     * Stage one write for later approval. Staged entries never count toward
     * capacity; `memoryUpdatedAt` stays untouched until approval. The payload
     * is a durable record field, so it is validated as a JSON value here: a
     * non-JSON payload is refused loudly and nothing is stored.
     * @param input - scope, kind, op, payload, origin session, and gist.
     * @returns the staged entry.
     */
    stageWrite(input: StagedWriteInput): Promise<StagedWrite>;
    /**
     * Approve one staged write. Memory-kind entries apply their op first, so a
     * cap or substring rejection keeps the entry staged and propagates; the
     * entry drops only after the op lands. Skill-kind entries only drop: the
     * approver reads the payload from the scope record and performs the skill
     * write before approving. Either decision is recorded in the scope's
     * resolution log, newest first.
     * @param id - staged entry identity.
     * @returns resolution after durability.
     */
    approveStaged(id: string): Promise<void>;
    /**
     * Drop one staged write without applying it.
     * @param id - staged entry identity.
     * @returns resolution after durability.
     */
    rejectStaged(id: string): Promise<void>;
    /**
     * Index produced files newest-first, collapsing repeats onto the newer
     * `at` and truncating to `maxOutputs`. Resolves without writing when the
     * resulting list is unchanged.
     * @param id - scope identity.
     * @param entries - output entries with path, tool, session, and instant.
     * @returns resolution after durability, or immediately when unchanged.
     */
    recordOutputs(id: EvolutionScopeId, entries: readonly EvolutionOutput[]): Promise<void>;
    /**
     * Locate the record holding one staged entry. Table keys are storage keys;
     * the returned key is the same encoding `update` expects.
     */
    private findStagedScope;
    private write;
    private requireTable;
}
export default EvolutionMemoryStore;
//# sourceMappingURL=index.d.ts.map