# Agent Note: Structured lesson extraction replaces the squeezed lessons document

Status: implemented

English | [中文](2026-09-14-structured-lesson-extraction.zh.md)

## Problem

Phase 1 turned a scope's lessons into structured artifacts, but nothing moved them. `@deepseek-ai/dsh-evolution-reviewer` still elicited one markdown document per gated turn and replaced the scope's whole artifact array with it, so `validationCount` and `refutationCount` never moved, decay was driven only by `defaultTtlDays`, and each turn's answer had to be rewritten wholesale — a fact the model dropped from one answer disappeared. The document was bounded after the fact instead of by construction: the model was asked for whichever headings it liked, and a pure squeeze then reduced the answer to four memory headings and clipped it to a byte budget, discarding text the deployment had already paid for.

The question this note answers is which protocol replaced that pipeline, and what each part of the replacement costs.

## Decision

One extraction call shows the model the `relevantArtifactLimit` most relevant artifacts of the scope, numbered from 1, beside that turn's transcript, and expects a JSON array of decisions: `confirms` (the artifact at that index is upheld — a `validationCount` bump), `contradicts` (it is contradicted — a `refutationCount` bump, optionally with a corrected statement and confidence), and `new` (a fact no listed artifact covers — the full candidate fields, with `source` taken from the extracting session). An empty array is a common and valid answer. The reviewer resolves every index back to a real artifact id from the exact list it sent, synthesizes each `new` candidate's `source`, and calls `evolution-memory`'s `applyExtractionDecisions`, which folds the batch in decision order against the record read at write time. `rebuild` runs the same pipeline over its selected history instead of the turn buffer.

### Relevance bounds cost and gives up completeness

Ranking is embeddings-optional, mirroring the store's own merge step: with `ctx.embeddings` mounted, the turn text and every artifact statement are embedded in one batch and ranked by cosine similarity; with none mounted, when the batch throws, or when it answers without a query vector, ranking degrades to most-recently-updated first. Ranking never fails an extraction — a less relevant window is a worse answer, not a lost turn.

The window is what makes a turn's cost independent of how large a scope's memory has grown: the prompt shows `relevantArtifactLimit` statements (20 by default) rather than every artifact, and the answer's size follows the turn rather than the store.

What it costs is completeness inside a turn, and, through decay, outside it. An artifact this turn's text does not bring into the window is never confirmed by that call, and confirmation is the only thing that refreshes an artifact's `updatedAt`. A user relying on a fact that later turns stop discussing — a decision taken once and never revisited, a constraint that only mattered during one migration — therefore watches it decay under `defaultTtlDays` even though it is still true. That is the deliberate trade: bounded, predictable cost per turn in exchange for a memory that keeps only what a scope's own conversation keeps re-deriving. The escape hatches are the store's own `ttlDays`-free write path and the refutation floor, not the extraction.

### Index in the prompt, id in the store

The model addresses artifacts by the ordinal it was shown, never by id. An ordinal is cheap to emit and cannot be hallucinated into a write to some other fact: the reviewer resolves it against the exact list it sent, so an index outside that list is a malformed decision — dropped with a warning, leaving the rest of the batch applying — and nothing index-based ever crosses a persistence boundary. Artifact ids are normalized statement text, so putting them in the prompt would also invite the model to edit an id it read rather than a fact it derived.

### A `new` decision still goes through the store's merge resolution

The model's window is not the store's whole contents, so a candidate it calls `new` may still restate an artifact the window left out — possibly an artifact the model was never shown. The batch therefore does not trust the model's verdict of novelty: `applyExtractionDecisions` reuses the same measure-then-re-validate split `addArtifact` uses, resolving each `new` candidate's merge target through the optional embeddings seam before the write chain is entered and re-resolving the selected artifact by id against the record actually being written. Under the default `keep_both` a candidate that restates a stored fact is not stored beside it, which is the point: the alternative is accumulating a near-duplicate of a fact the scope already holds, one per turn, until the lessons cap or decay removes one at random.

### One staged item per extraction call

