---
description: "Routing self-optimization: per-task-class route outcomes with derived effectiveness and the route recommendation (ctx.evolutionRouter)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-router

English | [中文](README.zh.md)

## Summary

`dsh-evolution-router` learns which model route to use for which task class and evolutionary role. Each outcome records the route's pass, tokens, and wall time on a task class; effectiveness is derived at read time from running means and pass rates, and the recommendation ranks routes by a sample-confidence-adjusted score, so a route with few outcomes cannot outrank a well-measured one. The same outcomes answer §44: when the two most divergent routes of a task class and role measure far enough apart, the store records that disagreement as an uncertainty signal rather than guessing. Nothing here calls a model.

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

Mount the plugin with the storage domain. Callers record each routed run's outcome; the recommendation answers which route a task class and role should use.

```ts
await ctx.evolutionRouter.observe({
  taskClass: 'writer',
  role: 'evaluation',
  provider: 'deepseek',
  model: 'chat',
  pass: true,
  tokens: 1000,
  wallTimeMs: 2000,
})
const best = ctx.evolutionRouter.recommend('writer', 'evaluation')
const found = ctx.evolutionRouter.disagreements('writer', 'evaluation')
```

`observe(outcome)` appends one measured outcome, keyed per record; `outcomes(taskClass?, role?)` lists outcomes newest first; `effectiveness(taskClass?, role?)` derives per-route effectiveness with running means at read time; `recommend(taskClass, role)` returns the best-ranked route with at least `minimumSamples` measured outcomes, or `undefined` while no route has that much evidence.

`observe` then checks the task class and role it just measured: when the two most divergent measured routes disagree by at least `disagreementThreshold`, it records a `disagreement` uncertainty signal through the optional `ctx.evolutionUncertainty` seam — a route-outcome search signal, needing no second model call. `disagreements(taskClass?, role?)` returns the current strong disagreements, strongest gap first, and reports none while the measured routes agree. Nothing is routed from a disagreement: it is recorded for whoever drains the queue.

### Configuration

The store's deployed choices, validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `minimumSamples` | `3` | Outcomes a route needs before it may be recommended. |
| `disagreementMinimumRuns` | `3` | Outcomes a route needs before the disagreement comparison measures it. |
| `disagreementThreshold` | `0.5` | Pass-rate gap at which two routes count as disagreeing. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Evidence is exact and derived. `updatedEffectiveness` accumulates samples and passes and folds each outcome's tokens and wall time into running means, so `passRate`, `meanTokens`, and `meanWallTimeMs` are exact functions of the outcome stream. `scoreOf` smooths the pass rate with a beta prior and scales it by how close the sample count is to the minimum — `(passes + 1) / (samples + 2) × min(1, samples / minimumSamples)` — so one lucky pass on one sample cannot outrank a well-measured route. `rankRoutes` sorts by that score with provider/model ascending tie-break.

The store is a one-table domain: `evolution_router` version 1 with an `outcomes` table keyed per record holding `{ taskClass, role, provider, model, pass, tokens, wallTimeMs, at }`. Effectiveness derives from the table at read time, so a new outcome never rewrites earlier ones.

### Disagreement as a search signal (§44)

`routeDisagreement` takes the highest and lowest pass rates among the routes of one task class and role that carry at least `disagreementMinimumRuns` outcomes, and reports them when the gap reaches `disagreementThreshold`; fewer than two measured routes, or a gap inside the threshold, is agreement and reports nothing. Each signal's identity is derived from the task class, role, and the two routes, so re-recording the same disagreement updates one signal rather than piling up copies: a drain that empties the queue and a later pass that re-records the same disagreement converge instead of growing without bound.

### Failure and recovery

Reads throw before the store starts. `observe` appends outcomes as events, so the outcome stream is append-only and the effectiveness view is always a pure derivation of it.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §28 — the adaptive model routing this package generalizes into per-task-class self-optimization — and §44 — model disagreement as a search signal.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the consumer that records each staged write's evaluation route and outcome through the optional recorder seam.
- [`dsh-evolution-model-routes`](../evolution-model-routes/README.md) — the sibling holding per-role route assignments and evidence, where this package learns route effectiveness per task class.
- [`dsh-evolution-uncertainty`](../evolution-uncertainty/README.md) — the §44 seam that receives a strong route disagreement as an uncertainty signal.
- [`dsh-evolution-actuator`](../evolution-actuator/README.md) — the drain loop that turns a queued uncertainty signal into benchmark work.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering route effectiveness into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Outcomes are records, not routing decisions** — the store learns and recommends; it never routes a run itself, so a recommendation is only as good as the caller that follows it (§58.12 record-not-enforced).
- **Disagreement compares recorded outcomes, not live models** — the reading needs two routes measured on the same task class and role, so it detects cross-route outcome divergence rather than per-sample model disagreement: two routes that pass the same share of a task class raise nothing even if they pass different tasks within it, and a task class only one route has run has no disagreement to find. A genuine two-model comparison on the same task needs a second model call this package deliberately does not make.
- **A recorded signal waits for its drain** — the disagreement signal is written to `ctx.evolutionUncertainty` whenever the store is mounted, and nothing here consumes the queue; the actuator's drain loop is what admits and resolves it, and the scorer ships disabled, so a recorded signal may sit unread until that loop is mounted.
- **One role measured per store today** — the optimizer seam records `evaluation` outcomes only; the other four §28 roles wait for their own recorder seams.
- **Task classes are opaque keys** — effectiveness is learned per task class in isolation; a similarity structure over classes needs a taxonomy the store does not have.
- **No cost weighting** — the score ranks by pass rate and sample confidence only; a dollar-cost-adjusted score needs a pricing source the package deliberately does not assume.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Effectiveness derives from the outcome table at read time, so the outcome stream stays append-only and a new outcome never rewrites earlier ones. `observe` keys each record independently, so the same route may be measured many times without collision. The score's sample-confidence factor means `recommend` needs no separate minimum-samples guard beyond the config's `minimumSamples`. The disagreement check runs inside `observe` and swallows a failing uncertainty store with a warning, so a broken queue never fails a recorded outcome; its comparator only needs the gap and the task class, since groups are unique per task class and role.

</details>