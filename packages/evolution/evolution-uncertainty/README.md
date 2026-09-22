---
description: "Uncertainty-driven learning: durable uncertainty signals aggregated into a prioritized queue of high-value evaluation tasks (ctx.evolutionUncertainty)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-uncertainty

English | [中文](README.zh.md)

## Summary

`dsh-evolution-uncertainty` keeps a durable log of uncertainty signals — evaluator disagreement, low confidence, cross-seed instability, retrieval ambiguity, conflicting evidence — and aggregates them into a prioritized queue of high-value evaluation tasks. Signals sharing a skill and task corroborate: each distinct kind past the first adds a configured bonus to the task's priority, capped at one, so a task several kinds flag outranks a hotter single-kind signal. Resolving a task drops its signals and the queue re-derives from what remains. Nothing here calls a model.

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

Mount the plugin with the storage domain. Signals arrive from evaluators, judges, and retrieval diagnostics whenever producers record them; operators read the queue and resolve tasks once re-evaluated.

```ts
await ctx.evolutionUncertainty.record({
  signalId: 'sig-0',
  skill: 'writer',
  taskId: 't1',
  kind: 'disagreement',
  score: 0.8,
  detail: 'contract approved, replay regressed',
})
const next = ctx.evolutionUncertainty.queue('writer')
if (next.length > 0) console.log(next[0]?.taskId, next[0]?.priority)
```

`record(input)` stamps the signal with the current instant and stores it under its signal identity. `signals(skill?)` lists signals newest first; `queue(skill?, limit?)` aggregates the filtered signals into evaluation tasks sorted by priority descending, then skill, then task (skill-wide tasks last), capped by the caller's limit or the configured queue limit; `resolve(skill, taskId?)` drops the signals behind one task — without a task identity only the skill-wide signals — and returns the count removed.

### Configuration

The queue's deployed choices, with defaults suitable for an ordinary cadence; both are validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `queueLimit` | `50` | Maximum tasks `queue` returns when the caller passes no limit. |
| `corroborationBonus` | `0.15` | Priority added per distinct signal kind past the first in one task. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Aggregation is pure. `priorityOf` takes the strongest signal as the base, adds the corroboration bonus per distinct kind past the first — independent kinds agreeing that a task is uncertain counts more than one loud signal — and caps the total at 1. `queueFor` groups signals by skill and task identity, with a null task identity as its own skill-wide group, lists each task's distinct kinds in canonical §43 order, and sorts the queue by priority descending, then skill ascending, then task identity (null last, then lexical) so the order is deterministic.

The store is a per-signal domain: `evolution_uncertainty` version 1 with one `signals` table keyed by signal identity, holding `{ signalId, skill, taskId, kind, score, detail, at }`. The queue derives from the full signal history at read time, so configuration changes re-rank priorities without rewriting recorded signals.

### Failure and recovery

Reads throw before the store starts. Without a task identity `resolve` drops only the skill-wide signals of the skill, so resolving skill-wide doubt never clears a task's evidence, and resolving one task never touches another task's signals.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §43 and §44 — the uncertainty-driven learning loop and the disagreement search signal this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-scorer`](../evolution-scorer/README.md) — the producer whose per-channel `evaluatorDisagreement` verdicts feed the disagreement kind; this package aggregates that signal, it does not recompute it.
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.md) — the sibling store whose durable verdict ledger records the judgments the disagreement kind is derived from.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering queue facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Records the queue, does not run evaluations** — the store prioritizes what deserves another look (§43: the active-learning loop); scheduling and running the evaluations remains an operator's job.
- **Scores are trusted producer inputs** — signal strength semantics belong to the producers (evaluators, judges, retrieval diagnostics); the store calibrates nothing.
- **Resolve drops the whole task group** — `resolve` removes every signal behind a task; invalidating one signal of one kind needs single-signal deletion on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The queue derives from signal history at read time so configuration changes re-rank priorities without rewriting recorded signals. The store is record-only and reaches no model prompt; producers record through the store seam only when the package is mounted.

</details>
