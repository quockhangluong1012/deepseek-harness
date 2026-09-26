---
description: "Durable per-learner record of concept knowledge, application ability, misconceptions, recurring mistakes, confidence, case history, and next learning objectives (ctx.learnerModel)."
kind: "package-reference"
---

# @deepseek-ai/dsh-learner-model

English | [中文](README.zh.md)

## Summary

`dsh-learner-model` keeps one durable record per learner: what the learner has shown about concepts by talking about them, what graded applications measured, misconceptions and mistakes with their recurrence counts, stated confidence, reviewed cases, and the next learning objectives. The record is keyed by a stable learner id, so it survives every session boundary. Stated familiarity and applied mastery are separate entry lists that no write merges, and every write carries the trust label of the content behind it. Nothing here calls a model.

## Table of Contents

- [Use this package](#use-this-package)
- [Reading the two axes](#reading-the-two-axes)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the storage domain and address one learner by a stable id the deployment owns — a user id, an account id, anything that outlives a session.

```ts
const learner = LearnerId('user-1')
const concept = ConceptId('pd-array-pip')

await ctx.learnerModel.recordConcept(learner, {
  conceptId: concept,
  familiarity: 0.8,
  observations: 3,
  trust: 'trusted',
})
await ctx.learnerModel.recordApplication(learner, { conceptId: concept, succeeded: false, trust: 'trusted' })
const axes = ctx.learnerModel.axes(learner, concept)
```

Reads are synchronous and detached from the store: `read(learnerId)` returns the whole record (an empty one with `updatedAt: null` for a learner with nothing recorded), `axes(learnerId, conceptId)` returns both knowledge axes of one concept, `misconceptions`, `mistakes`, and `objectives` return those lists, and `applicationMastery(entry)` derives the applied ratio.

Writes are durable and return the updated record. `recordConcept` replaces the concept's stated familiarity and its observation count; `recordApplication` adds one graded application and accumulates `attempts`/`successes`; `recordConfidence` replaces the learner's stated confidence; `recordMisconception` counts one detection and returns a resolved belief to `detected`; `setMisconceptionStatus` moves a known belief; `recordMistake` counts one occurrence and unions the concepts it bears on; `setObjectives` replaces the objective list, keeping the instant of an objective that survives under the same id; `applyCase` upserts one reviewed-case history entry by case reference.

### Configuration

None. The record layout is fixed by the domain spec, and every deployment-varying value reaches the store through a caller's evidence entry.

### Observable behavior and failures

Reads throw before the store starts. Every write passes the domain record schema before it is stored, so a familiarity outside `[0, 1]` or an unknown trust label rejects here instead of failing the next domain open. A stored record that no longer matches the schema fails the open loudly with `invalid-record` — this is authoritative state, so the store never backs a record up and skips it. `setMisconceptionStatus` on an unknown belief rejects naming the id, and a rejected write leaves the record untouched.

-----

<a id="reading-the-two-axes"></a>
## Reading the two axes

Section §12.8 of the 2.0 evolution spec forbids equating conceptual familiarity with application mastery, so the record keeps them apart and a caller tells them apart by field, not by judgement:

| Question | Read | Field |
|---|---|---|
| What has the learner shown by talking about the concept? | `axes(learnerId, conceptId).concept` | `familiarity` (0 to 1) plus the `observations` count behind it |
| What has the learner shown by doing it? | `axes(learnerId, conceptId).application` | `attempts`, `successes`, and `applicationMastery` |

`conceptKnowledge` and `applicationAbility` are separate lists keyed by concept id; only `recordApplication` writes the applied axis, only `recordConcept` writes the stated axis, and neither reads the other. A caller asking whether the learner can apply the concept reads `application` and treats `concept` as what the learner believes about it. `application` is `undefined` until at least one application is graded: an ungraded axis is not a zero. `confidence` is a third, independent reading — what the learner says about their own grasp — and no transform folds it into either axis.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One durable record per learner.** The `learner_model` domain holds a `learners` table keyed by learner id, so a session that ends mid-record changes nothing about where the state lives (§27 Mentoring: learner state persists across sessions).
- **Both axes, separately.** `conceptKnowledge` and `applicationAbility` are independent lists with independent transforms. The applied list stores `attempts` and `successes`; the ratio is derived at read time by `applicationMastery`, so a stored score can never disagree with the counts behind it.
- **Recurrence is counted, not inferred.** A second detection of the same `misconceptionId` or `mistakeId` increments its count and appends the case reference it came from, so recurrence and which case each came from survive without the caller replaying history.
- **Trust travels with the entry.** Every entry stores the `TrustLabel` of the content it came from, so content derived from untrusted material stays labelled wherever the record is read (RUNTIME-SPEC S11).
- **A write either lands whole or not at all.** Each transform runs at the domain's write-chain slot on the current record and is parsed against the domain schema before it is stored, so concurrent writes never interleave and an out-of-contract value never reaches the medium.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `LearnerModel`, the id factories, and the record reads |
| [`src/types.ts`](src/types.ts) | The record, its entry types, and the caller-supplied evidence types |
| [`src/spec.ts`](src/spec.ts) | Domain declaration, record schemas, durable id and trust forms |
| [`src/record.ts`](src/record.ts) | Pure record transforms and the axis reads |

### No invariant companion

No runtime invariant companion is published because the domain table is the only copy of this state: there is no second independent observation to check it against, and the `domain/changed` event and the record schema already cover what an invariant would assert.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DeepSeek Harness 2.0 evolution spec](../../../specs/deepseek-harness-2.0-evolution-spec.md) §12.8 and §27 — the learner attribute list and the mentoring criteria this record answers.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain contract the record is stored through.
- [`dsh-storage-domain`](../../storage/storage-domain/README.md) — the table, write-chain, and schema-validation semantics every write here relies on.
- [`dsh-case-store`](../../research/case-store/README.md) — the case artifact whose review summary `applyCase` records, and whose `forLearnerMemory` read feeds it.

-----

<a id="model-experience"></a>
## Model Experience

None, as the store keeps host-side durable state behind `ctx.learnerModel` and registers no tool, prompt, or session event; the mentor package that reads the record owns any model-visible rendering of it.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the record is a poor fit. They are current package constraints.

- **Concept ids are opaque strings** — the store records whatever id a caller passes and holds no catalog, so two spellings of one concept become two entries with no error. The catalog belongs to the package that teaches the concepts.
- **The store never decides mastery** — it records attempts, successes, and familiarity; the bar that turns a recorded ratio into a judgement about the learner belongs to the mentor that reads it.
- **Confidence keeps one reading per concept** — a newer statement replaces the older one, so how the learner's confidence moved over time is recoverable only from the case history.
- **Objectives are replaced, not versioned** — `setObjectives` stores the current list and keeps the instant of a surviving objective; a dropped objective leaves no record of having been raised.
- **Nothing here is pruned** — a resolved misconception and a mistake that stopped recurring stay in the record, so a consumer that wants recent state filters by `updatedAt` or `lastAt` itself.
- **One learner per scope, no roster** — reads take one learner id; there is no cross-learner query, aggregate, or listing.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

A write reads the table before it decides how to write: a learner with a stored record is transformed through `update`, which runs the transform at the domain's write-chain slot, and a learner with none stores the transform of the empty record. The transform is applied to the record the chain slot holds, not to the copy the caller may have read, so two writes for one learner never lose an increment. Each transform's result passes `learnerRecord.parse` before `put`/`update` stores it: the domain validates stored records at open, so without this a caller value outside the schema would be written, read back by every consumer, and only fail at the next process start.

</details>
