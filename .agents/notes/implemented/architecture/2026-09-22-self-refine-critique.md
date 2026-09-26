# Agent Note: Self-refine critique in the background reviewer

Status: implemented

English | [中文](2026-09-22-self-refine-critique.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §5 fixes the inference-time loop `request → draft → critique → revise` and §53's Background Review row asks for structured failure and pattern analysis with narrow tools. The repository had the draft and none of the loop's second half.

`@deepseek-ai/dsh-evolution-reviewer` already ran one gated extraction per turn, and its protocol answered `confirms`, `contradicts`, or `new` — decisions about the scope's stored artifacts. Its transcript admitted human and assistant messages only, so a tool call that failed reached the model as prose at best; the failing result it buffered was used for output indexing and nothing else. A turn that went wrong therefore produced lessons about facts and no critique of the turn itself, and the corrected strategy the model could state about that turn was never recorded anywhere.

[`evolution-feedback`](2026-09-22-failure-memory-reflection.md) is not that half: it authors a deterministic structured reflection per graded `trigger_review` signal, from the ledger's own recurrence evidence, with no model and no view of any one turn's draft.

## Decision

The reviewer's one per-turn model call now carries both halves of §5's loop.

### The draft is the turn plus its recorded failures

While buffering a turn, a `tool/result` whose block is an error appends one `tool` transcript row, `<tool name>: <recorded result text>`, falling back to the failing result's error code, then to `<tool name> failed`, when it recorded no readable text. The row joins the same admitted-rows array the transcript is framed from, so it is byte-capped with everything else, ranks artifacts against the turn's text beside everything else, and reaches the model as the turn's own evidence rather than a second input channel.

This widened nothing. The failing result was already buffered per turn for output indexing, its text is bounded by the tool's own output cap, and the row carries the tool's name and its recorded result — never the failing call's arguments, which may hold file bodies and credentials and which §4.2's `what_failed` does not ask for. The reviewer still opens no tool surface: the call advertises no tools at all.

### The critique is a fourth action of the same answer

A turn whose transcript carries a `tool` row may add `{"action":"critique","expectation":…,"failure":…,"correction":…,"confidence":…,"scope":…}` — §4.2's `violated_expectation`, `what_failed`, and `corrected_strategy`, plus the revision's confidence and scope. It arrives in the array the model was already answering with, so a gated turn still costs exactly one call, one prompt, and one output budget, and no new input reaches a model that the session log does not already hold: the failure rows are the session's own `tool/result` events, and the artifact statements were already there.

The three named fields are `z.string()` at the wire boundary rather than `.min(1)`. That is deliberate: a critique the model cannot ground should cost itself, not the batch it arrived in. Two gates decide whether it is recorded, both in the reviewer rather than the parser. The transcript this call sent must contain a `tool` row, and the critique must name all three fields. A critique failing either gate is dropped with a warning while every decision beside it still applies.

### Both halves of the revision are recorded

An admitted critique is recorded twice, once per loop stage it closes:

- **The critique** becomes a scope context item labelled `Critique: <sessionId>`, its text naming the expectation, the failure, and the correction. It reaches later turns through the scope's brief like any other context item, and the store's digest covers context items, so that injection is reconstructable from the session log. It is written directly even when `writeApproval` stages the decisions beside it, the same way a recall item is: it is the reviewer's own reading of a recorded turn, not a proposed change to the stored artifacts. A store rejection warns, and the batch survives it.
- **The revision** it licenses travels inside that batch as an ordinary `new` candidate: the correction as the statement, the failure as its `conditions`, `inference` as its evidence — the correction is the model's reading, not a measured fact — and the model's own confidence and scope. Because it is a decision like any other, `writeApproval` stages it, `/memory approve` applies it, the merge resolution decides whether it restates a stored fact, and the over-cap retry can shed it.

A rebuild never produces a critique: its material is admitted rows selected from history, with no `tool` row and therefore no recorded failure to write against.

## Alternatives considered

**A second model call for the critique.** It would keep the extraction protocol untouched and let the critique see its own prompt. Rejected because it doubles the cost of every gated turn to re-read a transcript already in the prompt, and because §5's refinement is one local pass over one draft: a second call would also need its own route, timeout, recorded writer, and failure story for the same turn.

**A new store or domain for critiques.** A `evolution_critique` table keyed by session and turn would record the loop explicitly. Rejected because `evolution-memory` already holds the two things a critique needs to be: durable guidance (the lesson artifacts) and material the brief renders (`contextItems`). A second domain would also need its own digest participation, its own capacity accounting, and its own surface for a reader that does not yet exist.

**Recording only the lesson, dropping the critique record.** One write instead of two. Rejected because §4.2's vocabulary is the point: a lesson artifact has a statement and conditions, so it cannot hold the violated expectation beside the failure beside the correction, and the loop would be unobservable — a reader could not tell a critique-derived correction from any other `new` pair.

**Recording the critique as an episodic note.** Episodic notes are the scope's raw consolidation material and carry no ttl-independent identity. Rejected because they are not in the brief, do not reach a later turn, and are pruned by the retention window — the opposite of §4.1's corrective heuristic that a later turn should retrieve.

**Requiring the three fields in the schema.** `.min(1)` on `expectation`, `failure`, and `correction` would enforce §4.2 at the wire boundary and remove the reviewer's gate. Rejected because the parser rejects the whole answer: an ungrounded critique would then discard the turn's confirmations and contradictions as well, which is the opposite of the tolerance every other malformed decision receives.

**Putting the failing call's arguments in the transcript.** The previous attempt would show as well as the result. Rejected because arguments carry file bodies, credentials, and the whole content of a failed write; the recorded result plus the turn's own prose is what `what_failed` needs, and reading arguments would make the reviewer's transcript the widest model-visible input in the pipeline.

**Grounding the critique in `evolution-feedback`'s reflections.** The reviewer could read the graded signal for the same failure instead of the turn's own result. Rejected because it widens the pass to a second store for a fact it observes directly, and because the two are different mechanisms at different altitudes: §4.2's ledger-derived reflection is scope-wide recurrence evidence, while this critique is one turn's draft read back to itself.

**A new config field bounding the failure text.** A `maxFailureRowBytes` would cap the row independently of the transcript budget. Rejected because no deployment-varying threshold was introduced: a tool result is bounded by the tool's own output cap, and `maxInputBytes` bounds the framed request as it always did. A new field would also mean a new catalog row for a bound that already exists twice.

## Consequences

- Each gated turn still costs one model call. A turn with no failing tool result is unchanged in prompt, answer, cadence, and cost: no `tool` row exists, so the transcript is byte-for-byte what it was, and a critique that arrives anyway is dropped.
- A failing turn's prompt grows by what the tool result recorded. That is the price of a grounded critique, and it is bounded by the tool's cap and the transcript byte budget, which drops the oldest rows first — so an older failure can fall out of a long turn and go uncritiqued.
- A critique is brief content. It occupies the scope's context roster and its capacity beside every attached item, so on a scope filled to `maxContextItems` the revision is recorded while the critique item warns and is dropped.
- The reviewer still owns no domain. `CRITIQUE_LABEL_PREFIX` names the item and the store's memory record is the only durable copy, so the package still publishes no invariant companion.
- Every critique item changes the scope's digest and therefore re-injects the brief. Two critiques in one turn are two items, and a turn with several failing calls can add several.
- The revision's `evidence` is `inference`, always. A correction is the model's proposal about what to do next, and recording it as a fact or an observation would claim measurement it does not have.

## Testing

`packages/evolution/evolution-reviewer/tests/protocol.spec.ts` pins the fourth action, both prompt sentences, and the boundary that makes the gate possible: an unfilled critique parses beside a valid decision, while a critique missing its confidence or scope rejects the list.

`packages/evolution/evolution-reviewer/tests/reviewer.spec.ts` pins the loop end to end over a real in-memory memory store: a turn with a failing result arrives as `user`/`assistant`/`tool` rows and yields one critique item naming all three fields plus one lesson artifact carrying the correction, the failure as its conditions, `inference`, the model's confidence and scope, and the extracting session as its source; a turn with no failing result drops the same critique, stores the decision beside it, and still makes exactly one call with the unchanged two-row transcript; each of the three unnamed-field variants records no critique item and no lesson; a failing result with no readable text falls back to its error code, and one whose call was never observed falls back to `<tool name>`'s absence and an empty detail; and a scope at its context-item roster records the revision while the critique item warns.

Coverage for the package is 100% per file, which is the repository gate. `pnpm run verify-translation-pairing` passes for the README pair and the note pair.

## Left alone

[Structured lesson extraction](2026-09-14-structured-lesson-extraction.md) owns the decision that the reviewer's answer is a decision array with an indexed window; this note adds one action to it and changes nothing it decided. The reviewer's gates, cooldown, defer queue, recall, and rebuild paths are untouched, and `rebuild` remains a fold over the artifacts already stored rather than a critique path. `evolution-feedback`'s deterministic reflections stay where they are: they are §4.2's analytic half for graded signals, authored without a model, and this critique does not read or write them.
