---
description: "Sleep-time compute: evidence-driven idle anticipation with precomputed reasoning artifacts under an offline-cost economic policy (ctx.evolutionSleeptime)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-sleeptime

English | [中文](README.zh.md)

## Summary

`dsh-evolution-sleeptime` anticipates likely future tasks while idle, caching precomputed reasoning artifacts for them: summaries, retrieval structures, candidate plans. It invents nothing: a heartbeat pass reads the recurrence the router and skill-telemetry stores recorded, and anticipates only task classes recurring often enough in the window. Each task carries likelihood, expected queries, and per-query savings; it pays when likelihood-weighted savings beat offline cost, and the greedy plan fits the best nets into the offline budget, recording that decision on the justified artifact. A later recorded turn of that class counts one hit and its tokens, cursor-tracked. Nothing here calls a model.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the storage domain. Where a router or skill-telemetry store is also mounted, the heartbeat's idle ticks run the anticipation pass on their own; operators can also anticipate a task, precompute an artifact, and drive a pass by hand.

```ts
// The automatic pass: what the source stores recorded is what it anticipates.
await ctx.evolutionSleeptime.anticipateAll()

// Or by hand, for a task the operator already knows is coming.
await ctx.evolutionSleeptime.anticipate({
  taskId: 'nightly-review',
  domain: 'writer',
  likelihood: 0.8,
  expectedQueries: 10,
  expectedSavingTokens: 500,
})
await ctx.evolutionSleeptime.precompute({
  artifactId: 'review-outline',
  taskId: 'nightly-review',
  kind: 'candidate-plan',
  summary: 'outline',
  offlineCostTokens: 200,
})
const planned = ctx.evolutionSleeptime.plan()
```

`anticipateAll(signal?)` runs one pass: it derives recurrence from the mounted sources, anticipates each class that recurred at least `minRecurrences` times inside `recurrenceWindowHours`, precomputes the artifacts `plan()` justifies for them, and accounts the recorded turns that consumed an artifact already cached. `anticipate(input)` upserts by task identity so a re-anticipated task refreshes its likelihood and expectations. `tasks(domain?)` lists tasks likeliest first; `precompute(input)` caches one artifact for an anticipated task and rejects unknown tasks loudly; `artifacts(taskId?)` lists artifacts newest first; `hit(artifactId, occurrences)` accounts every recorded occurrence of the artifact's class that is newer than its cursor; `plan(estimatedCostTokens?, budgetTokens?)` returns the greedy budgeted plan over tasks with no cached artifact yet.

### Configuration

The store's deployed choices, with defaults suitable for a small nightly idle window; every field is validated with a default so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `defaultEstimatedCostTokens` | `2000` | Estimated offline tokens of one precompute, used when the caller names none. |
| `maxOfflineTokens` | `50000` | Total offline token budget of one plan, used when the caller names none. |
| `minRecurrences` | `3` | Occurrences a class needs inside the window before it counts as recurring. |
| `recurrenceWindowHours` | `168` | Hours back a recorded occurrence still counts as recurrence. |
| `intervalHours` | `6` | Hours between two automatic anticipation passes. |
| `maxPerPass` | `3` | Classes one pass may anticipate and precompute. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Economics are pure. `expectedNet` weights one task's expected savings by its likelihood and subtracts the estimated offline cost, so a task that never materializes still costs its precompute. `decideWorth` needs a strictly positive net: a net of exactly zero spends idle time for nothing. `planFor` keeps only worth-it decisions, sorts net descending with task-id ascending tie-break, and takes them greedily while the cumulative estimated cost still fits the budget. `savingsOf` subtracts an artifact's offline cost from the tokens its hits have saved, staying negative until the precompute pays back. `precompute(input)` stores the plan's reason beside the artifact, so a cached artifact always names the comparison that justified it.

