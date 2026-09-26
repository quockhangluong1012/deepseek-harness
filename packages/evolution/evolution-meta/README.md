---
description: "Meta-evolution: durable engine runs under their configurations and workflows, with the next-workflow recommendation (ctx.evolutionMeta)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-meta

English | [中文](README.zh.md)

## Summary

`dsh-evolution-meta` evolves the evolution engine itself. Each engine run is recorded under the configuration its choices produced — mutation-operator portfolio, evaluator, budget identity, routing — together with the stage sequence that run performed, so a workflow is recorded rather than inferred from its parts. Summaries derive each configuration-and-workflow's pass rate and mean tokens per task class, and the recommendation ranks them by a sample-confidence-adjusted score, so the engine learns which configuration to run next, and in which order, instead of always reusing one. Nothing here calls a model or changes what the engine runs.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [The §26 level map](#the-26-level-map)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the storage domain. Callers record each engine run with the configuration and the workflow it used; the recommendation answers which configuration and which sequence the next run on a task class should use.

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
  workflow: [
    { component: 'operators', choice: 'portfolio-v1' },
    { component: 'evaluator', choice: 'scorer-v1' },
    { component: 'budget', choice: 'balanced-v1' },
    { component: 'routing', choice: 'deepseek/chat' },
  ],
  pass: true,
  tokens: 5000,
  wallTimeMs: 60000,
})
const next = ctx.evolutionMeta.recommend('writer')
```

`record(input)` appends one engine run, completing a partial configuration with the default choices and storing the workflow as given — an absent workflow records that the caller observed none, never an invented order. `runs(taskClass?)` lists runs newest first; `summaries(taskClass?)` derives per-configuration-and-workflow pass rates and mean tokens at read time; `recommend(taskClass)` returns the best-scored configuration and workflow with at least `minimumSamples` runs, or `undefined` while no configuration has that much evidence.

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

Identity is deterministic and evidence is derived. `configIdOf(config, workflow)` joins the four choices in fixed order and closes them with `workflowIdOf(workflow)`, so equal configurations run in the same order always share one identity, and the same components run in a different order are two identities — which is what makes the recommendation name a sequence rather than a scalar. `summarize` groups runs by task class and that identity and folds running pass rates and mean tokens; `scoreOf` smooths the pass rate with a beta prior and scales it by how close the sample count is to the minimum — `(passes + 1) / (samples + 2) × min(1, samples / minimumSamples)` — so a configuration with one lucky run cannot outrank a well-measured one.

A workflow is recorded, not synthesized. Each step names the component it reached for and the choice it used, in the position the run performed it; the store accepts the sequence as given and never derives one from the configuration, because two orders of the same components are exactly the difference level 2 exists to learn. A summary whose runs recorded no sequence reports `workflowUnrecorded` in its reason instead of presenting a scalar choice as a workflow.

The store is a one-table domain: `evolution_meta` version 2 with a `runs` table keyed by run identity holding `{ runId, taskClass, config, workflow, pass, tokens, wallTimeMs, at }`. Version 1 stored runs without the sequence they performed; the field defaults to an empty workflow, so vouched-for v1 runs open unchanged. Summaries derive from the table at read time, so a new run never rewrites earlier ones.

### Failure and recovery

Reads throw before the store starts. `record` appends runs as events, so the run stream is append-only and the summary view is always a pure derivation of it, with a partial configuration completed by the configured default and an unrecorded workflow stored as empty.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="the-26-level-map"></a>
## The §26 level map

The specification's §26 ladder has five levels, and the package family implements them as five stores that record and recommend. Each level's store exists, derives its reading, and answers through its own command; what none of them does is populate itself, because the engine row that records a run — `evolution-optimizer` — ships `disabled: true`, so a shipped host runs no evolution and every one of the five reads empty until a profile or `--patch` overlay enables it.

| Level | What it evolves | Store that covers it | State |
|---|---|---|---|
| 1 — artifacts | The staged artifact itself: a SKILL.md body, a prompt, a configuration | `evolution-optimizer`, with `evolution-population`, `evolution-canary`, and `evolution-lineage` holding its candidates, rollouts, and envelopes | Implemented, **unreachable** while the optimizer is disabled: no run stages a write, so nothing is recorded at any level |
| 2 — workflows | The sequence the engine runs: which operator, which evaluator, which budget class, in what order | `evolution-meta` (this store) — `workflow` and `workflowId` on every run, summary, and recommendation | Implemented and inspectable; **unreachable** until a run records a sequence, because the optimizer's recorder seam is the only writer |
| 3 — mutation strategy | Which mutation operator works for which artifact class | `evolution-operators` — operator portfolios ranked per artifact class | Same gate; levels 3–5 stay records, not policies (§26's governance cap) |
| 4 — evaluation strategy | Which evaluator catches regressions, and how much benchmark is enough | `evolution-evaluator-strategy`, with `evolution-evaluator-health` and `evolution-benchmark` supplying its evidence | Same gate |
| 5 — resource allocation | How much search budget to allocate, when to exploit versus explore, and which route to take | `evolution-budget` and `evolution-model-routes` | Same gate |

Two consequences follow, and the package READMEs state them rather than papering over them:

- **A disabled writer is not an implemented level.** Level 2's axis is real — a workflow is recorded, given identity, grouped, scored, and recommended — but a shipped host records no run, so the honest reading of `ctx.evolutionMeta.summaries()` in the shipped profile is "no engine run has been recorded", not "no workflow works". The same sentence applies to levels 3–5, whose stores are mounted and whose commands answer.
- **Nothing at any level changes what the engine runs.** Every one of the five stores is a record plus a recommendation. Applying a recommendation is the decision §26 defers to "after strong governance exists", and no shipped path takes it: `/meta recommend`, `/operators`, `/evaluator-strategy`, `/budget`, and `/router` report what the stores learned.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §26 — the meta-evolution ladder this package implements level 2 of, on the §9 foundation.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the consumer that records each staged write's engine run and workflow through the optional recorder seam, and the row that ships disabled.
- [`dsh-evolution-operators`](../evolution-operators/README.md), [`dsh-evolution-evaluator-strategy`](../evolution-evaluator-strategy/README.md), [`dsh-evolution-budget`](../evolution-budget/README.md), and [`dsh-evolution-model-routes`](../evolution-model-routes/README.md) — the four component learners this package composes into one engine configuration.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering summaries into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Recommendations are records, not engine policy** — the store learns and recommends; it never instantiates an engine configuration or a workflow itself, so a recommendation is only as good as the caller that follows it (§58.12 record-not-enforced).
- **The workflow is as complete as the caller's report** — a run that records no sequence is grouped with every other unreported run of the same configuration, and the store cannot tell an engine that skipped a stage from one that did not report it.
- **Configurations are opaque keys** — each component choice is an opaque string; the store cannot know that `portfolio-v2` differs from `portfolio-v1` in any particular way without a component registry.
- **One task class per model of learning** — summaries are learned per task class in isolation; a pooled engine prior over similar classes needs a taxonomy the store does not have.
- **No cross-component attribution** — when two components differ between configurations, the store cannot say which one caused a pass-rate change; isolated ablations need the lineage store alongside.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Summaries derive from the run table at read time, so the run stream stays append-only and a new run never rewrites earlier ones. `record` completes a partial configuration with the default choices, so callers that know some components but not others never lose the rest, and it stores the workflow as given, so the identity a caller later reads back is the identity its own run produced. The score's sample-confidence factor means `recommend` needs no separate minimum-samples guard beyond the config's `minimumSamples`.

</details>
