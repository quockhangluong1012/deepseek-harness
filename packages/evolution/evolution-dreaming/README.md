---
description: "Three-phase dreaming consolidation: scores recorded failures with the six-signal composite and promotes qualified candidates into durable per-scope dreams (ctx.evolutionDreaming)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-dreaming

English | [中文](README.zh.md)

## Summary

`dsh-evolution-dreaming` consolidates what a scope keeps failing at into durable memory, in three phases modelled on sleep. **Light** gathers the scope's recorded failures and its episodic notes, deduplicating by statement: one note is one sighting, sightings on distinct days are the independent contexts the deep phase gates on, and a note restating a recorded failure folds into that failure's candidate. **REM** derives the themes they share and writes a narrative. **Deep** is the only phase that writes durable memory: it scores every candidate with the six-signal weighted composite, promotes those clearing all three gates, and drops promotions the decay rule has outlived. Weights are fixed — they are the algorithm; thresholds, cadence, and retention are configuration.

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

Mount it next to the feedback store and, for the automatic cycle, the heartbeat:

```yaml
- name: '@deepseek-ai/dsh-evolution-feedback'
- name: '@deepseek-ai/dsh-evolution-heartbeat'
- name: '@deepseek-ai/dsh-evolution-dreaming'
  config:
    minScore: 0.65
    minRecallCount: 3
    minUniqueQueries: 2
```

```ts
await ctx.evolutionDreaming.dream(scope, sessionIds)   // light → REM → deep
ctx.evolutionDreaming.read(scope)                      // narratives and promotions
```

`run(phase, scope, sessionIds, now?)` runs one phase for diagnosis; `dream(…)` runs the whole cycle; `dreamAll()` walks every workspace the registry knows and is what the heartbeat task calls.

At the prompt, `/dream` runs the cycle for the invoking scope and `/dream <phase>` runs one phase, both over the sessions the workspace owns.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `minScore` | `0.65` | Composite a candidate must reach to be promoted |
| `minRecallCount` | `3` | Sightings a candidate must reach |
| `minUniqueQueries` | `2` | Distinct sessions a candidate must appear in |
| `staleAfterDays` | `30` | Days a promotion stays durable without being seen again |
| `capacityTriggerRatio` | `0.8` | Share of `maxPromotions` above which the survivors are trimmed to the hard bound |
| `intervalHours` | `6` | Hours between two automatic cycles |
| `maxNarratives` | `20` | Narratives retained per scope |
| `maxPromotions` | `200` | Promotions retained per scope |
| `maxCandidates` | `500` | Candidates one cycle scores |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-dreaming) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### The six signals

Each dimension is normalized to `0..1` before weighting, so no signal can dominate by carrying an unbounded raw count:

| Signal | Weight | Normalization |
|---|---|---|
| Relevance | 0.30 | Concept overlap with the text the scope already holds |
| Frequency | 0.24 | `count / (count + 3)` — one half at the recall gate |
| Query diversity | 0.15 | `sessions / (sessions + 2)` — one half at the diversity gate |
| Recency | 0.15 | Halves every 30 days from the last sighting |
| Integration | 0.10 | Days between first and last sighting, full at a week |
| Concept richness | 0.06 | Distinct words, full at twelve |

### Phase separation

Only the deep phase writes durable memory. Light and REM may run on their own for inspection without changing what the scope has learned, and the automatic cycle runs all three in order. Episodic notes re-stage while the memory retention window keeps them — the deep phase's promoted set already refuses a second promotion, exactly as it does for failures the feedback seam reports again — so a repeated note is re-scored with decayed recency rather than tracked as consumed. Promotions live in the plugin's own domain, never in the model-owned lessons document, so two writers never contend for one document.

### Failure and recovery

Invalid records fail the domain open loudly: a dropped promotion would silently re-offer a consolidated candidate to the next cycle. A missing feedback or memory seam degrades that phase rather than failing the cycle, and a missing heartbeat simply means no automatic schedule. No invariant companion is published because the domain table is the only copy of this state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-evolution-feedback`](../evolution-feedback/README.md) — the recorded failures this cycle consumes.
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.md) — the idle-triggered scheduler that drives it.
- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract behind the self-learning family.

-----

<a id="model-experience"></a>
## Model Experience

None, as the cycle adds no content: it scores and promotes observations the feedback seam already recorded, and no prompt section, tool schema, or request carries its output yet.

#### KV Cache effect

None: the cycle makes no model call, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Relevance is lexical** — the signal compares concepts as words. A semantic comparison through an embedding provider would rank candidates whose wording differs more strictly.
- **Promotions are a dead end until read** — nothing injects a promoted dream into model context; the record is durable but not yet recalled.
- **Heartbeat cadence is fixed per deployment** — one `intervalHours` applies to every scope.
- **Machine-local only** — dreams live under `$DSH_HOME`, never inside the project directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The service renders on the Evolutionary Harness subsystem page and in the capability-seams graph, reachable through the `/dream` command in `dsh-command-evolution`.

</details>
