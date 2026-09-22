---
description: "Meta-evolution: durable engine runs under their configurations with the next-configuration recommendation (ctx.evolutionMeta)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-meta

English | [中文](README.zh.md)

## Summary

`dsh-evolution-meta` evolves the evolution engine itself. Every engine run is recorded under the engine configuration its choices produced — the mutation-operator portfolio, the evaluator, the budget identity, and the routing — and summaries derive the pass rate and mean tokens of each configuration per task class. The recommendation ranks configurations by a sample-confidence-adjusted score, so the engine learns which configuration to run next on a task class instead of always using the same one. Nothing here calls a model.

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

Mount the plugin with the storage domain. Callers record each engine run with the configuration it used; the recommendation answers which configuration the next run on a task class should use.

```ts
await ctx.evolutionMeta.record({
  runId: 'run-42',
  taskClass: 'writer',
  config: {
    operators: 'portfolio-v1',
    evaluator: 'scorer-v1',
    budget: 'balanced-v1',
    routing: 'deepseek/chat',
  },
  pass: true,
  tokens: 5000,
  wallTimeMs: 60000,
})
const next = ctx.evolutionMeta.recommend('writer')
```

`record(input)` appends one engine run, completing a partial configuration with the default choices; `runs(taskClass?)` lists runs newest first; `summaries(taskClass?)` derives per-configuration pass rates and mean tokens at read time; `recommend(taskClass)` returns the best-scored configuration with at least `minimumSamples` runs, or `undefined` while no configuration has that much evidence.

### Configuration

The store's deployed choices, validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `minimumSamples` | `3` | Runs a configuration needs before it may be recommended. |
| `defaultConfig` | `portfolio-v1 / scorer-v1 / balanced-v1 / evidence-v1` | Engine configuration used when a recorded run names no choice. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Identity is deterministic and evidence is derived. `configIdOf` joins the four choices in fixed order, so equal configurations always share one identity and the field order of the caller's object never matters. `summarize` groups runs by task class and configuration identity and folds running pass rates and mean tokens; `scoreOf` smooths the pass rate with a beta prior and scales it by how close the sample count is to the minimum — `(passes + 1) / (samples + 2) × min(1, samples / minimumSamples)` — so a configuration with one lucky run cannot outrank a well-measured one.

The store is a one-table domain: `evolution_meta` version 1 with a `runs` table keyed by run identity holding `{ runId, taskClass, config, pass, tokens, wallTimeMs, at }`. Summaries derive from the table at read time, so a new run never rewrites earlier ones.

### Failure and recovery

Reads throw before the store starts. `record` appends runs as events, so the run stream is append-only and the summary view is always a pure derivation of it, with a partial configuration completed by the configured default.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §9 — the self-referential evolution this package implements, the foundation of meta-evolution.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the consumer that records each staged write's engine run through the optional recorder seam.
- [`dsh-evolution-operators`](../evolution-operators/README.md), [`dsh-evolution-evaluator-strategy`](../evolution-evaluator-strategy/README.md), [`dsh-evolution-budget`](../evolution-budget/README.md), and [`dsh-evolution-router`](../evolution-router/README.md) — the four component learners this package composes into one engine configuration.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering summaries into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Recommendations are records, not engine policy** — the store learns and recommends; it never instantiates an engine configuration itself, so a recommendation is only as good as the caller that follows it (§58.12 record-not-enforced).
- **Configurations are opaque keys** — each component choice is an opaque string; the store cannot know that `portfolio-v2` differs from `portfolio-v1` in any particular way without a component registry.
- **One task class per model of learning** — summaries are learned per task class in isolation; a pooled engine prior over similar classes needs a taxonomy the store does not have.
- **No cross-component attribution** — when two components differ between configurations, the store cannot say which one caused a pass-rate change; isolated ablations need the lineage store alongside.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Summaries derive from the run table at read time, so the run stream stays append-only and a new run never rewrites earlier ones. `record` completes a partial configuration with the default choices, so callers that know some components but not others never lose the rest. The score's sample-confidence factor means `recommend` needs no separate minimum-samples guard beyond the config's `minimumSamples`.

</details>