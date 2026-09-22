---
description: "Evolution budget: per-batch budget allocations priced by candidate class across §37's five dimensions, the spends settled against them with exact margins, the recorded candidate pool with the halving schedule, and the §27 resource objectives (ctx.evolutionBudget)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-budget

English | [中文](README.zh.md)

## Summary

`dsh-evolution-budget` records how evolution spends its compute, priced by candidate class. Each batch's allocation comes from base ceilings (high-potential twice base, novel an exploration allowance, low-potential a cheap early-stop screen) over all five §37 dimensions, and every spend settles with exact remaining and exceeded margins. The policy decides candidate class from the batch's recorded pool; the successive-halving schedule answers how a screening pass shrinks that pool per round. The same records answer §27's objectives: quality, reliability, latency, cost, and background compute are measured; memory footprint and context usage read unmeasured, their missing record named. Nothing here calls a model.

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

Mount the plugin with the storage domain. A caller records the candidates a batch screens, allocates each one the class its evidence earned, records the spends, and reads the schedule and the objectives the records answer.

```ts
await ctx.evolutionBudget.recordPool({
  batchId: 'run-42',
  taskClass: 'writer',
  candidates: [{ candidateId: 'c1', runs: 2, passes: 2, novelty: 0 }],
})
const allocation = await ctx.evolutionBudget.allocateForCandidate('run-42', 'c1')
const settlement = await ctx.evolutionBudget.spend('run-42', {
  tokens: 30000,
  wallTimeMs: 900000,
  rollouts: 6,
  cost: 4,
  parallelism: 3,
})
const schedule = ctx.evolutionBudget.schedule('run-42')
const objectives = ctx.evolutionBudget.objectives('run-42')
const rounds = halvingRounds(100, 0.5, 3)
```

`recordPool(input)` upserts the batch's candidates by candidate identity and returns the pool; `allocateForCandidate(batchId, candidateId)` prices the class the §37 policy decides from that candidate's recorded evidence and names the branch in the allocation's reason; `allocate(input)` prices the class the caller names; `spend(batchId, input)` records one spend and returns the cumulative settlement across every spend of the batch; `pool(batchId)` lists the recorded pool in candidate-id order; `schedule(batchId)` derives the §38 rounds from that pool; `objectives(batchId)` reads the §27 objectives; `batches(taskClass?)` lists allocations in batch-id order; `spends(batchId?)` lists spend records newest first; `withinBudget(batchId)` reports whether the cumulative spend stays inside every measured ceiling. The pure helpers `multiplierFor`, `buildAllocation`, `dimensionCeilings`, `poolKey`, `recordedTotal`, `settle`, `withinAllocation`, `halvingRounds`, `screeningSchedule`, `policyFor`, and `objectiveReadings` are exported for callers that need the arithmetic off the store.

### Configuration

The store's deployed ceilings, policy bars, and screening schedule, validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `baseMaxTokens` | `20000` | Base token ceiling of one standard batch. |
| `baseMaxWallTimeMs` | `600000` | Base ceiling on the wall time a batch's spends sum to. |
| `baseMaxCost` | `10` | Base cost ceiling, in the deployment's cost units. |
| `baseTimeLimitMs` | `86400000` | Base deadline of one standard batch, measured from its allocation instant. |
| `baseParallelism` | `4` | Base concurrency ceiling of one standard batch. |
| `keepFraction` | `0.5` | Share of evaluated candidates each screening round keeps. |
| `screeningRounds` | `3` | Screening rounds the §38 schedule derives. |
| `provenPasses` | `1` | Recorded passes that make a candidate proven high-potential. |
| `lowPotentialRuns` | `1` | Recorded evaluations a zero-pass candidate needs to count as low-potential. |
| `noveltyThreshold` | `0.5` | Novelty that earns an unproven candidate the exploration branch. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Pricing is pure and exact. `multiplierFor` maps the four §37 candidate classes to their budget multipliers; `buildAllocation` multiplies the base token and wall-time ceilings and names every number in the reason; `dimensionCeilings` prices §37's cost, deadline, and parallelism ceilings by the same multiplier and appends its own clause — a batch always keeps one worker, so halving the base never rounds the concurrency ceiling away; `settle` sums the batch's spend records and reports `remaining` floored at zero plus `exceeded` carrying what ran past, on both dimensions, beside a `BudgetMargin` for cost, deadline, and parallelism; `halvingRounds` shrinks an evaluated pool by the keep fraction every round and never keeps fewer than one (§38).

