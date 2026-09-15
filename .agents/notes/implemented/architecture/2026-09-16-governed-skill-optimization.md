# Agent Note: Governed skill optimization (protected holdout, budget, successive halving)

Status: implemented

English | [中文](2026-09-16-governed-skill-optimization.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §15 (protected holdout), §37 (budget controller), and §38 (early stopping and successive halving) are the P0/P3 mechanisms that keep an evolutionary loop honest and affordable, and the survey of §51 found all three absent: `EvolutionOptimizer.optimize` selected a winner on exactly the scenarios the caller named, scored every candidate over all of them, and had no ceiling on what a run could cost. Nothing separated the corpus a candidate was written against from the corpus it was judged on, and a run with three candidates bought three full evaluations even when one candidate was plainly worse on the first scenario.

## Decision

Four governance mechanisms inside `dsh-evolution-optimizer`, all in the same change because they are one control flow over one scenario list:

1. **Protected holdout.** `holdoutScenarios` (config, default `[]`) names corpus scenarios the search never scores. After the winner is picked, the baseline and the winner are both scored on the holdout set, and a winner the baseline dominates there is refused: `status: 'holdout-rejected'`, `holdout: { baseline, winner }` recorded, nothing staged. The holdout is configuration, never part of `OptimizeRequest`: a caller that could name the holdout could also drop the scenario its candidate fails.
2. **Budget controller.** `budgetTokens` / `budgetWallTimeMs` (config, default `0` = unbounded) cap what candidate scoring may buy. The loop checks the ceiling before each full evaluation, stops when it is passed, and reports `truncated: true`; selection then runs over the candidates that fit. A run that spent its budget before scoring any candidate returns `skipped` rather than staging a winner it never measured.
3. **Successive halving.** `screenScenarioCount` (config, default `0` = off) scores every candidate on the first N search scenarios, keeps `ceil(candidates / 2)` (at least one) ranked by pass state, then tokens, then wall time, and fully scores only the survivors. The screen runs for every candidate regardless of the budget, so survivors are always compared on the same subset.
4. **Partition validation.** Before any model call, `optimize` throws when a scenario name repeats inside either list or appears in both. A misconfigured split fails at the earliest resolvable point instead of silently weakening the check.

`OptimizeReport` gains `holdout: HoldoutCheck | null` and `truncated: boolean`, and `status` gains `holdout-rejected`; `/curator optimize` prints the holdout triple when the report carries one. The pure selector gains `screenSurvivors` in `src/pareto.ts`.

## Alternatives considered

**A `train`/`validation`/`holdout` partition declared in the corpus itself** (a `split` field per scenario file, owned by `dsh-evolution-scorer`): rejected — it puts a promotion-policy decision into the corpus format, forces a scorer schema change for a check only the optimizer performs, and would still need the request-level overlap check that a config list gets for free.

**Including holdout scenarios in the request next to the search scenarios**: rejected — the request is the caller's, and the caller is also the party whose candidate is being judged. A holdout the caller can rename, drop, or accidentally pass as search is not a holdout.

**Rejecting the whole run when the budget truncates**: rejected — the candidates already scored are real measurements, and refusing to select among them throws away paid work. The report carries `truncated: true` instead, so a reader can tell a full search from a partial one.

**Budgeting the screen too**: rejected — stopping the screen halfway leaves survivors ranked on different subsets, which is the fairness the screen exists to provide. Screening is cheap by construction (`screenScenarioCount` scenarios per candidate) and ungoverned; only full evaluations are budgeted.

**Never staging from a truncated run**: rejected as the default because it makes a small budget equivalent to no optimization at all, but kept as the outcome for the degenerate case where the budget is spent before any full evaluation — there is nothing measured to stage.

## Consequences

A candidate can no longer be promoted on the corpus it was generated against, an unbounded-spend run is now bounded by configuration, and a run over many candidates costs the screen plus at most half the full evaluations. The costs are stated in the package README: the split is only as private as the operator's configuration, screening judges survivors on a subset that may not represent the whole corpus, and `truncated: true` means the winner was chosen among the candidates that fit.

Verification: 43 optimizer tests (pure pareto plus service orchestration over faked seams: overlap and duplicate rejection, screen call order and survivor cut, token and wall-time truncation, budget spent before any candidate, holdout supported/rejected/skipped at both the baseline and the winner) and the `/curator optimize` CLI test for the holdout line; 100% statements, branches, functions, and lines on `packages/evolution/evolution-optimizer/src`.