Anticipation is derived, never invented. `recurrenceOf` counts the recorded occurrences of each source-and-class inside the window and returns their mean tokens; `anticipationOf` keeps the classes with at least `minRecurrences` sightings, sets each likelihood to its share of the recurring occurrences, credits `expectedQueries` with its own recurrence and `expectedSavingTokens` with the mean tokens one recorded occurrence spent, and orders them likeliest first. `classKeyOf` namespaces a class by its source, so a skill and a route that read alike stay two candidates. `artifactSummaryOf` writes the recorded recurrence into the artifact's content, so what a precompute caches names its evidence rather than anything a model composed. The pass then reads the mounted router's measured outcomes and, for each tracked skill, the learning-trace rows of the sessions that loaded it. A source that is not mounted contributes nothing, and a pass with no recurrence records nothing at all.

Accounting is cursor-bounded. `hit(artifactId, occurrences)` takes the recorded occurrences of the artifact's own class strictly newer than `servedThroughAt` — the artifact's precompute instant while it has never been served, so a turn that ran before the artifact existed is never credited as its consumer — adds one hit and that occurrence's recorded tokens each, and advances the cursor to the newest one. A pass that finds nothing newer leaves the artifact untouched, which is what makes a repeating pass safe.

The store is a two-table domain: `evolution_sleeptime` version 2 with a `tasks` table keyed by task identity holding `{ taskId, domain, scope, likelihood, expectedQueries, expectedSavingTokens, at }` and an `artifacts` table keyed by artifact identity holding `{ artifactId, taskId, kind, summary, offlineCostTokens, decisionReason, hits, savedTokens, servedThroughAt, at }`. Version 1 stored artifacts without the last two accounting fields; both default to null, and a null cursor is accounted from the artifact's own instant, so vouched-for v1 rows open unchanged. The plan derives from the current tables at read time, so configuration changes re-rank the plan without rewriting recorded rows.

### Failure and recovery

Reads throw before the store starts. `precompute` rejects an unknown task identity and `hit` rejects an unknown artifact identity, so an artifact always names a real anticipated task and accounting always lands on a real cached artifact. `anticipate` upserts by task identity, so a re-anticipated task refreshes in place rather than duplicating, and the heartbeat records a failing pass against its task without stopping the other tasks in the same tick.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check them against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §25 — the sleep-time compute this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.md) — the idle driver whose quiet ticks trigger the anticipation pass.
- [`dsh-evolution-model-routes`](../evolution-model-routes/README.md) and [`dsh-evolution-skill-telemetry`](../../skill/evolution-skill-telemetry/README.md) — the stores whose recorded recurrence the pass anticipates from.
- [`dsh-evolution-dreaming`](../evolution-dreaming/README.md) — the sibling that consolidates past observations into durable memory, where sleep-time precomputes for likely futures.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering anticipated tasks or cached artifacts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **One artifact kind per anticipated class** — the pass precomputes a `summary` for each class it admits; the retrieval-index and candidate-plan kinds are `precompute` calls an operator or a future pass makes.
- **Accounting matches the anticipation key** — an artifact is only accounted against occurrences whose source-and-class key equals its `taskId`, so an operator-precomputed artifact whose id is a bare name is never accounted automatically.
- **Recurrence is counted, not weighted** — a class counts once per recorded occurrence regardless of how expensive that occurrence was; a cost-weighted recurrence needs a per-occurrence cost the source stores do not record.
- **One estimated cost per plan** — `plan` prices every precompute at the same estimated cost; per-kind cost estimates need a cost model on the precompute kinds.
- **No artifact eviction** — cached artifacts accumulate; retention or value-decay pruning needs lifecycle logic on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The plan derives from the tables at read time so configuration changes re-rank it without rewriting recorded rows, and `anticipate` upserts so repeated idle sightings of one task refresh its expectations. The pass's own artifacts are keyed by `classKeyOf`, which is what lets `hit` find their consumers; the store never derives that key for an artifact a caller named. The pass observes its abort signal at the one unbounded wait — reading traces per tracked skill — because every other phase is bounded by `maxPerPass` and reads only local storage. The heartbeat is resolved once at init, so a host that mounts this store must have mounted the heartbeat first; the source stores are resolved on every pass instead, so their mount order is free.

</details>