`buildAllocation`, `withinAllocation`, `settle`, and `multiplierFor` keep the signatures the evolution actuator calls: the three dimensions §37 added arrive as optional fields on the record, priced by `dimensionCeilings`, so a caller written against the frozen four builds the same allocation it always did.

The allocation policy is one pure rule over recorded evidence (§37). `policyFor` reads a candidate's recorded runs, passes, and novelty against the deployment's bars: a candidate that has passed reaches the more-budget branch and is priced high-potential; otherwise a measured candidate whose novelty is under the bar is what early stop is for; otherwise a novel candidate keeps the exploration allowance, because a few failures of something unlike anything tried generalize to nothing; otherwise the standard batch. A proven candidate leads whatever else its record says, and the recorded allocation carries the branch's sentence in its reason.

A margin is measured only when both sides are recorded. `settle` reports the token and wall-time margins always, because every spend records both, and cost, deadline, and parallelism only when the allocation prices the ceiling and every spend of the batch records the measurement — a partial sum would read as a whole-batch total, and a peak over part of a batch could sit below a ceiling the batch crossed. The deadline is the elapsed time from the allocation instant to the last recorded spend, so a batch with no recorded activity has nothing to measure against, and an instant that does not parse leaves the dimension unmeasured rather than reporting zero. `withinAllocation` reads that settlement, so every priced and recorded dimension it reports is one a caller can gate on — which is how the actuator's budget loop enforces a dimension this package added without being changed itself.

The §27 objectives are read, never estimated. `objectiveReadings` derives quality as the pass share over the pool's evaluations and reliability as the share of twice-evaluated candidates that passed every time — the one repetition reading the pool holds — then latency as mean wall time per evaluated rollout, cost as the billed tokens the spends recorded, and background compute as the offline tokens they attributed to the batch. Memory footprint and context usage read null with the missing record named, because no store in the harness records either.

The store is a three-table domain: `evolution_budget` version 1 with an `allocations` table keyed by batch identity holding `{ batchId, taskClass, candidateClass, maxTokens, maxWallTimeMs, maxCost, timeLimitMs, parallelism, reason, at }`, a `spends` table keyed by batch identity plus a per-record key holding `{ batchId, tokens, wallTimeMs, rollouts, cost, parallelism, backgroundTokens, at }`, and a `pools` table keyed by batch identity plus candidate identity holding `{ batchId, candidateId, taskClass, runs, passes, novelty, at }`. Settlements and schedules derive from the tables at read time, so a spend record is never rewritten when later spends land. The dimensions §37 added and the pool table arrive as optional fields and a new table, so a domain committed before them opens unchanged — the row schema declares them optional rather than defaulted, because an absent ceiling is a dimension nothing priced, not a ceiling of zero.

### Meta-evolution levels (§26)

§26's ladder climbs from artifacts (level 1) over workflows (2) and mutation strategy (3) and evaluation strategy (4) to resource allocation (5). This store covers level 5's recorded half and only that:

