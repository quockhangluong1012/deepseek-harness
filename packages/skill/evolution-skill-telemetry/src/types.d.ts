/**
 * Public type vocabulary of the evolution skill-telemetry store: the
 * per-skill usage record. Types only — no runtime code.
 * @module @deepseek-ai/dsh-evolution-skill-telemetry/src/types
 */
/** Lifecycle state of one skill under curation. */
export type SkillLifecycleState = 'active' | 'stale' | 'archived';
/** Provenance of a skill's creation: background review or user-directed. */
export type SkillCreatedBy = 'agent' | 'foreground' | null;
/** Durable per-skill usage record stored in the `evolution_skill_usage` domain. */
export interface SkillUsageRecord {
    /** Successful model loads through the skill tool. */
    useCount: number;
    /** Human views of the skill. */
    viewCount: number;
    /** Mutations through skill management. */
    patchCount: number;
    /** ISO-8601 instant of the last load, or null when never loaded. */
    lastUsedAt: string | null;
    /** ISO-8601 instant of the last view, or null when never viewed. */
    lastViewedAt: string | null;
    /** ISO-8601 instant of the last mutation, or null when never mutated. */
    lastPatchedAt: string | null;
    /** ISO-8601 instant the record was seeded. */
    createdAt: string;
    /** Curation lifecycle state. */
    state: SkillLifecycleState;
    /** Pinned skills skip automatic transitions and resist deletion. */
    pinned: boolean;
    /** Creation provenance; null covers user-directed and unknown origins. */
    createdBy: SkillCreatedBy;
    /** Consolidation target absorbing this skill, or null when standalone. */
    absorbedInto: string | null;
    /** ISO-8601 instant the skill entered `archived`, or null otherwise. */
    archivedAt: string | null;
}
/** One produced output path repeated at least the skill-creation threshold. */
export interface RepeatedOutput {
    /** The path as first produced; file content is never read or quoted. */
    readonly path: string;
    /** How many indexed outputs normalized to this path. */
    readonly count: number;
}
/** Skill-creation evidence counted from produced outputs. */
export interface SkillCreationEvidence {
    /** Repeated paths, most produced first and ties in first-seen order. */
    readonly repeated: readonly RepeatedOutput[];
    /** Whether any path reached the skill-creation threshold. */
    readonly fires: boolean;
}
/** Planned cost facts of one consolidation-scale model call, recorded before fan-out. */
export interface ConsolidationCostRow {
    /** Transcript bytes the call admits. */
    readonly inputBytes: number;
    /** Output token ceiling of the call. */
    readonly maxOutputTokens: number;
    /** Provider the call routes to. */
    readonly provider: string;
    /** Model the call uses. */
    readonly model: string;
    /** Whether the admitted input was truncated at its byte budget. */
    readonly truncated: boolean;
}
//# sourceMappingURL=types.d.ts.map