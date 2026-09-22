# Agent Note: Stagnation detection

Status: implemented

English | [中文](2026-09-21-stagnation-detection.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "stagnation detection" as P2 #23 and §32 defines it: detect N generations without meaningful improvement, then automatically switch strategy — exploitation → diversity → new mutation operators → new tasks → new evaluators → new model — because an evolution loop that quietly stops improving is evolutionary death. The harness had no durable record of whether staged writes kept beating the skill's best score, no notion of "runs since improvement", and no strategy ladder to respond when the frontier stalls.

## Decision

One new package, `dsh-evolution-stagnation`, holding a durable per-skill run log with a derived status:

1. **Every staged write is an evaluation run.** The optimizer records each staged write through the optional store seam right after `stageWrite`: the run id is the staged write id, the generation tick is one past the skill's run count, and the improvement flag says whether the run meaningfully beat the skill's best. A failing record logs a warning and never fails the optimization.
2. **Meaningful improvement is measured against a floor.** `betterThan` compares one score to the best: the first score always improves the empty best, a pass gain dominates, and with pass unchanged a token reduction of at least `relativeImprovement` (or, with tokens unchanged, a wall-time reduction of that size) counts; anything below the floor is jitter. `bestOf` uses the same floor so jitter runs never nudge the frontier the detector measures against.
3. **Status derives from history at read time.** `status(skill)` reports the best score, runs since the last improvement, the stagnant flag against the configured `threshold` of runs, and the ladder strategy. `strategyFor` keeps normal exploitation below the threshold and climbs one rung per full threshold span — `diversity`, `newOperators`, `newTasks`, `newEvaluators` — capped at `newModel`. Configuration is validated with defaults (`threshold` 5, `relativeImprovement` 0.05) so an unconfigured mount still runs.
4. **One durable domain, one command surface.** The `evolution_stagnation` domain (v1) holds one `runs` table keyed by run id. `/stagnation` summarizes every skill, renders one skill's standing with its recommended strategy, lists runs, and resets a skill whose task regime changed. The package is mounted in the web-app profile (it writes only its own domain and reaches no model prompt).

## Alternatives considered

- Reuse the population store's generations — rejected: population counts candidates, not evaluations, and the detector's signal is score improvement over the skill's best, which the population store does not compare.
- Derive stagnation from the optimizer's own gate — rejected: the gate decides when to optimize, not whether the frontier has improved; the durable run log must survive restarts and be visible to operators.
- Enforce the strategy switch automatically — rejected: §58.12 keeps trust recorded-not-enforced; the detector names the next strategy, and switching operators, tasks, evaluators, or models remains an operator's job.

## Consequences

- Stagnation is now visible and actionable: `/stagnation status writer` shows the best, the runs since improvement, and the exact strategy to follow, so a stalled skill stops silently consuming evolution budget.
- The run log is durable: `reset` drops one skill's history when a regime changes, and config changes re-rank the strategy at read time without rewriting recorded runs.
- The optimizer stays decoupled: recording is optional and failure-isolated.

## Deviations from the plan

None beyond routine. The initial design tracked the raw elite top as the best; that let a below-floor jitter run become the "best" and made the next floor-sized gain fail the comparison. `bestOf` now applies the same floor as `betterThan`, so the best only moves on meaningful improvements.

## Fixes found on the way

A first draft let a 2% token dip with a large wall-time gain count as meaningful under the wall-time branch; the wall-time branch now applies only when tokens are unchanged, and token gains require the floor. Test boot had to pass `{}` explicitly to `ctx.plugin` because Cordis passes `undefined` config to services with a `static Config` schema.

## Testing

Stagnation helpers: first-score improvement, pass dominance both ways, token/wall-time floor boundaries, best tracking with and without jitter, runs-since-improvement counting with resets, the full ladder including the cap. Store: auto generation and first-run improvement, floor-flagged gains, listing order/filter/detached copies, status derivation with the ladder strategy, configured threshold and floor, reset counting, restart persistence through the zod spec, reads-before-start. Optimizer hook: the staged winner is recorded into a mounted store, staging is unchanged when unmounted, and a failing store logs a warning. `/stagnation`: unmounted, grammar usage, status rendering (stagnant and fresh), runs listing, reset with error propagation, bare summary. 17 stagnation tests, 3 new optimizer tests, and 6 new command tests pass; the new package is at 100% statements/branches/functions/lines, and the optimizer stays at 100%.

## Left alone

The detector records strategy, it does not execute it: switching mutation operators, tasks, evaluators, or models remains an operator's job per §58.12 (documented in the package's Known Limitations). A run records one measured triple; paired-run and multi-seed comparisons are not tracked. `reset` is a blunt instrument that drops the whole skill history; windowed or decayed history is deferred.
