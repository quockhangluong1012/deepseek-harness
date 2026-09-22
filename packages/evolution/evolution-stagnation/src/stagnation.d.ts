/**
 * Pure helpers for the stagnation detector: meaningful-improvement comparison,
 * best-score tracking, the stagnation counter, and the strategy ladder. No
 * I/O, no domain — fully unit-testable.
 * @module @deepseek-ai/dsh-evolution-stagnation/src/stagnation
 */
import type { RunScore, StagnationRun, StagnationStrategy } from './types.ts';
/**
 * Whether one score meaningfully improves another. The first score of a skill
 * always improves the empty best; pass gains dominate; with pass unchanged, a
 * token reduction of at least `minRelativeGain` relative to the best counts,
 * and with tokens unchanged so does a wall-time reduction of that size. Small
 * token or wall-time jitter below the gain floor is not an improvement.
 * @param score - the candidate score.
 * @param best - the current best score, or null for a skill's first run.
 * @param minRelativeGain - minimum relative token or wall-time gain that counts.
 * @returns whether the score meaningfully improves the best.
 */
export declare function betterThan(score: RunScore, best: RunScore | null, minRelativeGain: number): boolean;
/**
 * The best score of a run list, or null when empty. Ranking follows the elite
 * order — pass first, then fewer tokens, then faster wall time — but the best
 * only moves on an improvement meaningful under `minGain`, so small jitter
 * runs never nudge the frontier the detector measures stagnation against.
 * A zero floor tracks the raw elite top.
 * @param runs - the recorded runs.
 * @param minGain - minimum relative gain that moves the best.
 * @returns the best score, or null when empty.
 */
export declare function bestOf(runs: readonly StagnationRun[], minGain: number): RunScore | null;
/**
 * Runs counted since the last meaningful improvement, over runs in
 * chronological order. Every run after an improved run counts one; an
 * improved run itself resets the count to zero; a skill with no improvement
 * counts every run.
 * @param runs - the recorded runs, in chronological order.
 * @returns the runs counted since the last meaningful improvement.
 */
export declare function generationsSince(runs: readonly StagnationRun[]): number;
/**
 * The strategy a skill should follow given its stagnation depth. Before the
 * threshold the skill stays in normal exploitation; every full threshold
 * span after that climbs one rung of §32's ladder — diversity, new mutation
 * operators, new tasks, new evaluators — capped at switching the model.
 * @param stagnantGenerations - runs counted since the last improvement.
 * @param threshold - runs without improvement that mark stagnation.
 * @returns the strategy the skill should follow now.
 */
export declare function strategyFor(stagnantGenerations: number, threshold: number): StagnationStrategy;
//# sourceMappingURL=stagnation.d.ts.map