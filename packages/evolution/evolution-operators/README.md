---
description: "Mutation-operator evolution: durable per-operator mutation statistics with the exploration-adjusted next-operator ranking (ctx.evolutionOperators)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-operators

English | [中文](README.zh.md)

## Summary

`dsh-evolution-operators` records which mutation operator was used on which artifact class and whether the mutated candidate was accepted, then ranks the canonical operator portfolio so the evolution engine knows which operator to try next. Each operator's row accumulates attempts, acceptance, mean outcome delta, and the regression rate; the ranking blends a beta-prior smoothed acceptance rate with an exploration bonus that decays with samples, so proven operators lead while failing operators yield to ones never tried yet. Nothing here calls a model.

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

Mount the plugin with the storage domain. Operators record each mutation's outcome through the store; the ranking answers which operator deserves the next attempt on a skill.

```ts
await ctx.evolutionOperators.record({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  delta: 1,
})
const ranked = ctx.evolutionOperators.ranking('writer')
const next = ctx.evolutionOperators.recommend('writer')
```

`record(outcome)` upserts the operator's statistics for its artifact class with the measured accepted flag and pass-delta; `stats(artifactClass?)` lists rows in canonical operator order; `ranking(artifactClass)` ranks the portfolio — the eight canonical operators plus any deployment-specific operators observable in the stats — by the exploration-adjusted score, untried operators included; `recommend(artifactClass)` returns the ranking's top — the proven leader when evidence exists, the canonical first operator when nothing is recorded yet.

### Configuration

The store's one deployed choice, validated with a default so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `exploration` | `0.2` | Exploration bonus weight of the ranking (0 to 1). |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Account keeping is exact. `updatedStats` accumulates attempts and acceptance, folds each outcome's delta into a running mean, and recomputes the regression rate as the exact share of negative deltas over the new attempt count — never a decayed estimate. Scoring is a beta prior plus exploration: `scoreOf` smooths `(accepted + 1) / (attempts + 2)` — so an untried operator starts at its prior — and adds `exploration × sqrt(1 / (attempts + 1))`, so a failing operator yields to never-tried ones while a proven leader outranks them once it has a few accepted attempts. `rankOperators` always returns the whole portfolio — the eight canonical operators plus any deployment-specific operators observed in the stats — which keeps the portfolio complete and makes `recommend` total: with no evidence it is the canonical first operator.

The store is a one-table domain: `evolution_operators` version 1 with a `stats` table keyed by operator and artifact class joined, holding `{ operator, artifactClass, attempts, accepted, meanDelta, regressionRate, lastAt }`. The ranking derives from the table at read time, so configuration changes re-rank without rewriting recorded rows.

### Failure and recovery

Reads throw before the store starts. `record` upserts by operator and class, so repeated outcomes of one operator on one class accumulate in place rather than duplicating.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §8 and §9 — the operator portfolio and the mutation-strategy evolution this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the consumer that records each staged write's operator and outcome through the optional recorder seam.
- [`dsh-evolution-lineage`](../evolution-lineage/README.md) — the sibling recording which operator produced which experiment, feeding the same per-operator learning.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering operator rankings into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Outcome-delta is binary-pass today** — `record` folds a pass-delta (+1/0/−1) into the mean delta; richer deltas (score deltas, token savings) need the caller to define them before the row shape grows.
- **Record-only store, nothing calls a model** — the package learns which operators work; it never proposes mutation instructions or synthesizes new operators itself.
- **Per-class isolation only** — statistics are keyed by artifact class and never pooled across classes, so a class with little data leans on priors rather than on similar classes.
- **No operator retirement** — the canonical portfolio is fixed at the eight §8 operators; deployment-specific operators enter by observation only, and removing an operator needs a domain version step, not a store toggle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The ranking derives from the table at read time so configuration changes re-rank without rewriting recorded rows, and `record` upserts so repeated outcomes of one operator on one class accumulate in place. The beta-prior plus decaying-exploration score keeps `recommend` total without a minimum-samples guard: no evidence is the canonical first operator, one accepted attempt outranks every untried prior, and a failing operator yields to never-tried ones.

</details>