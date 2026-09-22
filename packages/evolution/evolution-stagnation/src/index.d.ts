/**
 * Stagnation detection (`ctx.evolutionStagnation`): a durable per-skill log
 * of evaluation runs — one per staged optimizer write — that counts runs
 * without meaningful improvement and names the next strategy when a skill's
 * frontier stalls (§32). Improvement is measured against the skill's best
 * score with a configured relative-gain floor, so token or wall-time jitter
 * below the floor is not an improvement. Once a skill has stalled past the
 * configured threshold, the strategy ladder climbs from diversity over new
 * mutation operators, new tasks, and new evaluators, capped at switching the
 * model — this prevents silent evolutionary death. Nothing here calls a
 * model; the optimizer records runs through the optional recorder seam.
 * @module @deepseek-ai/dsh-evolution-stagnation
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from 'zod';
import type { StagnationRun, StagnationRunInput, StagnationStatus } from './types.ts';
export type * from './types.ts';
export { betterThan, bestOf, generationsSince, strategyFor } from './stagnation.ts';
export { stagnationDomainSpec, stagnationRunRow } from './spec.ts';
/** Validated configuration of the stagnation detector. */
export interface StagnationConfig {
    /** Runs without meaningful improvement before the skill is stagnant. */
    threshold: number;
    /** Minimum relative token or wall-time gain that counts as meaningful. */
    relativeImprovement: number;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Stagnation store growing per-skill evaluation runs from optimizer writes. */
        evolutionStagnation: EvolutionStagnation;
    }
}
/**
 * Stagnation-detection store over durable runs. Opens the
 * `evolution_stagnation` domain at init and closes it through `ctx.effect`.
 */
export declare class EvolutionStagnation extends Service {
    static inject: string[];
    /** Deployment choices of the detector; defaults assume an ordinary cadence. */
    static Config: z.ZodObject<{
        threshold: z.ZodDefault<z.ZodNumber>;
        relativeImprovement: z.ZodDefault<z.ZodNumber>;
    }, z.core.$strip>;
    /** Deployment choices of the stagnation detector. */
    readonly config: StagnationConfig;
    private table?;
    /**
     * @param ctx - host context carrying the storage domain.
     * @param config - validated detector choices.
     */
    constructor(ctx: Context, config: StagnationConfig);
    /** Open the domain and publish the table handle. */
    protected [Service.init](): Promise<void>;
    /**
     * Record one run, numbering its generation tick one past the skill's run
     * count and flagging whether it meaningfully improved the skill's best
     * score so far.
     * @param input - the run to record.
     * @returns the stored run.
     */
    recordRun(input: StagnationRunInput): Promise<StagnationRun>;
    /**
     * List every run, optionally filtered by skill, newest first.
     * @param skill - optional skill filter.
     * @returns the runs, detached from the store.
     */
    runs(skill?: string): readonly StagnationRun[];
    /**
     * The derived stagnation status of one skill: best score, runs since the
     * last meaningful improvement, the stagnant flag against the configured
     * threshold, and the strategy the skill should follow now. A skill with no
     * runs reports zero runs and normal exploitation.
     * @param skill - the skill to inspect.
     * @returns the stagnation status.
     */
    status(skill: string): StagnationStatus;
    /**
     * Drop every recorded run of one skill, returning the count removed. Used
     * when a task regime changes and the skill's history no longer applies.
     * @param skill - the skill to reset.
     * @returns the number of runs removed.
     */
    reset(skill: string): Promise<number>;
    private requireTable;
}
export default EvolutionStagnation;
//# sourceMappingURL=index.d.ts.map