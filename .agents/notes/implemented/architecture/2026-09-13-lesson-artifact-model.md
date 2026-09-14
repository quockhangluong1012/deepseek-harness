# Agent Note: Lesson artifacts replace the lessons document

Status: implemented

English | [中文](2026-09-13-lesson-artifact-model.zh.md)

## Problem

The evolutionary-harness specification requires every long-term memory artifact to carry structured provenance and quality metadata — statement, source, conditions, evidence, confidence, validation and refutation counts, scope, ttl. `@deepseek-ai/dsh-evolution-memory` stored the whole of `agentLessons` as one markdown string, edited by substring surgery: `addLesson` appended text behind an `includes()` check, and `replaceLesson`/`removeLesson` located an exact substring expected to occur once. There was no per-fact identity, no confidence, no provenance, and no way to say "this fact was contradicted three times" — so nothing could decay, rank, or be checked, and a model editing one sentence had to rewrite a document.

Phase 1 of the artifact model is that reshape for lessons. The question this Agent Note answers is the one the code alone cannot: which of the several defensible reshapes was taken, and what each one costs when it is wrong.

## Decision

`EvolutionMemoryRecord.agentLessons` is `readonly LessonArtifact[]`. An artifact's identity is its normalized statement — lowercased, whitespace collapsed, trimmed — and that identity is its `id`; identities are pairwise distinct within a record, so every operation names exactly one artifact and `updateArtifact` cannot move the name it is addressed by. `addArtifact`, `updateArtifact`, and `removeArtifact` are the id-addressed operations, with staged operations of the same names and payloads.

### Only `agentLessons` becomes an artifact set

`instructions` stays free text because the user authors it: there is no inference to score, nothing to validate, and a confidence number on a direct instruction is noise. `userProfile` stays free text because it is a narrative about a person, not a set of discrete facts — splitting it would be a summarization decision, not a provenance one. The artifact shape describes a model-inferred fact that may be wrong and needs a confidence score, which is exactly `agentLessons`. Bounding the change there also bounds the blast radius: the profile and instruction write paths, their caps, and their stamps are untouched.

### Admission is `version: 2` with `compatibleVersions: [1]`

Version 1 stored `agentLessons` as a markdown string. The per-record backend reads a document whose version stamp is outside the accepted set — the current version plus the declared `compatibleVersions` — as an absent record, deliberately, so one stale file cannot brick a unit. A bare bump to `version: 2` would therefore not fail loudly on an existing installation; it would silently read every scope as empty. The record schema keeps parsing the legacy string shape, and `compatibleVersions: [1]` keeps the old stamp readable, so an old record opens and its first write stamps version 2.

### No `invalidRecords: 'backup-and-skip'`

That policy exists for domains whose records are disposable derived data: the backend moves a schema-failing record aside and the open continues. Evolution memory holds user-authored instructions, session-derived profile text, and staged writes that cannot be rebuilt from a log — there is no second copy anywhere. A schema failure here means real user input would be silently moved aside and forgotten, so this domain keeps the loud default: the open rejects with `invalid-record` and names the scope. The `compatibleVersions` declaration above is what makes that strictness survivable, because the shapes actually on disk are all accepted.

### Migration is synchronous admission, then asynchronous refinement

`read()` is synchronous by contract and every consumer calls it without awaiting; an LLM split is not. So the migration cannot be lazy-on-read without making `read()` async and rewriting every caller. Instead the record schema's `z.union` admits a legacy string as one coarse artifact at parse time — `statement` = the whole document, `source: 'migration-pending'`, `evidence: 'inference'`, `confidence: 0.5`, `scope: 'project'`, both counters `0`, no ttl — and a heartbeat task is where splitting it belongs. The cost is that until Phase 2 lands, a migrated scope renders one very long artifact line instead of a set of facts. That is why `SweepResult.refined` exists and is always `0` in Phase 1: the counter is the honest placeholder for work not yet done, not a lie about work being done.

### A merge target is resolved against the record being written

`addArtifact` measures similarity through the optional `ctx.embeddings` seam, which is asynchronous, and the table's `update` callback is synchronous — so the target has to be selected before the write chain is entered, from the record as it was read. That snapshot is stale by the time the write lands: a concurrent call can have edited the matched artifact, or removed it. The write path therefore re-resolves the selected target by id against the record actually being written, falls back to the candidate's own identity, and then to a fresh artifact, so an add that reports success never dropped its candidate because another write moved first. Under `keep_both` an identity already present stores nothing rather than re-resolving, because two artifacts sharing one identity cannot be told apart.

### `replaceArtifacts` is a document-level operation, not a shim

The markdown extraction pipeline rewrites a scope's lessons as one document and does not yet emit per-candidate operations. Expressing that through the id-addressed operations would mean a remove-all plus an add-all pair: two writes, two stamps, an observable empty intermediate state, and a "replacement" that cannot distinguish "the model dropped this fact" from "another writer removed it in between". A document-level verb states the intent once. It is not a compatibility alias for the old `setLessons`: it validates every candidate into a fresh artifact with a fresh identity, counters, and instants, and refuses a list that repeats an identity rather than silently keeping the last.

