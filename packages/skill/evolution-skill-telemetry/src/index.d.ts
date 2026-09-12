/**
 * Evolution skill telemetry (`ctx.evolutionSkillTelemetry`): per-skill
 * use/view/patch counters with creation provenance, pinning, and lifecycle
 * state over the `evolution_skill_usage` domain. Bundled and hub skills are
 * excluded from every write.
 *
 * Reads are synchronous from the domain's validated memory. Marks seed the
 * record on first touch and resolve without writing when nothing changes.
 * Stored objects never leak by reference.
 * @module @deepseek-ai/dsh-evolution-skill-telemetry
 */
import { Context, Service } from '@deepseek-ai/cordis';
import type { ConsolidationCostRow, SkillCreationEvidence, SkillLifecycleState, SkillUsageRecord } from './types.ts';
export type { ConsolidationCostRow, RepeatedOutput, SkillCreationEvidence, SkillLifecycleState, SkillUsageRecord, } from './types.ts';
export { skillUsageDomainSpec } from './spec.ts';
/** Produced outputs of one path needed before skill creation counts as warranted. */
export declare const SKILL_CREATION_OUTPUT_THRESHOLD = 3;
/**
 * Count produced outputs as skill-creation evidence. Two outputs are similar
 * when their normalized path matches — case-folded, with `\` and `/` treated
 * alike and trailing separators ignored — so repeated rewrites of one artifact
 * count, while file content is never read or quoted. Reaching
 * {@link SKILL_CREATION_OUTPUT_THRESHOLD} similar outputs is the counted
 * trigger for proposing a skill; no vendor-reported repetition number feeds it.
 * @param paths - produced-file paths in observation order.
 * @returns the repeated paths plus whether any reached the threshold.
 */
export declare function skillCreationEvidence(paths: readonly string[]): SkillCreationEvidence;
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Durable per-skill usage and curation-state owner. */
        evolutionSkillTelemetry: EvolutionSkillTelemetry;
    }
}
/**
 * Report whether a skill source is excluded from telemetry and managed
 * writes. Bundled skills ship with the product and hub skills arrive from
 * sharing; neither is locally curated.
 * @param source - discovery source from the skill catalog.
 * @returns whether writes for this source must be skipped.
 */
export declare function isExcludedSkillSource(source: string): boolean;
/**
 * Durable per-skill telemetry store. Opens the `evolution_skill_usage`
 * domain at init and closes it through `ctx.effect`. A passive
 * `tools/post-execute` observer counts successful `skill`-tool loads as
 * uses; views, patches, provenance, pins, and states arrive through the
 * explicit marks below.
 */
export declare class EvolutionSkillTelemetry extends Service {
    static inject: string[];
    private table?;
    private consolidationCostRow?;
    /**
     * @param ctx - Host context carrying the storage domain and skill registry.
     */
    constructor(ctx: Context);
    /** Open the domain and publish the table handle. */
    protected [Service.init](): Promise<void>;
    /**
     * Read one skill's record.
     * @param name - skill name.
     * @returns a detached copy, or undefined when never touched.
     */
    read(name: string): SkillUsageRecord | undefined;
    /**
     * List every tracked skill with its record.
     * @returns name/record pairs with detached copies.
     */
    entries(): {
        name: string;
        usage: SkillUsageRecord;
    }[];
    /**
     * Count one successful model load. Bundled and hub skills resolve to no
     * record: the observer still delegates, only the write is skipped.
     * @param name - skill name.
     * @param source - catalog source when the caller already resolved it.
     * @returns the stored record, or undefined for excluded sources.
     */
    markUsed(name: string, source?: string): Promise<SkillUsageRecord | undefined>;
    /**
     * Count one human view. Exclusion matches {@link markUsed}.
     * @param name - skill name.
     * @param source - catalog source when the caller already resolved it.
     * @returns the stored record, or undefined for excluded sources.
     */
    markViewed(name: string, source?: string): Promise<SkillUsageRecord | undefined>;
    /**
     * Count one skill-management mutation. Exclusion matches {@link markUsed}.
     * @param name - skill name.
     * @param source - catalog source when the caller already resolved it.
     * @returns the stored record, or undefined for excluded sources.
     */
    markPatched(name: string, source?: string): Promise<SkillUsageRecord | undefined>;
    /**
     * Record background-review authorship. Resolves without writing when the
     * record already carries it; foreground creates never call this, so their
     * provenance stays user-directed.
     * @param name - skill name.
     * @returns the stored record.
     */
    markAgentCreated(name: string): Promise<SkillUsageRecord>;
    /**
     * Adopt one agent-created skill into user-directed standing. Only records
     * carrying background-review authorship move; everything else rejects, and
     * clocks never reset.
     * @param name - skill name.
     * @returns the stored record with user-directed provenance.
     */
    markAdopted(name: string): Promise<SkillUsageRecord>;
    /**
     * Forget one skill's record entirely. Purge calls this after removing the
     * skill directory; absent names resolve without writing.
     * @param name - skill name.
     * @returns whether a record was removed.
     */
    drop(name: string): Promise<boolean>;
    /**
     * Record the cost row of a consolidation-scale run before its fan-out
     * begins, so the curator and command surfaces read one frozen shape of
     * planned spend instead of quoting ad-hoc numbers. Only the latest row is
     * kept; a run that never fans out leaves the previous row untouched.
     * @param row - planned cost facts of the upcoming run.
     */
    recordConsolidationCost(row: ConsolidationCostRow): void;
    /**
     * Read the cost row recorded for the most recent consolidation-scale run.
     * @returns a detached copy of the row, or undefined when no run was recorded.
     */
    readConsolidationCost(): ConsolidationCostRow | undefined;
    /**
     * Pin or unpin one skill. Pins block automatic transitions and managed
     * deletion; patches stay allowed. Resolves without writing when unchanged.
     * @param name - skill name.
     * @param pinned - new pin state.
     * @returns the stored record.
     */
    setPinned(name: string, pinned: boolean): Promise<SkillUsageRecord>;
    /**
     * Move one skill through its curation lifecycle. Entering `archived`
     * stamps the instant; leaving clears it. The absorption target replaces
     * any previous one, so plain transitions carry none.
     * @param name - skill name.
     * @param state - new lifecycle state.
     * @param absorbedInto - consolidation umbrella, or null when standalone.
     * @returns the stored record.
     */
    setState(name: string, state: SkillLifecycleState, absorbedInto?: string | null): Promise<SkillUsageRecord>;
    private lookupSource;
    private write;
    private requireTable;
}
export default EvolutionSkillTelemetry;
//# sourceMappingURL=index.d.ts.map