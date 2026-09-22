---
description: "Evaluator-strategy evolution: durable per-evaluator trust statistics with the per-task-class recommendation (ctx.evolutionEvaluatorStrategy)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-evaluator-strategy

English | [中文](README.zh.md)

## Summary

`dsh-evolution-evaluator-strategy` learns which evaluator to trust per task class. Each verdict pairs with its later ground truth; a self-checked verdict corroborates nothing; only independent pairs, such as a search-set pass against a holdout pass, move an evaluator's weight. §28 adds a second rule: a verdict recorded with the model that produced the candidate is the judge grading its own output, non-independent and tallied separately as `selfJudgedSamples`. Smoothed corroboration weights rank evaluators per task class; the recommendation names the most corroborated once it has enough independent samples, with §28's route on the final promotion review. Nothing here calls a model.

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

Mount the plugin with the storage domain. Callers record each evaluator verdict paired with its later ground truth and the two models involved; the ranking and recommendation answer which evaluator a task class should trust.

```ts
await ctx.evolutionEvaluatorStrategy.observe({
  evaluator: 'scorer-v1',
  taskClass: 'writer',
  candidateModel: 'deepseek-chat',
  judgeModel: 'deepseek-reasoner',
  verdict: true,
  groundTruth: true,
  independent: true,
})
const ranked = ctx.evolutionEvaluatorStrategy.ranking('writer')
const trusted = ctx.evolutionEvaluatorStrategy.recommend('writer')
```

`observe(outcome)` upserts the evaluator's statistics for its task class, counting only independent matching pairs as corroborations; `judgeIndependence(judgeModel, candidateModel)` is the §28 rule that calls a verdict from the candidate's own model `same-model`; `strategies(taskClass?)` lists rows in evaluator order; `ranking(taskClass)` ranks the class's evaluators by smoothed corroboration weight and names the route `ctx.evolutionModelRoutes` assigns to the `promotion-review` role, or `null` when none is assigned; `recommend(taskClass)` returns the best-ranked evaluator with at least `minimumSamples` independent samples, or `undefined` while no evaluator has that much independent evidence.

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

Corroboration is the only learning signal. `updatedStrategy` always raises the sample count, but only an independent pair — `outcome.independent` and a judge other than the candidate's own model — raises `independentSamples`, and only an independent pair whose verdict equals its ground truth raises `corroborations`. A verdict checked against itself, or one from the model that produced the candidate, moves nothing; the second case increments `selfJudgedSamples` so the row shows how much of its record is the judge grading its own output. `weightOf` smooths with a beta prior of one corroboration in two observations `(corroborations + 1) / (independentSamples + 2)` and returns zero with no independent evidence, so one lucky match cannot outrank a long record.

The store is a one-table domain: `evolution_evaluator_strategy` version 2 with a `strategies` table keyed by evaluator and task class joined, holding `{ evaluator, taskClass, samples, independentSamples, corroborations, selfJudgedSamples, weight, lastAt }`; version-1 rows read as zero self-judged verdicts. The ranking derives from the table at read time, so configuration changes re-rank without rewriting recorded rows.

### The strongest configured verifier (§28)

§28's topology ends at "final promotion review → strongest verifier", and `evolution-model-routes` is where that route is assigned. `ranking` and `recommend` therefore attach the route the store recommends for the `promotion-review` role to every entry as `promotionReview`, or `null` while nothing is assigned, so a recommendation says which model should re-check before its verdict is acted on. Naming it routes nothing: no run starts from a recommendation.

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
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.md) — the sibling tracking agreement, drift, and calibration of the ensemble, where this package learns which evaluator to actually trust.
- [`dsh-evolution-model-routes`](../evolution-model-routes/README.md) — the store holding the `promotion-review` route this package's recommendation names as the strongest configured verifier.

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
- **An unrecorded candidate model cannot be checked** — the §28 rule needs both model identities; a caller that records an empty `candidateModel` gets an `independent` reading, because the judge's identity cannot be shown to be the candidate's. Recording the producing route is what makes the check meaningful.
- **Record-only store, nothing calls a model** — the package learns which evaluator to trust; it never runs evaluations or changes the ensemble itself.
- **One weight per evaluator and class** — strategy weights are learned per task class in isolation; a pooled prior over similar classes needs a class taxonomy the store does not have.
- **No weight decay** — corroborations accumulate forever; a changed evaluator or task drifts to a new weight as new evidence lands, but old evidence never ages out explicitly.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The ranking derives from the table at read time so configuration changes re-rank without rewriting recorded rows, and `observe` upserts so repeated verdicts from one evaluator on one class accumulate in place. Corroboration is the only learning signal by design: non-independent pairs raise `samples` without moving the weight, so a caller that cannot yet supply an independent ground truth still records the verdict stream. The promotion-review lookup reads the model-routes store once per ranking call and treats an unmounted store as "no verifier assigned" rather than failing the ranking.

</details>