- **Covered here** — how much search budget each candidate earns, from the class its recorded evidence supports, with the settlement that says what the batch actually spent.
- **Not covered here** — level 3 is [`dsh-evolution-operators`](../evolution-operators/README.md) and level 4 is [`dsh-evolution-evaluator-strategy`](../evolution-evaluator-strategy/README.md); levels 1 and 2 are the optimizer's own.
- **Unreachable while the optimizer ships `disabled: true`** — the web profile mounts [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) disabled, so the only recorded producer of an allocation is a caller that is not running. The multipliers and the policy bars stay configured rather than learned: learning them needs settled outcomes from batches that ran, and those arrive with the optimizer. The screen that would consume the halving schedule is likewise the optimizer's — this package derives the schedule from the recorded pool and records the pool, and stops there.

### Failure and recovery

Reads throw before the store starts. `spend` rejects an unknown batch identity loudly, so a spend always names a batch the policy priced; `allocateForCandidate` rejects a candidate the batch's pool does not hold; `objectives` rejects an unknown batch. `allocate` upserts by batch identity, so re-allocating a batch re-prices it in place, and `recordPool` upserts by candidate identity, so a re-recorded candidate replaces its evidence and leaves its siblings alone. `schedule` returns undefined for a batch that recorded no pool, rather than an empty schedule that would read as a screened batch.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check them against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §9, §26, §27, §37, and §38 — the mutation-strategy ladder, the resource-aware objectives, the evolution budget controller, and successive halving this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the consumer that records each staged write's allocation and spend through the optional recorder seam, and the screen the halving schedule leaves to it.
- [`dsh-evolution-operators`](../evolution-operators/README.md) — the level-3 store whose operator ranking prices the search this budget pays for.
- [`dsh-evolution-metrics`](../evolution-metrics/README.md) — the metric layer that reads these spends for the compute-overhead ratio instead of adding a second cost reading.
- [`dsh-evolution-sleeptime`](../evolution-sleeptime/README.md) — the sibling pricing offline compute, where this package prices the online search budget and reads the background tokens a batch attributed.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering allocations or settlements into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Allocations are records, not enforcement** — the store prices and settles; it never blocks a run itself, and the gate that acts on a settlement lives in the caller that reads it — the actuator's budget loop, which leaves a spent class's work alone (§58.12 record-not-enforced).
- **A priced dimension is unmeasured until a deployment records it** — cost, deadline, and parallelism need the allocation's ceiling and every spend's measurement; until then `withinBudget` cannot see a violation on that dimension.
- **The policy bars are configuration, not learning** — §26's level 5 evolves resource allocation by learning the multipliers and the bars from settled outcomes; this store applies the configured values and records which branch produced each allocation.
- **The screen between rounds is the optimizer's** — the store derives how many candidates each §38 round evaluates and keeps, and records the pool it derived that from; which candidate a round actually keeps is the disabled optimizer's decision, so nothing here records a survivor verdict.
- **The deadline runs on the calendar, not on work** — it is the span from the allocation to the last recorded spend, so a batch left open past its deadline reads as spent even if little work happened, and a caller gating on `withinBudget` (the actuator's budget loop does) then leaves that class alone until a newer allocation prices it. Raise `baseTimeLimitMs` past the deployment's pass cadence when that is not what a stale batch should mean.
- **Two cost notions** — §27's cost objective reads the billed tokens a spend recorded, which is the unit the rest of the harness compares (the rollout monitor's cost factor, the compute-overhead ratio), while `maxCost`/`cost` carry the deployment's own billing unit when one exists. A deployment that bills in tokens leaves the cost dimension unrecorded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Settlements derive from the spend table at read time, so one batch accumulates spend records and each `spend` call settles the whole history without rewriting earlier records. `spend` rejects an unknown batch so every spend names a priced allocation, and `allocateForCandidate` rejects a candidate the pool does not hold so a policy-priced class always traces to recorded evidence. The halving arithmetic stays pure and off the store, so a screening pass can preview its rounds without recording anything, and `screeningSchedule` holds the one guard the pool needs: an empty pool has no rounds, because otherwise the arithmetic would keep one candidate out of nothing.

</details>
