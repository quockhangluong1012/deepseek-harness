# Agent Note: Skill loads gain an outcome signal, and the brief warns before capacity runs out

Status: implemented

English | [中文](2026-09-16-batch3-outcome-telemetry.zh.md)

## Problem

Review-v6 Batch 3 asked for outcome telemetry (`lastOutcome`/`failureCount` on `SkillUsageRecord`) plus an early warning at 80% memory capacity — the switch every downstream optimization (GEPA trigger, curator staging filter, skill success rate) reads. Two facts found while reading the code changed the shape of that batch.

First, the assumed wiring partly did not exist the way the review described it. `markUsed` does have a production writer — a passive `tools/post-execute` observer in the telemetry store counts successful `skill`-tool loads — but nothing anywhere recorded a failure, so `useCount` flowed while the failure half of the signal did not. Adding bare fields with no writer would have been dead data.

Second, the capacity warning had a natural home already rendered: the brief header in `dsh-evolution-memory-context` already prints `Memory usage: used/cap (pct%)`, and the store already rejects writes past 100% (`evolution/capacity-exceeded`). The gap was only the early warning between healthy and full.

## Decision

**Outcome telemetry.** `SkillUsageRecord` gains two optional fields — `failureCount?: number` (absent until the first failure) and `lastOutcome?: 'ok' | 'failed'` — so records written before this change read back unchanged. `markUsed` stamps `lastOutcome: 'ok'` (it only ever runs on success, so the stamp is honest, not a default), and a new `markFailed` mirrors its exclusion semantics for bundled and `hub*` sources, bumping `failureCount` and stamping `'failed'`. The same `tools/post-execute` observer is the only writer: a failed `skill`-tool load now calls `markFailed` where it previously recorded nothing. Consumers compute the failure rate as `failureCount / (useCount + failureCount)`, documented on the field so Batch 5's trigger cannot diverge from the store's meaning. Deliberately not wired: turn-level task outcome (whether the skill's advice actually worked) — a `skill`-tool load succeeding says nothing about the turn succeeding, and defining that signal belongs to the GEPA batch with scorer data, not to a load counter.

**Capacity warning.** `dsh-evolution-memory-context` gains a validated `capacityWarnPct` Config field (default 0.8, following the `cacheHitAlertThreshold` fraction pattern), threaded through `EvolutionBriefInput` into the header render. At or above the threshold the header appends `— near capacity: consolidate instead of adding`, ahead of the store's hard reject. The reject itself is untouched: reject-first stays safer than auto-consolidation.

## Alternatives considered

- **Add the fields with no writer** — the wiring the review assumed. Rejected: with nothing recording failures, `failureCount` would have been dead data while `useCount` kept flowing.
- **Make the two fields required** — rejected: optional fields let records written before this change read back unchanged, with no migration pass.
- **Wire turn-level task outcome now** — not taken: a successful `skill`-tool load says nothing about the turn succeeding, and defining that signal belongs to the GEPA batch holding scorer data.
- **Auto-consolidate at the threshold instead of warning** — not taken: the store keeps its hard reject, because reject-first is safer than automatic consolidation.

## Consequences

A failed `skill`-tool load now writes a record where it previously wrote nothing, so `lastOutcome`/`failureCount` fill from real traffic and the readers the review named — curator staging filter, skill success rate, Batch 5's trigger — get the value their metrics assumed. Records persisted before this change read back unchanged: both fields are optional, and `markUsed` stamps only on load success.

The brief header now appends `— near capacity: consolidate instead of adding` once usage reaches `capacityWarnPct` (default 0.8). The line is advisory: the store still hard-rejects past 100% (`evolution/capacity-exceeded`), so ignoring the warning buys time, not headroom.

What this costs: one record shape now has two writers (`markUsed`, `markFailed`) that duplicate the bundled and `hub*` exclusion semantics, and the failure-rate definition sits in the field's documentation rather than in a helper, so every consumer applies it by hand. The signal also stops at load success — turn-level outcome stays unwired (see Deferred).

## Testing

Telemetry: `markFailed` seeds a record with zero uses, ok→failed→ok transitions, exclusion for bundled sources, and an end-to-end observer test where the `skill` fixture throws for one name (failed load records `failureCount: 1` with no use). Context: header warning at, above, and below the threshold, a custom threshold, and load-time rejection of out-of-range values. Scoped coverage is 100% on statements, branches, functions, and lines for both packages; dependents (`evolution-curator`, `command-evolution`, `evolution-skill-manage`, `evolution-memory`) pass 308 tests unchanged.

## Deferred

Turn-level skill outcome (task success, not load success); wiring `markUsed` coverage gaps if any load path bypasses the `skill` tool; GEPA trigger and optimizer (Batch 5-6), which now have the signal they read.
