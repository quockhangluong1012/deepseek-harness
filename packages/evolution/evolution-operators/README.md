---
description: "Mutation-operator evolution: durable per-operator mutation statistics with the exploration-adjusted next-operator ranking and the proposed mutation instruction each operator and artifact class holds with its verdicts (ctx.evolutionOperators)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-operators

English | [中文](README.zh.md)

## Summary

`dsh-evolution-operators` records which mutation operator ran on which artifact class and whether the candidate was accepted, then ranks the canonical portfolio so the engine knows which operator to try next. Each row accumulates attempts, acceptance, mean outcome delta, and regression rate; the ranking blends a beta-prior smoothed acceptance rate with a sample-decaying exploration bonus, so proven operators lead while failing ones yield to untried ones. One proposed mutation instruction per operator and artifact class, with verdicts for and against, keeps the strategy revisable from evidence rather than a string in a package. Nothing here calls a model.

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

Mount the plugin with the storage domain. Operators record each mutation's outcome through the store; the ranking answers which operator deserves the next attempt on a skill, and the recorded instruction answers what that operator should say.

```ts
await ctx.evolutionOperators.record({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  delta: 1,
})
await ctx.evolutionOperators.recordInstruction({
  operator: 'rewrite',
  artifactClass: 'writer',
  instruction: 'Rewrite the body in the order the evidence supports.',
  reason: 'two runs regressed on rule order',
})
await ctx.evolutionOperators.judgeInstruction({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: false,
  reason: 'the holdout failed twice on the reordered body',
})
const ranked = ctx.evolutionOperators.ranking('writer')
const next = ctx.evolutionOperators.recommend('writer')
const instruction = ctx.evolutionOperators.recommendedInstruction('writer')
```

`MUTATION_OPERATOR_CATALOG` is the shared vocabulary both consumers read: one `{ id, instruction }` per canonical single-body operator, in canonical order, so the mutator that sends an instruction and this store that ranks the operator's outcomes can never drift apart. `MUTATION_OPERATORS` lists the same ids alone, in canonical order.

`record(outcome)` upserts the operator's statistics for its artifact class with the measured accepted flag and pass-delta; `stats(artifactClass?)` lists rows in canonical operator order; `ranking(artifactClass)` ranks the portfolio — the canonical operators the exported `MUTATION_OPERATOR_CATALOG` names, plus any deployment-specific operators observable in the stats — by the exploration-adjusted score, untried operators included, nudged by the instruction verdicts the class recorded; `recommend(artifactClass)` returns the ranking's top — the proven leader when evidence exists, the canonical first operator when nothing is recorded yet.

The instruction half is what lets the mutation strategy evolve (§9). `recordInstruction(input)` stores the instruction line an operator and artifact class should send, with the evidence that motivated it; `judgeInstruction(verdict)` records whether that proposal was accepted and why, and rejects a verdict on a pair that holds no proposal; `instruction(operator, artifactClass)` reads one row; `instructions(artifactClass?)` lists them in canonical operator order; `recommendedInstruction(artifactClass)` returns the instruction the ranking's leader holds, undefined while that leader holds no proposal. The ranking is nudged by `instructionWeight × (accepted − rejected) / verdicts`, bounded by the weight, so a rejected instruction sinks its operator below the untried priors and an accepted one lifts it above them.

### Configuration

The store's two deployed choices, validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `exploration` | `0.2` | Exploration bonus weight of the ranking (0 to 1). |
| `instructionWeight` | `0.2` | Weight of the instruction-verdict adjustment (0 to 1). |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Account keeping is exact. `updatedStats` accumulates attempts and acceptance, folds each outcome's delta into a running mean, and recomputes the regression rate as the exact share of negative deltas over the new attempt count — never a decayed estimate. Scoring is a beta prior plus exploration: `scoreOf` smooths `(accepted + 1) / (attempts + 2)` — so an untried operator starts at its prior — and adds `exploration × sqrt(1 / (attempts + 1))`, so a failing operator yields to never-tried ones while a proven leader outranks them once it has a few accepted attempts. `rankOperators` always returns the whole portfolio — the canonical operators of `MUTATION_OPERATOR_CATALOG` plus any deployment-specific operators observed in the stats — which keeps the portfolio complete and makes `recommend` total: with no evidence it is the canonical first operator.

