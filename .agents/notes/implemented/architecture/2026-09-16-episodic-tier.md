# Agent Note: Episodic tier for evolution memory

Status: implemented

English | [中文](2026-09-16-episodic-tier.zh.md)

## Problem

`specs/evolutionary-harness-spec-v10-complete.md` §2.1 keeps three memory tiers — episodic daily logs, curated semantic memory, versioned procedural skills — with dreaming consolidating from episodic into semantic. The repository had two of the three: the semantic tier (`EvolutionMemoryRecord` with instructions, lesson artifacts, and user profile, plus capacity and decay) and the procedural tier (the skill registry with curator lifecycle). The episodic tier was missing: trajectory exports are per-session ShareGPT files for evals, feedback observations are failure signals, and `/journey` is activity history. There was no writable daily log a session could append raw material to, and dreaming consolidated only what the feedback seam reported — a note about something that never failed could never reach durable memory.

## Decision

**One record field, one staged op, one retention rule, one new light source.**

- **Episodic notes live on the memory record, not in a new domain.** `EvolutionMemoryRecord.episodic` is an append-order array of `{ day, text, addedAt }`, admitted with `.default([])` so records written before it open unchanged. A new domain would have duplicated scope isolation, capacity, and versioning the record already owns.
- **`appendEpisodic` is a staged memory op carrying `{ text }`.** Approval appends the note verbatim with its UTC day, then prunes: first notes past `episodicRetentionDays` (default 7), then the oldest past `maxEpisodicEntries` (default 100). A blank note is refused and the entry stays staged. The op stamps no family — the note is unapproved consolidation input, not a curated document — but its text counts toward capacity, and it never enters the brief digest: the brief renders the approved snapshot, and raw material must not re-inject an identical brief.
- **The dreaming light phase reads the surviving notes as candidates.** One note is one sighting; sightings on distinct days are the independent contexts the deep phase gates on (`count` and `sessions`), so a note repeated across days can promote while a once-off note can only reinforce a failure the feedback seam also reported. A note restating a recorded failure folds into that failure's candidate by the existing statement-identity dedupe, keeping the feedback candidate's tool.
- **No consumed-tracking in the dreams record.** Notes re-stage while retention keeps them; the deep phase's promoted set already refuses a second promotion, exactly as it does for failures the feedback seam reports again. Storing consumed keys would have made episodic behave differently from feedback (one-shot versus perpetual) for bookkeeping with no observable effect beyond recounts — and a repeated note is re-scored with decayed recency, which is the honest reading of "still true".
- **The controller projects the tier.** `EvolutionMemoryValue.episodic` carries the notes over the Remote face, so a Remote reader sees the same three tiers the record stores.

## Alternatives considered

- **A separate `evolution_episodic` domain and service.** Rejected: the tier needs scope isolation, capacity accounting, and durable versioning, all of which the memory record already provides; a new service would have added catalog, docs, and seam surface for a different table name.
- **A direct append verb bypassing staged writes.** Rejected: the staged path is the governance the tier was approved with — raw model output lands in durable memory only through approval, the same rule every other memory write follows.
- **Counting distinct sessions instead of distinct days for note sightings.** Rejected: a note carries no session identity, and inventing one would mislabel the field; distinct days are the independence the gate actually needs (a note stable across days is what the integration signal rewards).
- **Injecting today's notes into the model brief.** Rejected: the brief is the approved snapshot with a digest contract — unapproved raw notes would invalidate prefix caching semantics the injector was built to protect, and the digest test pins that an episodic append leaves the digest unchanged.

## Consequences

A scope now keeps a short-lived daily log beside its curated families, and dreaming consolidates from both raw material and failure signals — the §2.1 episodic → semantic flow. The costs are stated in the package READMEs: notes are textually deduplicated (two notes saying the same thing in different words are different sightings), a once-off note can never self-promote under the approved gates, and the tier is bounded by retention and count caps rather than curated.

Verification: 4 store tests (verbatim append with UTC day and no family stamp, blank refusal keeping the entry staged, retention-plus-cap pruning under fake timers, capacity rejection plus digest stability), 3 pure `pruneEpisodic` tests, 3 dreaming tests (episodic-only staging without feedback, feedback-note merge keeping one `bash` theme, full light → deep promotion of a note repeated across days with the earliest sighting's text), and episodic assertions on the controller projection. 100% statements, branches, functions, and lines on `packages/evolution/evolution-memory/src` and `packages/evolution/evolution-dreaming/src`.
