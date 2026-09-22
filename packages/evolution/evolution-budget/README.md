---
description: "Evolution budget: per-batch budget allocations priced by candidate class with spend settlements and the halving schedule (ctx.evolutionBudget)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-budget

English | [中文](README.zh.md)

## Summary

`dsh-evolution-budget` records how evolution spends its compute and prices it by candidate class. Each batch receives an allocation built from the base ceilings — high-potential candidates get twice the base, novel candidates an exploration allowance, low-potential candidates a cheap early-stop screen — and every spend settles against it with the exact remaining and exceeded margins. The successive-halving schedule answers how a screening pass shrinks a candidate pool round by round. Nothing here calls a model.

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

Mount the plugin with the storage domain. Operators allocate a budget for each batch and record spends against it; the store settles the cumulative spend against the allocation.

```ts
const allocation = await ctx.evolutionBudget.allocate({
  batchId: 'run-42',
  taskClass: 'writer',
  candidateClass: 'high-potential',
})
const settlement = await ctx.evolutionBudget.spend('run-42', {
  tokens: 30000,
  wallTimeMs: 900000,
  rollouts: 6,
})
const rounds = halvingRounds(100, 0.5, 3)
```

`allocate(input)` prices the batch's candidate class against the base ceilings and upserts by batch identity; `spend(batchId, input)` records one spend and returns the cumulative settlement across every spend of the batch; `batches(taskClass?)` lists allocations in batch-id order; `spends(batchId?)` lists spend records newest first; `withinBudget(batchId)` reports whether the cumulative spend stays inside the allocation. The pure helpers `multiplierFor`, `buildAllocation`, `settle`, `withinAllocation`, and `halvingRounds` are exported for callers that need the arithmetic off the store.

### Configuration

The store's deployed base ceilings, validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `baseMaxTokens` | `20000` | Base token ceiling of one standard batch. |
| `baseMaxWallTimeMs` | `600000` | Base wall-time ceiling of one standard batch, in milliseconds. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Pricing is pure and exact. `multiplierFor` maps the four §37 candidate classes to their budget multipliers; `buildAllocation` multiplies the base ceilings and names every number in the reason; `settle` sums the batch's spend records and reports `remaining` floored at zero plus `exceeded` carrying what ran past, on both dimensions; `halvingRounds` shrinks an evaluated pool by the keep fraction every round and never keeps fewer than one (§38).

The store is a two-table domain: `evolution_budget` version 1 with an `allocations` table keyed by batch identity holding `{ batchId, taskClass, candidateClass, maxTokens, maxWallTimeMs, reason, at }` and a `spends` table keyed by batch identity plus a per-record key holding `{ batchId, tokens, wallTimeMs, rollouts, at }`. Settlements derive from the tables at read time, so a spend record is never rewritten when later spends land.

### Failure and recovery

Reads throw before the store starts. `spend` rejects an unknown batch identity loudly, so a spend always names a batch the policy priced. `allocate` upserts by batch identity, so re-allocating a batch re-prices it in place.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check them against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §37 and §38 — the evolution budget controller and successive halving this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the consumer that records each staged write's allocation and spend through the optional recorder seam.
- [`dsh-evolution-sleeptime`](../evolution-sleeptime/README.md) — the sibling pricing offline compute, where this package prices the online search budget.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering allocations or settlements into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Allocations are records, not enforcement** — the store prices and settles; it never gates a run, so a spend past its allocation is reported, not blocked (§58.12 record-not-enforced).
- **Candidate class comes from the caller** — the store prices whatever class the caller names; it never classifies a candidate itself, so an early-stop screen needs the caller to rate potential first.
- **Linear class pricing** — the multipliers are fixed per class; learning the multipliers from settled outcomes needs a feedback loop this store does not have.
- **No cost ceilings** — the allocations bound tokens and wall time; a dollar cost ceiling would need a pricing source the package deliberately does not assume.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Settlements derive from the spend table at read time, so one batch accumulates spend records and each `spend` call settles the whole history without rewriting earlier records. `spend` rejects an unknown batch so every spend names a priced allocation. The halving arithmetic stays pure and off the store, so a screening pass can preview its rounds without recording anything.

</details>