### Decay is a heartbeat sweep, not a read-path judgement

`sweep` drops artifacts condemned by `refutationFloor` or by a `ttlDays` exceeded since the last write that reached them, and only when a heartbeat is mounted does the store register `evolution-memory-maintenance` to run it. Reading never prunes: reads are the hot path and a prune is a write. The consequence to keep in view is that keeping an artifact alive takes a write that reaches it — a refinement pass or an explicit edit — never a read, and in Phase 1 nothing yet writes validations.

## Alternatives considered

- **Keep the document and add a sidecar index of facts.** Two representations of the same facts drift the moment one write path updates one and not the other, and the document would remain the thing the renderer and the extraction prompt read. Rejected: one authoritative shape.
- **Bump to `version: 2` without `compatibleVersions: [1]`.** The smallest diff, and it silently empties every existing scope on open — the failure mode is invisible precisely because the backend's contract is "a stale stamp reads as absent". Rejected; the declaration is what turns a data-loss bug into a readable record.
- **Adopt `invalidRecords: 'backup-and-skip'` alongside the compat declaration.** It would let a future malformed record fail without taking down the whole domain open. Rejected because the records it would move aside are user-authored instructions and staged write proposals with no other copy; losing one silently is worse than refusing to start, and a loud failure is recoverable by hand while a skipped record is not.
- **Lazy per-read migration with an LLM split.** No migration step to schedule and the document is never coarse for long. Rejected: `read()` is synchronous and every consumer treats it that way, so it would mean an async read path across the store, the injector, the reviewer, the controller, and the client — a much larger change than the one it migrates.
- **A random identity for each artifact, independent of its statement.** Stable across statement edits, and the obvious first choice for a durable record. Rejected: a random id makes the exact-duplicate check a scan-and-compare rather than a key lookup, gives a staged operation no way to name an artifact a caller can compute, and loses the property that the same fact always keys the same artifact. The cost accepted instead is that editing a statement is a remove plus an add.
- **Merge by default (`merge` instead of `keep_both` on `addArtifact`).** Fewer near-duplicates in the store. Rejected: a wrong similarity call would then rewrite a fact the user never asked to change; `keep_both` can only ever add, so its worst case is a visible duplicate.
- **Let `updateArtifact` patch the statement.** One operation instead of two for a fix. Rejected: the identity is derived from the statement, so a patch that moves it would either leave the `id` wrong or silently re-key the artifact under a name callers already hold.
- **Decay at read time.** No heartbeat task to register or configure. Rejected: pruning is a write, and a read that mutates makes every consumer's cost model wrong.

## Consequences

- Every artifact carries provenance, confidence, and counters that a later extraction can move, and the store can rank and prune facts instead of treating a scope's lessons as one opaque blob. The renderer already spends that: the brief orders artifacts strongest-first.
- `maxAgentBytes` changed meaning. It was a cap on one markdown document; it is now the cap on the sum of the serialized artifacts, each of which carries its statement twice — once as `statement`, once as the normalized `id` that names it — plus a fixed envelope. A deployment that tuned it against a document now budgets a JSON array, and `@deepseek-ai/dsh-evolution-reviewer`'s `squeezeBytes` is documented against the new measure for that reason.
- Phase 1's counters never move: nothing writes a validation or a refutation until Phase 2. Until then decay is driven by `defaultTtlDays` (every artifact admitted through the ordinary write paths is given one), which is a real behavioural change rather than a dormant one — an artifact that no later write reaches is pruned after its ttl.
- A migrated scope is coarse until Phase 2: one artifact whose statement is the whole old document, rendering as one line in the brief and counted as one fact by anything that counts facts. It is a correct permanent fallback, not a broken state, and `refined` says `0` while that is true.
- Without `ctx.embeddings` mounted, paraphrase detection is off: only an exact normalized statement matches, so a reworded duplicate is stored as its own artifact. This is a capability difference, not a failure — the write never rejects for a missing seam.
- Rolling the code back after a version-2 record has been written reads that scope as absent, because the previous declaration accepted only stamp 1. The domain is per-record and the file stays on disk, so nothing is destroyed, but the rollback is not behaviour-preserving.
- Phase 2 (structured extraction in `@deepseek-ai/dsh-evolution-reviewer`) is still owed and is what makes the model live: a per-candidate `confirms` / `contradicts` / `new` / `unrelated` protocol over the scope's current artifacts, wiring `confirms` to `validationCount` and `contradicts` to `refutationCount` and a lowered confidence, the refinement pass that splits a `migration-pending` artifact and turns `refined` into a real number, deletion of the markdown pipeline's `squeeze.ts` and its config, a `maxOutputTokens` default sized for a structured protocol rather than a short document, and the `evolution-controller` request shape becoming an artifact-add protocol instead of a whole-document replacement.
