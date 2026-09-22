---
description: "Sleep-time compute: anticipated future tasks with precomputed reasoning artifacts under an offline-cost economic policy (ctx.evolutionSleeptime)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-sleeptime

English | [中文](README.zh.md)

## Summary

`dsh-evolution-sleeptime` anticipates likely future tasks during idle time and caches precomputed reasoning artifacts — summaries, retrieval structures, candidate plans — for them. Each task carries its likelihood, expected queries, and per-query savings; precomputation is worth it only when the likelihood-weighted savings beat the offline cost, and the greedy plan fits the best nets into the offline budget. Served artifacts record hits and saved tokens, so realized savings stay visible against offline spend. Nothing here calls a model.

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

Mount the plugin with the storage domain. Operators anticipate likely future tasks whenever idle time is expected; precompute caches one reasoning artifact per anticipated task; each served query records a hit so the artifact's realized savings stay visible.

```ts
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

`anticipate(input)` upserts by task identity so a re-anticipated task refreshes its likelihood and expectations. `tasks(domain?)` lists tasks likeliest first; `precompute(input)` caches one artifact for an anticipated task and rejects unknown tasks loudly; `artifacts(taskId?)` lists artifacts newest first; `hit(artifactId, savedTokens)` records one served query; `plan(estimatedCostTokens?, budgetTokens?)` returns the greedy budgeted plan over tasks with no cached artifact yet.

### Configuration

The store's deployed choices, with defaults suitable for a small nightly idle window; both are validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `defaultEstimatedCostTokens` | `2000` | Estimated offline tokens of one precompute, used when the caller names none. |
| `maxOfflineTokens` | `50000` | Total offline token budget of one plan, used when the caller names none. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Economics are pure. `expectedNet` weights one task's expected savings by its likelihood and subtracts the estimated offline cost, so a task that never materializes still costs its precompute. `decideWorth` needs a strictly positive net: a net of exactly zero spends idle time for nothing. `planFor` keeps only worth-it decisions, sorts net descending with task-id ascending tie-break, and takes them greedily while the cumulative estimated cost still fits the budget. `savingsOf` subtracts an artifact's offline cost from the tokens its hits have saved, staying negative until the precompute pays back.

The store is a two-table domain: `evolution_sleeptime` version 1 with a `tasks` table keyed by task identity holding `{ taskId, domain, scope, likelihood, expectedQueries, expectedSavingTokens, at }` and an `artifacts` table keyed by artifact identity holding `{ artifactId, taskId, kind, summary, offlineCostTokens, hits, savedTokens, at }`. The plan derives from the current tables at read time, so configuration changes re-rank the plan without rewriting recorded rows.

### Failure and recovery

Reads throw before the store starts. `precompute` rejects an unknown task identity and `hit` rejects an unknown artifact identity, so an artifact always names a real anticipated task and a hit always lands on a real cached artifact. `anticipate` upserts by task identity, so a re-anticipated task refreshes in place rather than duplicating.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check them against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §25 — the sleep-time compute this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.md) — the future idle driver whose quiet ticks will trigger anticipation and precomputation once wired.
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

- **Heartbeat wiring deferred** — anticipation and precomputation are operator-driven today; the heartbeat's idle ticks do not trigger them yet, so idle time is planned, not yet automatic.
- **Record-only store, nothing calls a model** — the package caches reasoning artifacts operators supply; it never generates summaries, indexes, or plans itself.
- **One estimated cost per plan** — `plan` prices every precompute at the same estimated cost; per-kind cost estimates need a cost model on the precompute kinds.
- **No artifact eviction** — cached artifacts accumulate; retention or value-decay pruning needs lifecycle logic on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The plan derives from the tables at read time so configuration changes re-rank it without rewriting recorded rows, and `anticipate` upserts so repeated idle sightings of one task refresh its expectations. Artifact ids are caller-chosen, so a future heartbeat driver can derive stable ids from the task and kind.

</details>
