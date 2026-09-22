---
description: "Evaluator-strategy evolution: durable per-evaluator trust statistics with the per-task-class recommendation (ctx.evolutionEvaluatorStrategy)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-evaluator-strategy

English | [中文](README.zh.md)

## Summary

`dsh-evolution-evaluator-strategy` learns which evaluator to trust for which task class. Each recorded verdict is paired with its later ground truth; a verdict checked against itself corroborates nothing, so only independent pairs — for example a search-set pass checked against a holdout pass — move an evaluator's weight. The smoothed corroboration weight ranks evaluators per task class, and the recommendation names the most corroborated evaluator once it has enough independent samples. Nothing here calls a model.

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

Mount the plugin with the storage domain. Callers record each evaluator verdict paired with its later ground truth; the ranking and recommendation answer which evaluator a task class should trust.

```ts
await ctx.evolutionEvaluatorStrategy.observe({
  evaluator: 'scorer-v1',
  taskClass: 'writer',
  verdict: true,
  groundTruth: true,
  independent: true,
})
const ranked = ctx.evolutionEvaluatorStrategy.ranking('writer')
const trusted = ctx.evolutionEvaluatorStrategy.recommend('writer')
```

`observe(outcome)` upserts the evaluator's statistics for its task class, counting only independent matching pairs as corroborations; `strategies(taskClass?)` lists rows in evaluator order; `ranking(taskClass)` ranks the class's evaluators by smoothed corroboration weight; `recommend(taskClass)` returns the best-ranked evaluator with at least `minimumSamples` independent samples, or `undefined` while no evaluator has that much independent evidence.

### Configuration

The store's one deployed choice, validated with a default so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `minimumSamples` | `3` | Independent samples an evaluator needs before it may be recommended. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Corroboration is the only learning signal. `updatedStrategy` always raises the sample count, but only an independent pair — `outcome.independent` — raises `independentSamples`, and only an independent pair whose verdict equals its ground truth raises `corroborations`. A verdict checked against itself moves nothing. `weightOf` smooths with a beta prior of one corroboration in two observations `(corroborations + 1) / (independentSamples + 2)` and returns zero with no independent evidence, so one lucky match cannot outrank a long record.

The store is a one-table domain: `evolution_evaluator_strategy` version 1 with a `strategies` table keyed by evaluator and task class joined, holding `{ evaluator, taskClass, samples, independentSamples, corroborations, weight, lastAt }`. The ranking derives from the table at read time, so configuration changes re-rank without rewriting recorded rows.

### Failure and recovery

Reads throw before the store starts. `observe` upserts by evaluator and class, so repeated verdicts from one evaluator on one class accumulate in place rather than duplicating.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §9 — learning which evaluators produce useful improvements, the foundation of meta-evolution.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the consumer that records each staged write's scorer verdict paired with its holdout ground truth through the optional recorder seam.
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.md) — the sibling tracking agreement and drift of the ensemble, where this package learns which evaluator to actually trust.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering rankings into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Ground truth comes from the caller** — the store judges verdicts against whatever ground truth the caller supplies; it never measures a held-out outcome itself, so an `independent: true` pair is only as independent as its caller.
- **Record-only store, nothing calls a model** — the package learns which evaluator to trust; it never runs evaluations or changes the ensemble itself.
- **One weight per evaluator and class** — strategy weights are learned per task class in isolation; a pooled prior over similar classes needs a class taxonomy the store does not have.
- **No weight decay** — corroborations accumulate forever; a changed evaluator or task drifts to a new weight as new evidence lands, but old evidence never ages out explicitly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The ranking derives from the table at read time so configuration changes re-rank without rewriting recorded rows, and `observe` upserts so repeated verdicts from one evaluator on one class accumulate in place. Corroboration is the only learning signal by design: non-independent pairs raise `samples` without moving the weight, so a caller that cannot yet supply an independent ground truth still records the verdict stream.

</details>