The turn's whole batch stages as a single `applyDecisions` entry, so it is applied atomically against the record read at approval time — the same resolve-at-write-time rule every other staged memory op follows. A reviewer approving it accepts or rejects the turn's derivation as one thing. That is the cost: a `confirms` that is obviously right cannot be approved while a `contradicts` from the same turn is held back for a second look. The choice was deliberate — the batch is one reading of one turn, and per-decision staging would multiply entries per turn while letting a reviewer apply half a derivation, leaving a corrected statement next to the uncorrected artifact that motivated it. The known gap, surfaced rather than hidden, is that the pending list shows the gist and the decision details but not the transcript evidence behind them, so a human still cannot weigh a contradiction's source.

### Over-cap pressure drops a fact rather than clipping one

The lessons cap can be exceeded by any combination of the batch's statements, so the reviewer's retry removes whole decisions instead of truncating text: it drops the longest `new` statement first, then, once no `new` decision is left, the contradictions' replacement statements while keeping their counter bumps. The retry is bounded by the batch's own `new` count plus one and then propagates the rejection. This replaced the earlier clip-and-retry, which solved for the longest statement prefix the store would accept: a clipped statement is a fact that reads as true, was never argued for by any turn, and no later turn will ever revisit — because the artifact looks settled. Deferring an oversized statement to a later turn loses the same information and leaves the store honest about it.

### `rebuild` folds decisions instead of replacing the document

Rebuild used to regenerate the lessons document from history and write it as the whole array, which made it both the only path that could remove a fact the model no longer believed and a path that could silently drop one the model merely omitted that time. It now runs the same relevance-bounded protocol over the material it selects, so it confirms, corrects, and adds exactly as a live turn does. The cost is explicit: extraction has no removal path at all any more. Retiring a wrong fact is decay's job — `refutationFloor` refutations, or a lapsed ttl — or the store's own `removeArtifact`, which a human or the controller drives. A rebuild can no longer clean out a scope's facts in one call, and it no longer needs to be trusted not to.

### The squeeze pipeline and its configuration are gone

`squeeze.ts`, `LESSON_HEADINGS`, `extractionSystemPrompt`'s document-shaped prompt, `frameExtractionInput`, the dead `clipToBytes` export, and the `squeezeBytes` / `squeezeOrder` config fields are deleted, not deprecated. The protocol bounds output by construction — a bounded window of statements plus a per-decision schema whose `new` entries are the only long field — so there is nothing left for a post-hoc byte budget to buy. The four memory categories the headings enforced (purpose, decisions, preferences, references) survive as guidance in the prompt's rules, where they steer what the model looks for instead of dictating a document shape it must then be squeezed back into. `maxOutputTokens` moved from `1024` to `2048` in the same change, because its old default sized a short fixed-heading document while a busy turn's decision array scales with the number of decisions it produces.

## Alternatives considered

**Keeping the squeeze beside the protocol as a safety net.** It would bound any answer the schema let through. Rejected because the two bound different things: the protocol bounds what is asked for, and squeezing bounds what is kept after the model has already spent tokens producing it. A net that can only ever delete text is not a safety net for a protocol whose failure mode is a long answer; the honest failure is a rejected batch, which the over-cap retry already handles by deferring whole decisions.

**Showing the model every artifact the scope holds.** No ranking step, no embeddings seam, no artifact outside any window and therefore no forgotten-fact decay. Rejected because it makes a turn's prompt and required output grow with the scope: a scope with hundreds of artifacts would need an input budget and an attention span that one turn's evidence does not justify, and the store's cap would become a prompt-size ceiling rather than a memory ceiling.

**Letting the model address artifacts by id.** One less resolution step, and the model already receives ids in other tools. Rejected because a hallucinated id is not a detectable error at the boundary: it either names a different fact, silently corrupting it, or matches nothing, and the decision looks identical to a valid one. An out-of-range ordinal is checkable against the list the reviewer itself sent.

**Staging one entry per decision.** A reviewer could approve the `confirms` and hold the `contradicts` for evidence. Rejected because a batch is one reading of one turn: splitting it lets a turn's correction land without the context that produced it, multiplies pending entries per turn for a command surface that shows one line per entry, and would need a partial-failure story the store's single-write batch exists to avoid.

**Trusting the model's `new` verdict and adding the candidate directly.** Fewer moving parts, and it is the model's stated judgement about novelty. Rejected because the model judges novelty against a window the reviewer chose, not against the store — so a fact outside the window would be duplicated once per turn, and the store already owns the similarity measurement and the floor that decides whether two statements are one fact.

