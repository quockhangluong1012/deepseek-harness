---
description: "Controlled self-model: a durable per-skill capability record feeding a weakest-first capability frontier that says what to learn next (ctx.evolutionSelfModel)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-self-model

English | [中文](README.zh.md)

## Summary

`dsh-evolution-self-model` keeps a durable per-skill capability record — strengths, weaknesses, uncertain areas, failure modes, preferred tools, evaluator blindspots — with a revision tick per upsert, plus per-capability entries tracking the running pass rate, confidence from the observation count, newest-first failure notes, and covering skills. The frontier ranks every capability weakest first — lower pass rate, then thinner evidence, then fewer covering skills — so `nextToLearn` names what the loop should learn next. The store only records; it never calls a model or enforces learning.

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

Mount the plugin with the storage domain. Skills record their whole self-view whenever it changes; evaluation outcomes arrive as capability observations; operators read the frontier to decide what the loop should learn next.

```ts
await ctx.evolutionSelfModel.record({
  skill: 'writer',
  strengths: ['draft'],
  weaknesses: ['brevity'],
  uncertainAreas: ['humor'],
  failureModes: ['rambling'],
  preferredTools: ['search'],
  evaluatorBlindspots: ['tone'],
  confidence: 0.6,
})
await ctx.evolutionSelfModel.observe({ capability: 'lint', skill: 'writer', pass: false, failure: 'missed rule' })
console.log(ctx.evolutionSelfModel.nextToLearn()?.capability)
```

`record(input)` upserts the skill's whole self-view and ticks its revision one past the previous record. `assessment(skill)` reads one skill's assessment and `assessments()` lists every assessment by skill name. `observe(obs)` folds one capability observation into the capability's running entry, creating it on first sight. `capability(name)` reads one entry and `capabilities()` lists every entry by capability name. `gaps()` ranks every capability weakest first and `nextToLearn()` returns the weakest gap, or null with no entries.

### Configuration

The store's deployed choices, with defaults suitable for an ordinary cadence; both are validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `maxObservations` | `10` | Observations that earn a capability entry full confidence. |
| `maxFailures` | `10` | Newest failure notes kept per capability entry. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Merging is pure. `mergeModel` replaces every list wholesale — the input is the skill's current whole self-view, not a patch — while the revision ticks one past the previous record (1 for a skill's first assessment) and the instant stamps the write. `observeCapability` tracks the running pass rate over every observation so far; confidence is the observation count over `maxObservations` capped at 1; a present failure note leads the newest-first failures capped at `maxFailures`; the observing skill joins the covering set in first-seen order. `frontierGaps` ranks weakest first — lower pass rate, then lower confidence, then fewer covering skills, then the capability name so ties always render deterministically — and `nextToLearn` returns the first gap or null.

The store is a two-table domain: `evolution_selfmodel` version 1 with a `models` table keyed by skill holding the full assessment plus revision and a `capabilities` table keyed by capability name holding the pass-rate entry. Score, confidence, and failures fold at observe time, so the frontier is a pure sort over stored entries with no configuration dependency.

### Failure and recovery

Reads throw before the store starts. Unknown skills and capabilities read as `undefined` rather than throwing, so frontier consumers never need a guard before asking what to learn next. Recording overwrites nothing but the skill's own assessment or the capability's own entry, so one skill's self-view never disturbs another's.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check them against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §42 — the controlled self-model this package implements — and §33 — the capability frontier its weakest-first ranking answers.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the evolution driver whose evaluation outcomes this store's observations record.
- [`dsh-evolution-stagnation`](../evolution-stagnation/README.md) — the sibling store whose runs-without-improvement signal complements this package's weakest-first frontier.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering self-model facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Records what to learn, does not teach it** — the frontier names the weakest capability (§58.12: trust is recorded, not enforced); scheduling or performing the learning remains an operator's or scheduler's job.
- **Whole-view upserts** — `record` replaces every assessment list; partial patches and per-field histories are not tracked.
- **Confidence counts observations, not difficulty** — ten easy passes earn full confidence; weighting hard cases needs a difficulty signal on observations.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Assessments upsert whole views so a skill's record never merges stale and fresh lists at read time. Confidence and failures fold at observe time, so `gaps()` and `nextToLearn()` rank stored entries without touching configuration and stay stable when the caps change.

</details>
