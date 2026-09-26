---
description: "The evidence-backed misconception engine: judges a learner's stated thesis against the deployment's pattern catalogue, records the finding in the learner record, the pipeline table, and the kernel claim ledger, and drives each occurrence through explain, counterexample, exercise, new case, and reassess (ctx.misconception)."
kind: "package-reference"
---

# @deepseek-ai/dsh-misconception

English | [中文](README.zh.md)

## Summary

`dsh-misconception` decides whether a stated thesis matches a misconception the deployment declared, and returns the misconception, the design error behind it, and the objective that corrects it, backed by the observations the caller cites. The finding lands in the learner record, in a durable pipeline for that learner and pattern, and in the kernel's claim ledger as a contradicted claim. Each stage then renders one directive the mentor delivers. Matching is literal and every correction text comes from the deployment's own pattern, so nothing here calls a model.

## Table of Contents

- [Use this package](#use-this-package)
- [The cycle and its facts](#the-cycle-and-its-facts)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the engine with a storage domain and a learner record, declare every pattern this deployment can detect, and hand it a learner's thesis with the observations that contradict it.

```yaml
- name: '@deepseek-ai/dsh-misconception'
  config:
    patterns:
      - id: mss-standalone-entry
        misconception: MSS treated as a standalone entry criterion
        designError: MSS confirms structure; it is not an entry trigger until a PD-array test follows it
        objective: Place MSS inside a full entry model before taking an entry
        triggers:
          - MSS happened
          - therefore the entry is valid
        explanation: An MSS marks a shift in delivery, not permission to enter.
        counterexample: EURUSD H1 printed an MSS into a supply zone and reversed from it.
        exercise: Mark the last three MSS on EURUSD H1 and name the PD-array test that followed each.
```

`ctx.misconception.detect({ agent, learnerId, thesis, evidence, caseId? })` returns the recorded detection, `advance({ misconceptionId, fact })` completes the current stage and enters the next one, and `directive(learnerId, misconceptionId, caseId?)` renders the instruction for the stage the occurrence stands at. Reads are synchronous: `match(thesis)` names the pattern a thesis matches, `pipeline` and `pipelines` read one occurrence or every occurrence a learner holds, most recently written first.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `patterns` | required | The misconception patterns this deployment can detect, in the order the first match decides; a missing or empty catalogue fails at load |
| `maxTextChars` | `2000` | Cap in UTF-16 characters on every learner-quoted or engine-rendered text the engine stores or emits |

### Observable behavior and failures

Reads and writes throw before the domain opens, and a stored pipeline whose pattern the catalogue no longer declares fails loudly rather than teaching from a pattern nobody declared. `detect` refuses a thesis no catalogued pattern matches and refuses a detection with no contradicting observation, because a finding nobody can contradict is not a finding. `advance` refuses a fact the current stage does not accept, naming the fact the stage wanted, and refuses any fact once the cycle is complete. `directive` throws when the learner holds no such occurrence, returns nothing for a completed cycle, and refuses to render the new-case stage without the case the learner must work on.

-----

<a id="the-cycle-and-its-facts"></a>
## The cycle and its facts

Every stage renders one instruction and is completed by exactly one observed fact:

| Stage | The stage renders | The fact that completes it |
|---|---|---|
| `explain` | the design error against the learner's own thesis, then the pattern's explanation | `delivered` |
| `counterexample` | the pattern's counterexample, named against that thesis | `delivered` |
| `exercise` | the pattern's exercise, tagged with the derived exercise identity and the objective | `attempted`, with the learner's attempt text |
| `new-case` | the instruction to redo the reading on one named case | `case-selected`, with the case reference |
| `reassess` | the instruction to read the learner's new thesis against the objective | `reassessed`, with `repeated` or `resolved` |
| `complete` | nothing; the cycle is over | none — every fact is refused |

A `repeated` reassessment returns to `explain` and counts the recurrence on the learner record, exactly as a second detection does. A `resolved` reassessment completes the cycle: the learner record's misconception becomes `resolved` and the objective this occurrence raised is retired. Each stage a pipeline leaves is announced as `mentor/misconception-stage`, and each recorded finding as `mentor/misconception-detected`; both are host notifications that no model reads by themselves.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **The catalogue is deployment configuration.** Patterns arrive as validated `Config`; an empty catalogue, a repeated or blank id, a pattern with no trigger, and a blank trigger (which would match every thesis) all fail at load, because a catalogue in that state detects nothing or the wrong thing.
- **Identity is derived, not generated.** An occurrence is `<learnerId>/<patternId>`, its exercise `<misconceptionId>:exercise`, and its objective `<misconceptionId>:objective`, so a later occurrence of the same pattern updates the same pipeline and the learner record counts a recurrence instead of a second misconception.
- **One detection writes three places.** The learner record counts the recurrence and gains the objective, the `mentor_misconception` domain's `pipelines` table holds the durable stage, and the kernel records a claim with status `contradicted` and confidence `0` when a kernel is mounted. The claim is optional; the other two are not.
- **Durable per learner and pattern.** The domain opens with `layout: 'per-record'`, and every stored row is parsed at open, so a row that no longer matches the schema fails the open loudly rather than steering the next lesson.
- **Text is bounded at both ends.** The thesis, the attempt, and every rendered directive pass the configured cap, so a long learner statement cannot grow the stored row or the directive without limit.
- **One directive per stage.** The digest is a hash of the occurrence, the stage, and the case, so a caller can deliver one stage's instruction once instead of once per step.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `MisconceptionEngine`, the detection, the pipeline reads, and the stage advance |
| [`src/patterns.ts`](src/patterns.ts) | The catalogue schema, its load-time validation, thesis matching, and the text cap |
| [`src/pipeline.ts`](src/pipeline.ts) | The stage list, the derived identities, the stage machine, and each stage's named wait |
| [`src/directive.ts`](src/directive.ts) | Directive rendering and the stage digest |
| [`src/spec.ts`](src/spec.ts) | The `mentor_misconception` domain, its `pipelines` table, and the durable row schema |
| [`src/types.ts`](src/types.ts) | The pattern, stage, fact, pipeline, directive, and detection types |
| [`src/events.ts`](src/events.ts) | The two host notifications |

### No invariant companion

No runtime invariant companion is published because the pipeline row and the learner record are the two copies of this state, and the engine derives one from the other inside the operations that write them: an assertion over their agreement could only restate the write that just ran.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [DeepSeek Harness 2.0 evolution spec](../../../specs/deepseek-harness-2.0-evolution-spec.md) §20 and §21 — the mentor quality-control loop and the case artifact that feeds misconception detection.
- [`dsh-learner-model`](../learner-model/README.md) — the learner record where a finding's recurrence count and objective are written.
- [`dsh-mentor-loop`](../mentor-loop/README.md) — the plugin that derives when to detect and injects the directives this engine renders.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain form each learner's pipeline is stored through.
- [`dsh-storage-domain`](../../storage/storage-domain/README.md) — the table, write-chain, and schema-validation semantics every write here relies on.
- [Agent kernel subsystem](../../../docs/subsystems/agent-kernel.md) — the claims and evidence records a detection cites and the contradiction it asserts.
- [`dsh-case-store`](../../research/case-store/README.md) — the reviewed case artifact whose own detection read path feeds a thesis with its observations.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the mentor loop, which injects the directives this engine renders at each stage.

#### KV Cache effect

Nothing here enters a model request by itself, so provider cache reuse is unaffected until the mentor loop appends a rendered directive to a later request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the engine judges a thesis badly or holds state a deployment must live with. They are current package constraints.

- **Matching is literal** — a trigger is matched as a case-insensitive substring, so a thesis that quotes the trigger in order to reject it still matches, and only the first pattern in catalogue order is reported with no alternatives.
- **One pipeline per learner and pattern** — a second occurrence counts as a recurrence of the same occurrence, so one learner can never hold two cycles of one pattern at once.
- **Catalogue ids are durable keys** — renaming or dropping a pattern id leaves stored rows naming a pattern nobody declares, and every read of those rows throws until the catalogue declares the id again; there is no migration.
- **Only the newest attempt survives** — `attempt` is replaced by the next `attempted` fact, so the earlier attempts at one exercise are not recoverable from the engine.
- **Truncation is silent** — a thesis, attempt, or rendered directive longer than `maxTextChars` is cut with no marker, in the stored row and in the directive alike.
- **The caller owns the evidence** — the engine cites whatever evidence identities it is handed and never checks that the session recorded them.
- **A resolved cycle drops its objective** — the objective is removed from the learner record and leaves no trace that it was raised, so a history of what a learner was taught lives in the pipeline rows, not in the objective list.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

A detection writes the learner record first, then the pipeline row, then the kernel claim, and only then emits, so a listener never observes a finding that is not already durable in every place that owns it. An advance writes the row before it touches the learner record: the row is the source of the stage and the learner record is the source of the recurrence count, and neither is derived from the other. `view()` resolves the pattern's own text at read time, so a stored row holds the caller's thesis and identities rather than a copy of the catalogue's prose.

</details>
