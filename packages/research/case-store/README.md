---
description: "Durable per-learner ICT case-study artifact: the §21 field set, observations separated from interpretations, evidence by reference, and a read path for each of the four consumers (ctx.caseStore)."
kind: "package-reference"
---

# @deepseek-ai/dsh-case-store

English | [中文](README.zh.md)

## Summary

`dsh-case-store` persists the §21 ICT case-study artifact — symbol, timeframes, observations, user thesis, evidence, agent audit, devil's advocate, alternative scenarios, outcome, mistakes, lessons, concepts tested, and learner impact — one record per learner, so a case outlives the session that produced it. Observations hold what the chart shows and each interpretation cites the observations it reads, so the two never conflate; a kernel evidence reference carries the evidence id alone. Four reads serve the learner model, misconception detection, benchmark datasets, and the next mentor intervention. Nothing here calls a model.

## Table of Contents

- [Use this package](#use-this-package)
- [Observations and interpretations](#observations-and-interpretations)
- [Evidence by reference](#evidence-by-reference)
- [The four read paths](#the-four-read-paths)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin with the storage domain, open a case for a learner, then amend it as the review progresses. The store mints the case id.

```ts
const opened = await ctx.caseStore.createCase(LearnerId('user-1'), {
  symbol: 'EURUSD',
  timeframes: ['D1', 'H1', 'M5'],
})
const reviewed = await ctx.caseStore.amend(LearnerId('user-1'), opened.caseId, {
  observations: [{
    observationId: ObservationId('obs-1'),
    statement: 'D1 closed above the PD array high',
    timeframe: 'D1',
    evidence: [EvidenceKey('ev-1')],
    trust: 'trusted',
    observedAt: '2026-03-11T00:00:00.000Z',
  }],
  agentAudit: [{
    interpretationId: InterpretationId('audit-1'),
    kind: 'audit',
    statement: 'MSS is not a standalone entry trigger',
    basis: [ObservationId('obs-1')],
    trust: 'trusted',
    at: '2026-03-11T04:10:00.000Z',
  }],
  conceptsTested: [ConceptId('mss-entry')],
})
const record = ctx.caseStore.get(LearnerId('user-1'), opened.caseId)
```

`createCase(learnerId, { symbol, timeframes })` opens the record with every other field empty and no outcome. `amend(learnerId, caseId, amendment)` applies the named fields: each array appends its entries, replacing in place the entry that carries the same identity, the concepts tested are unioned, and a field the amendment omits keeps its recorded value. `get(learnerId, caseId)` and `cases(learnerId)` read one record or one learner's records.

### Configuration

None. The artifact's field set is fixed by the specification, and the store's scope and identity rules are the domain spec's.

### Observable behavior and failures

Reads throw before the store starts. `amend` on a case this learner does not hold rejects: the case is unknown in that scope, and nothing else is touched. Every write passes the artifact schema before it is stored, so an entry outside the schema — an unknown field, a missing `basis`, a `kind` that disagrees with the field it is written into — fails here instead of at the next domain open. A stored record that no longer matches the schema fails the open loudly with `invalid-record`, because every read path feeds a consumer that acts on what it reads.

-----

<a id="observations-and-interpretations"></a>
## Observations and interpretations

The specification's research rules forbid conflating an observation with an interpretation of it, so the separation is structural rather than editorial:

| Field | Holds | Carries |
|---|---|---|
| `observations` | what the chart shows, with the timeframe it was read from | `evidence` keys it was read from |
| `agentAudit`, `devilAdvocate`, `alternativeScenarios` | readings of those observations | `basis`: the observation ids the reading draws on |
| `userThesis` | what the learner asserted | the assertion's own instant |
| `mistakes`, `lessons` | what the review found | `basis` observation ids and the concepts it bears on |

An observation entry has no `basis` field and cannot acquire one: the artifact is a strict schema, so an observation carrying interpretation structure is refused. An interpretation always cites `basis`; an empty basis is a recorded reading with nothing behind it, not an observation. `kind` on an interpretation names whose reading it is — `audit`, `devil-advocate`, or `scenario` — and the field it is written into must agree with it, so a critique cannot land in `agentAudit`.

-----

<a id="evidence-by-reference"></a>
## Evidence by reference

`evidence` holds references, never content. An item observed inside a session carries the kernel's evidence id and nothing else, so the case cannot drift from the observation it cites:

```ts
{ evidenceKey: EvidenceKey('ev-1'), kind: 'kernel', evidenceId: EvidenceId('ev-1') }
```

A chart or backtest read outside a session has no kernel record, so it is located instead, and it carries the trust label of wherever that locator points: `{ evidenceKey, kind: 'external', locator: 'backtest-2024-03.csv', trust: 'untrusted' }`. Observations cite these keys through `evidence`, so a reader can tell which item an observation came from without the case storing the item.

Every other entry carries its own `trust` label, so content derived from untrusted material stays labelled wherever the case is read (RUNTIME-SPEC S11).

-----

<a id="the-four-read-paths"></a>
## The four read paths

| Consumer | Read | Projection |
|---|---|---|
| Learner memory | `forLearnerMemory(learnerId)` | the review summary to record against the learner: symbol, outcome, concepts tested, mistakes, lessons, learner impact |
| Misconception detection | `forMisconceptionDetection(learnerId)` | what the learner asserted, the agent's audit, the devil's advocate's critique, and the mistakes found |
| Benchmark datasets | `forBenchmarkDataset(learnerId?)` | one row per case (every learner when the scope is omitted), carrying the whole artifact |
| Next mentor intervention | `forMentorIntervention(learnerId)` | what happened, the concepts the case exercised, how the learner moved, and the lessons to teach from |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **One record per learner-scoped case.** The `ict_case` domain holds a `cases` table keyed by learner id plus case id, so the same case id under two learners is two records and one learner can never read the other's case.
- **The artifact is exactly §21.** The artifact schema is a strict object over the thirteen fields; the store's own identity and instants live in the record envelope around it, not in the artifact.
- **Amendments append by identity.** Each entry type carries its own id, so re-applying a review replaces the entries it already wrote and leaves its siblings alone, and the case does not accumulate duplicate findings.
- **A read path per consumer.** The four projections are separate methods rather than one dump plus filters, so each consumer's contract is visible where it is served and a future scope change cannot silently change what a consumer receives.
- **A write either lands whole or not at all.** An amendment runs at the domain's write-chain slot on the current record and the result is parsed against the record schema before it is stored, so concurrent amendments never interleave and an out-of-contract artifact never reaches the medium.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `CaseStore`, the id factories, the four read paths |
| [`src/types.ts`](src/types.ts) | The artifact, its entry types, the amendment, and the projections |
| [`src/spec.ts`](src/spec.ts) | Domain declaration, artifact and record schemas, durable id forms |
| [`src/artifact.ts`](src/artifact.ts) | Pure artifact transforms: opening an empty artifact and applying an amendment |

### No invariant companion

No runtime invariant companion is published because the domain table is the only copy of this state: there is no second independent observation to check it against, and the record schema and the `domain/changed` event already cover what an invariant would assert.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DeepSeek Harness 2.0 evolution spec](../../../specs/deepseek-harness-2.0-evolution-spec.md) §12.6, §12.7, and §21 — the analyst and devil-advocate output contracts this artifact carries and the case fields it fixes.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain contract the case is stored through.
- [`dsh-learner-model`](../../mentor/learner-model/README.md) — the learner record that owns the identities and trust vocabulary reused here, and the `applyCase` write the learner-memory read feeds.

-----

<a id="model-experience"></a>
## Model Experience

None, as the store keeps host-side durable state behind `ctx.caseStore` and registers no tool, prompt, or session event; the consumer that renders a case owns any model-visible use of it.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the case store is a poor fit. They are current package constraints.

- **The artifact cannot be extended locally** — the schema is strict over §21's thirteen fields, so a deployment that needs another field changes the specification and the domain version, because an extra field is refused at the write and at the open.
- **`basis` and `evidence` are not referentially checked** — an interpretation may cite an observation id the case does not hold, and an observation may cite an evidence key that was never recorded; the store keeps the reference, it does not verify it.
- **A locator is not content** — an external evidence item records where to look; resolving it, and noticing that it moved, belongs to the reader, and the store never detects that a kernel evidence id is gone.
- **The convention is structural, not semantic** — nothing inspects an observation's statement, so a reading written into `observations` stays there; the schema makes the right field obvious, it cannot make a caller honest.
- **`outcome` is replaced, never cleared** — an amendment can record or overwrite an outcome, and a case resolved by mistake cannot return to `null` through `amend`.
- **No entry deletion** — a superseded observation, finding, or interpretation is replaced only by writing another entry with the same id; a withdrawn entry stays.
- **Scope is one learner** — only `forBenchmarkDataset` reads beyond a single learner scope, and no read filters by time, symbol, or concept.
- **The record keeps no session reference** — a case records the learner and the review, not the session or run that produced it, so attribution to a transcript is the caller's to keep.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The table key is the learner id, a NUL separator, and the case id (`storageKey`). The separator cannot appear in either branded id, so no pair of ids can collide with another pair, and the key alone decides scope: `amend` for learner B on learner A's case addresses a key that does not exist and rejects with the domain's `missing-key` rather than reaching A's record. The unscoped `forBenchmarkDataset()` iterates every record and sorts by learner, then creation instant, then case id, so a dataset built from it is deterministic across runs.

Amendments are applied inside `table.update`, so the transform sees the record the write chain holds rather than the copy the caller may have read, and two concurrent amendments cannot drop each other's entries. The parsed record is what gets stored: the domain validates stored records only at open, so without the parse a caller value outside the schema would be written, read by every consumer, and fail at the next process start.

</details>