**Truncating an over-cap statement instead of deferring it.** It keeps something rather than nothing. Rejected because a truncated statement is stored as a complete fact with no marker that it is incomplete: it reads as settled, the extraction will never revisit it, and nothing distinguishes it from a fact the model actually intended. Dropping the decision and retrying is a smaller, honest loss.

**Letting a `contradicts` decision delete the artifact.** The model's evidence would be acted on directly. Rejected because deletion is a policy decision the store already owns through `refutationFloor` and ttl: one turn's disagreement should be a data point toward decay, not a destructive write, and giving extraction delete authority would make a bad turn able to erase a hand-authored-adjacent fact with no counter in between.

**Leaving `rebuild` as wholesale replacement.** It was the only removal path, and it matched the document era. Rejected because it made a rebuild's safety depend on the model reproducing every fact it still believed in one answer: one omission dropped a fact permanently, and the two extraction paths — live turn and rebuild — would then have opposite semantics for the same memory.

## Consequences

- `validationCount` and `refutationCount` are live. A turn's evidence moves them, a `confirms` refreshes the artifact's `updatedAt`, and decay now runs on what a scope's own conversation keeps re-deriving rather than on age alone.
- The relevance window is a completeness ceiling as well as a cost ceiling: a still-true fact nothing discusses again decays under `defaultTtlDays`, and no reader is told that it was once known.
- One extraction call is one write: one `lessonsUpdatedAt` stamp, and a batch that changed nothing — an empty one, or one whose decisions all named artifacts the record no longer holds — stamps no family while still recording the call's provenance on `lastExtraction`.
- A contradiction may replace an artifact's statement while the artifact keeps the id every caller addresses it by, so an id stops spelling the statement its artifact holds. `addArtifactTo` therefore resolves a candidate by statement as well as by id, and a corrected fact does not grow a twin on the next turn.
- A staged batch is approved whole. There is no way to accept one decision of a turn and reject another, and the pending list shows decision details without the transcript evidence behind them.
- Extraction has no removal path. Retiring a fact takes decay (three refutations by default, or a lapsed ttl) or the store's own remove operation; a wrong fact that no turn raises again survives until its ttl lapses.
- `squeezeBytes` and `squeezeOrder` are no longer accepted config fields. A composition that still names them sets nothing, and the deployment's document byte budget has no successor: the window and `maxOutputTokens` are what bound a call now.
- `maxOutputTokens` defaults to `2048`. A deployment that tuned the old `1024` for a short document now has headroom for roughly ten decisions per turn; a scope that runs busier raises it.
- Rebuild is no longer a destructive operation. It cannot clear a scope's memory, and it no longer relies on the model's answer being a complete regeneration of it.
- A migrated scope still keeps its coarse `migration-pending` artifact: the protocol folds decisions into the artifacts it is shown rather than refining them, so `SweepResult.refined` remains `0` and nothing splits that artifact yet.

## Testing

`packages/evolution/evolution-memory/tests/decisions.spec.ts` pins the pure fold: a `confirms` bumping only the counter and instant, a `contradicts` replacing statement and confidence while keeping id, creation instant, and validation count, a decision naming an absent artifact skipped, `keep_both` storing nothing for a stored identity, and a mixed batch applying in order against the record each earlier decision produced. `store.spec.ts` pins the service path and the staged `applyDecisions` op: direct write, staged write plus approval, rejection leaving the record unchanged, cap rejection, and a batch that changed nothing stamping no family. `packages/evolution/evolution-reviewer/tests/protocol.spec.ts` pins the indexed framing, the fenced and unfenced parses, the rejected shapes, and that the system prompt names all three actions. `relevance.spec.ts` pins the recency ordering, the vector-less artifact sorting last, and the recency fallback both when embeddings is unmounted and when it throws. `reviewer.spec.ts` pins the end-to-end turn: a confirmation reaching the store's counter, a contradiction bumping the refutation count, a new fact landing as an artifact, an artifact outside the window never being referenced, a malformed answer warning while the stored artifacts survive, and the over-cap retry dropping decisions. `packages/evolution/command-evolution/tests/command-evolution.spec.ts` pins the pending list naming every decision of a staged batch and rendering a gist line alone for a payload it cannot read.
