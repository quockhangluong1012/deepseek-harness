---
description: "Retrieval-aware evolution: recorded retrieval configurations per session, judged by downstream task success, with the configuration recommendation per task class (ctx.evolutionRetrieval)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-retrieval

English | [中文](README.zh.md)

## Summary

`dsh-evolution-retrieval` evolves what an agent retrieves, not only how it reasons. It records the retrieval configuration in force for each session — retrieval source, query expansion, lane weights, reranker, MMR, memory scope, graph depth, and the active-memory threshold — and measures each configuration by downstream task success, joining those sessions to the graded outcomes the skill-telemetry and feedback stores already carry. The per-task-class ranking recommends the configuration with the best measured success once it has enough graded sessions, and reports nothing below the gate. Nothing here calls a model.

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

Mount the plugin with the storage domain. [`dsh-active-memory-context`](../../context/active-memory-context/README.md) records the configuration it runs under, once per session, whenever this store is mounted beside it; any other recall implementation records its own configuration with the same call.

```ts
await ctx.evolutionRetrieval.record({
  configuration: {
    source: 'hybrid',
    queryExpansion: 'graph-entities',
    weights: { vector: 1, graph: 1 },
    reranker: 'none',
    mmr: { enabled: false, lambda: 1 },
    memoryScope: 'workspace',
    graphDepth: 1,
    threshold: 0.7,
  },
  sessionId: 'session-42',
})
const recommended = ctx.evolutionRetrieval.recommend('writer')
if (recommended !== undefined) {
  console.log(recommended.configKey, recommended.reason)
}
```

`record(input)` upserts the configuration in force for one session, keyed by the configuration and the session joined, so recording the same session twice records one attribution. `attributions(configKey?)` lists recorded attributions newest first. `effectiveness(taskClass?)` derives one row per configuration and task class from the graded sessions. `recommend(taskClass)` returns the best-ranked configuration that clears the evidence gate, or `undefined`.

### Configuration

The evidence gate is a validated `Config` member changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-retrieval'
  config:
    minimumSessions: 5
```

| Field | Default | Meaning |
|---|---|---|
| `minimumSessions` | `5` | Graded sessions a configuration needs on one task class before it may be recommended |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-retrieval) is the exhaustive source for every accepted field.

### How much evidence a recommendation needs, and why

A recommendation needs `minimumSessions` graded sessions on that exact configuration and task class — one grade per session, never pooled across classes, because the class is what the recommendation is for. Five is the default, for three reasons that compound:

- **One grade is one binary from another store's pass.** Nothing here measures retrieval quality per call: the only signal is whether the session that ran under a configuration came out clean in the store that graded it. A single session is therefore one data point about a whole configuration, and the count of them is the only honest thing to gate on.
- **The gate is on the count, not the score.** `scoreOf` multiplies a beta-prior smoothed success rate by `min(1, samples / minimumSessions)`, so the confidence factor saturates at the gate — but it only scales the score, and `recommendConfiguration` skips a configuration with too few graded sessions however it scored. Four out of four can score above a well-measured loser, and it is still one afternoon of evidence.
- **Five is where the prior stops carrying the estimate.** The smoothed rate carries a 1-pass/1-fail prior worth two pseudo-sessions: 2 of 5 at three grades, 2 of 7 at five. At five, the measured sessions decide the rank rather than the prior.

A deployment that grades sessions elsewhere — a second outcome store, or a class whose sessions are cheap — lowers the field; one whose classes accumulate few graded sessions raises it. Below the gate `recommend` answers `undefined`, and the failure section below states how a partly mounted store narrows the join.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Attributions are durable per-record rows in the `evolution_retrieval` domain (v1, one `attributions` table keyed by the configuration key and the session id joined): `{ configKey, configuration, sessionId, at }`. The configuration key is every §39 dimension in a fixed order, so two callers that build the same configuration in different key order record one configuration, and a session recorded twice upserts its row and keeps its first instant.

Effectiveness is derived at read time, never stored. `gradesOf(sessions, skills, failed)` joins the two evidence stores that already grade sessions: the skill-telemetry store names the task class a session served and its graded outcome, and the feedback store fails a session on the classes it loaded when one of its signals grades `complete` — a tool-attributed failure rather than an observed one. `effectivenessRows` folds those grades into one row per configuration and class, and `rankConfigurations` scores each by `scoreOf`, the same beta-prior smoothed rate scaled by sample confidence that `dsh-evolution-router` uses for routes. A configuration is therefore judged by what its sessions achieved, and a retrieval change that improves similarity scores while its sessions fail ranks below one that does not.

Nothing in this package measures retrieval precision, and nothing ranks on it: similarity is an input the recall implementation chooses, and a configuration's rank is what its sessions achieved.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the durable store, its read joins to the evidence stores, and the recommendation |
| [`src/retrieval.ts`](src/retrieval.ts) | Pure configuration key, session grading join, effectiveness fold, ranking, and recommendation |
| [`src/spec.ts`](src/spec.ts) | The `evolution_retrieval` domain and its zod row schema |

### Failure and recovery

An unmounted or foreign evidence store degrades to no grades for that source rather than failing the read: without telemetry there is no task class, and without feedback a session keeps only its telemetry grade. `recommend` answers `undefined` while no configuration reaches the gate. Reads throw before the store starts.

No invariant companion is published because the attribution table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §39 — the retrieval-aware evolution mechanism this package implements; §23 and §24 are the relevance-feedback and memory-utility framing that replace similarity alone with downstream utility.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-active-memory-context`](../../context/active-memory-context/README.md) — the producer: it records the retrieval configuration in force for every session it briefs.
- [`dsh-evolution-skill-telemetry`](../../skill/evolution-skill-telemetry/README.md) and [`dsh-evolution-feedback`](../evolution-feedback/README.md) — the two stores whose graded session evidence this package joins.
- [`dsh-evolution-router`](../evolution-router/README.md) — the sibling that learns routes from measured outcomes with the same scoring shape.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. The producer records beside the turn rather than inside it, and a consumer rendering a recommendation into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **A grade is the session's, not the configuration's** — a session that ran under two configurations contributes its outcome to both; splitting an outcome between the configurations that served it needs per-turn attribution the stores do not record.
- **Only graded sessions count** — a session neither store graded contributes nothing, so a class whose sessions are never graded never recommends.
- **Effectiveness is host-wide, not scope-keyed** — attributions are global rows; a per-workspace view needs a scope key on the domain.
- **The recorded configuration is the injector's projection** — the eight dimensions record what the mount actually sets, so the dimensions a deployment cannot vary here (weights, reranker, MMR, query expansion) are recorded as the shipped choice rather than measured per alternative.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The producer seam is optional on both sides: `dsh-active-memory-context` writes through a structural `RetrievalLedger` and marks the session once, so a deployment without this package records nothing and a store that rejects a write only logs a debug line. Nothing awaits the write, and the step's own messages are untouched, which is why the brief is byte-identical with and without the store mounted.

The two evidence seams are read with `ctx.get` and guarded structurally, so this package keeps no dependency on the telemetry or feedback packages; a missing store narrows the join instead of failing the read.

</details>
