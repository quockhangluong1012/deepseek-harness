---
description: "Novelty search: a durable per-skill archive of behavior descriptors whose Jaccard-based archive novelty rewards meaningfully different candidates (ctx.evolutionNovelty)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-novelty-search

English | [中文](README.zh.md)

## Summary

`dsh-evolution-novelty-search` keeps a cross-run per-skill archive of behavior descriptors — one entry per staged optimizer write — and measures every new descriptor's novelty against everything the skill has seen before. Novelty is one minus the maximum Jaccard similarity to any archived entry: a candidate that restates known instructions is not novel, one carrying new material is. The optimizer records every staged write through the optional store seam, and the host command `command-evolution` inspects the archive through `/novelty`. Nothing here calls a model.

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

Mount the plugin with the storage domain. Descriptors arrive from the optimizer's staged writes whenever the store is mounted; operators read the archive and its novelty pressure.

```ts
await ctx.evolutionNovelty.record({
  candidateId: 'staged-0',
  skill: 'writer',
  features: ['do the thing', 'refuse unsafe paths'],
})
const entries = ctx.evolutionNovelty.entries('writer')
const pressure = ctx.evolutionNovelty.mean('writer')
```

`record(input)` measures the descriptor's novelty against the skill's archive excluding itself (so re-recording a candidate keeps its original novelty) and stores the entry keyed by candidate identity. `entries(skill?)` lists entries newest first; `mean(skill)` reports the skill's mean archive novelty, in 0..1 — a falling mean is the frontier-stagnation signal §31 calls out. The `/novelty` command lists the archive and its mean per skill.

### Configuration

None — the store takes no deployment choices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Measurement is pure. `similarity` is Jaccard similarity between two feature sets (zero for two empty sets). `archiveNovelty` is one minus the maximum similarity of a descriptor to any archived entry: zero for a descriptor with no features (nothing to be novel about), one for the seed entry of an empty archive. `noveltyMean` averages recorded novelties and reports zero for an empty archive. The store is a per-entry domain: `evolution_novelty` version 1 with one `archive` table keyed by candidate identity, holding `{ candidateId, skill, features, novelty, at }`.

The optimizer keeps its own per-baseline novelty (`noveltyOf`) for generation-time selection and blends novelty into survivor selection already; this package contributes the durable archive-novelty signal — difference against the skill's whole history, not just one reference body.

### Failure and recovery

Reads throw before the store starts. Entry ids are the optimizer's staged write ids, so a `/novelty` id always names a real staged write. Archive rows are re-measured only when recorded, so history keeps its original novelty even when later candidates resemble it.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §31 — the novelty-search mechanism this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the producer whose staged writes become archive entries through the optional recorder seam.
- [`dsh-evolution-population`](../evolution-population/README.md) — the sibling store whose candidate records carry the optimizer's per-baseline novelty alongside this archive.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering archive facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Descriptors are supplied, not derived here** — the optimizer extracts descriptor features (`descriptorOf`) from the winner's body before recording; the store measures, it does not parse skill bodies.
- **One entry per staged write** — the archive is keyed by candidate identity, so a staged write cannot carry multiple behavior variants into the archive.
- **No archive budget** — the archive grows without a size cap; a bounded archive needs a retention policy on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the novelty package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. Re-recording exclusion keeps the archive idempotent for the same candidate identity.

</details>
