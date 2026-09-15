# Agent Note: The scorer gains a trigger and a per-skill evaluation

Status: implemented

English | [中文](2026-09-16-scorer-trigger-evaluate.zh.md)

## Problem

Review-v6 Batch 5 asked for two things: the `shouldOptimize` trigger (§4.4 step 2) and the scorer wired as the evaluate step (step 3), with no optimizer. It also said the per-skill scenario corpus should be built from the trajectory export. Reading the code showed that last instruction cannot be followed literally.

A scorer scenario is two authored artifacts: `input.json`, a hand-written ACP driver (`waitForInboxMessage`, `cancel`, permission answers), and `session*.jsonl`, the recorded model script the replay consults. Neither is derivable from a finished session. The trajectory export is ShareGPT — per-turn text under `human`/`gpt`/`tool` roles — the training-data format for outer-loop learning, not a replay fixture. Transcribing text back into a replayable session would be fabrication, not replay. So Batch 5 wires the trigger and the evaluation over caller-supplied scenarios, and corpus mining (sessions to fixtures plus authored drivers) stays a Batch 6 design problem against the session-snapshot contracts.

## Decision

**Trigger.** `shouldOptimize` in a new `src/trigger.ts`: sample gate `useCount + failureCount >= minUses` (default 20), then rate `failureCount / (useCount + failureCount) > failureRate` (default 0.3). This deliberately differs from the review's pseudocode (`failureCount / useCount`): Batch 3 documented the inclusive-denominator formula on the telemetry field and Batch 4 standardized on it, so a second formula would stage skills the trigger ignores and vice versa. Thresholds are scorer Config (`triggerMinUses`, `triggerFailureRate`) — the same numbers as the curator's staging thresholds but a different decision (optimize vs review), so each seam owns its copy.

**Evaluate.** `evaluateSkill({ skill, scenarios, agent, run })` on the service reuses the existing `score()` per scenario and aggregates the Pareto triple Batch 6 selects on: `pass` holds only when every scenario passes, tokens and wall time sum the per-scenario medians, and the per-scenario records ride along. One skipped scenario skips the whole evaluation with its reason — optimizing on a partial evaluation would select on evidence that is not there — and an empty scenario list skips the same way, because scoring nothing and calling it a pass would be a lie.

**Wiring the dependency took two non-obvious steps.** The trigger reads `SkillUsageRecord`, so the scorer needed the telemetry package in `peerDependencies` plus the mirror in `devDependencies`, a lockfile refresh, and — because the type-only import widens the program the compiler checks — a project reference in the scorer's `tsconfig.json`, which the curator already had. Without the reference, `tsc -b` fails with `rootDir` errors in packages the change never touches.

## Alternatives considered

**Reusing an existing metric source instead of measuring fresh processes.** Rejected: the triple has to describe the body under test, and nothing already recorded does. `score()` measures a run — billed tokens come from that run's session logs through `ctx.tokenMeter`, wall time is the clock around `run` — while the telemetry store holds the load and outcome counters the trigger reads. A triple read out of telemetry would report the shipped skill's traffic rather than this candidate's behavior, which is the one number Pareto selection cannot use.

**One shared threshold constant for the trigger and the curator's staging filter.** Not taken: the numbers agree today (20 recorded outcomes, 0.3 failure share) but the decisions differ — the curator reviews, the optimizer rewrites — so each seam keeps its own Config copy and either can move without silently retuning the other.

## Consequences

The scorer now answers both questions §4.4 asks of it. `shouldOptimize` is a pure read of one `SkillUsageRecord` — no store, no clock — so any caller already holding telemetry can gate on it, and it reads the documented rate formula the curator's staging filter reads. `evaluateSkill` turns a skill's scenario list into the triple Batch 6 selects on: `pass` only when every scenario passes, tokens and wall time as the sum of the per-scenario medians, the per-scenario records alongside; a skipped scenario or an empty list returns `skipped` with its reason instead of a number nobody could trust.

What this costs: the scorer package now depends on the telemetry package (`peerDependencies`, the `devDependencies` mirror, and the lockfile entry) and carries a `tsconfig.json` project reference, because a type-only import still widens the program `tsc -b` checks — without the reference it fails with `rootDir` errors in packages this change never touches. The evaluation also runs the caller's runner once per scenario, and its all-or-nothing skip rule means one scenario whose driver or recording is broken leaves the whole skill unevaluable until that scenario is repaired.

## Testing

Trigger boundaries (rate at the threshold does not fire, thin samples never fire, missing `failureCount` reads as zero), evaluation aggregation over the on-disk corpus (all-pass triple, one divergent scenario failing the skill but not the evaluation, one absent scenario skipping everything, empty list skipping), plus the Config defaults. 100% on statements, branches, functions, and lines.

## Deferred

Corpus mining per skill (the Batch 6 evaluation dataset: persisted session logs as fixtures plus authored ACP drivers — needs its own design against the snapshot runner contracts); the mutation loop, Pareto selection, and staged deploy (Batch 6, the only consumer of this triple so far).