The instruction row is a second, slower signal on the same pair. Its identity is the operator and artifact class, so a re-proposed instruction replaces the previous one: `proposedInstruction` counts another proposal, keeps the verdicts when the text is unchanged, and starts the tally over when the text differs, because the evidence judged the old text and not the pair. A proposal carries no weight until a verdict decides it, which is why `instructionAdjustment` returns nothing for a row with no verdicts: proposing is cheap, and only judged evidence moves the ranking.

The store is a two-table domain: `evolution_operators` version 1 with a `stats` table keyed by operator and artifact class joined, holding `{ operator, artifactClass, attempts, accepted, meanDelta, regressionRate, lastAt }`, and an `instructions` table keyed the same way holding `{ operator, artifactClass, instruction, reason, proposals, accepted, rejected, lastVerdict, at, decidedAt }`. The ranking derives from the tables at read time, so configuration changes re-rank without rewriting recorded rows, and the instruction table is a new table rather than a changed one, so a domain committed before it opens unchanged.

### Meta-evolution levels (§26)

§26's ladder climbs from artifacts (level 1) over workflows (2) and mutation strategy (3) and evaluation strategy (4) to resource allocation (5). This store covers level 3's recorded half and only that:

- **Covered here** — which mutation operator an artifact class's evidence supports, and the instruction that operator proposes, with the verdicts that decided it.
- **Not covered here** — level 4 is [`dsh-evolution-evaluator-strategy`](../evolution-evaluator-strategy/README.md) and level 5 is [`dsh-evolution-budget`](../evolution-budget/README.md); levels 1 and 2 are the optimizer's own.
- **Unreachable while the optimizer ships `disabled: true`** — the web profile mounts [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) disabled, so the only recorded producer of an operator outcome or an instruction verdict is a caller that is not running. The operator vocabulary and the instruction lines a mutation request sends are this store's `MUTATION_OPERATOR_CATALOG`, which that package imports; this store records a proposal and recommends it, and nothing here rewrites the catalog.

### Failure and recovery

Reads throw before the store starts. `record` upserts by operator and class, so repeated outcomes of one operator on one class accumulate in place rather than duplicating; `judgeInstruction` rejects a pair that holds no proposal, so evidence always names an instruction that was made. Re-proposing a text replaces the row rather than appending, which is the ceiling of this record: the pair's history of earlier texts and their verdicts is not kept.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §8, §9, and §26 — the operator portfolio, the mutation-strategy evolution, and the meta-evolution ladder this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the consumer that imports `MUTATION_OPERATOR_CATALOG` as its mutation portfolio and records each staged write's operator and outcome through the optional recorder seam.
- [`dsh-evolution-actuator`](../evolution-actuator/README.md) — the loop that reads a recommended instruction when stagnation recovery reaches §32's new-operators rung.
- [`dsh-evolution-budget`](../evolution-budget/README.md) — the level-5 store pricing the search these operators drive.
- [`dsh-evolution-lineage`](../evolution-lineage/README.md) — the sibling recording which operator produced which experiment, feeding the same per-operator learning.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering operator rankings or a recommended instruction into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Outcome-delta is binary-pass today** — `record` folds a pass-delta (+1/0/−1) into the mean delta; richer deltas (score deltas, token savings) need the caller to define them before the row shape grows.
- **A recommendation is not a rewrite** — the store records the instruction one operator and class proposes and whose verdicts it earned; it never rewrites the instruction catalog the disabled optimizer sends, so applying a proposal is a deployment decision.
- **One instruction per pair, and only its current verdicts** — a re-proposed text starts its tally over, so an earlier text's record is dropped rather than archived, and the verdict count is not decayed when the artifact class changes under it.
- **Per-class isolation only** — statistics and instructions are keyed by artifact class and never pooled across classes, so a class with little data leans on priors rather than on similar classes.
- **No operator retirement** — the canonical portfolio is fixed at the vocabulary `MUTATION_OPERATOR_CATALOG` holds; deployment-specific operators enter by observation only, and removing an operator needs a domain version step, not a store toggle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The ranking derives from the tables at read time so configuration changes re-rank without rewriting recorded rows, and `record` upserts so repeated outcomes of one operator on one class accumulate in place. The beta-prior plus decaying-exploration score keeps `recommend` total without a minimum-samples guard: no evidence is the canonical first operator, one accepted attempt outranks every untried prior, and a failing operator yields to never-tried ones. The instruction adjustment is bounded by its weight and sits on top of that score rather than replacing it, so a proposal can reorder operators that outcome evidence has left tied without overturning a proven leader.

</details>
