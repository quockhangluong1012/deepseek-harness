# Design: Structured lesson artifacts for evolution memory (spec §2.1–2.2)

Status: draft, pending user review.

## Problem

`specs/evolutionary-harness-spec-v10-complete.md` §2.2 requires every long-term memory artifact to carry structured provenance and quality metadata: `statement`, `source`, `conditions`, `evidence`, `confidence` (0–1), `validation_count`, `refutation_count`, `scope`, `ttl_days`, `merge_strategy`, `created_at`, `updated_at`. §2.1's three-tier split (episodic / semantic / procedural) is already realized in this repo's architecture — `evolution-feedback` (episodic), `evolution-memory` + `evolution-dreaming` (semantic), `skill` (procedural) — so this design covers only the remaining gap: giving the semantic tier's model-maintained facts the metadata shape §2.2 asks for.

`@deepseek-ai/dsh-evolution-memory`'s `agentLessons` field is today a single markdown string, edited by **substring surgery**: `addLesson` appends text with an `includes()` dedupe check; `replaceLesson`/`removeLesson` locate an exact, uniquely-occurring `oldText` substring and splice around it (`stageWrite` → `approveStaged` → `applyMemoryStagedOp`). There is no per-fact identity, confidence, or provenance — the whole document is one blob.

`instructions` (explicit user-authored rules) and `userProfile` (a narrative document, not a set of discrete extracted facts) keep their current free-text shape: §2.2's artifact model describes a *model-inferred, possibly-wrong fact that needs a confidence score* — that description fits `agentLessons` specifically, not a user's direct instruction or a profile narrative. This boundary follows directly from the fields' existing documented semantics and is not reopened by this design.

## Scope of this change

Touches: `evolution-memory` (domain schema, staged-write ops, one-time migration), `evolution-reviewer` (extraction schema and prompt), `evolution-memory-context` (rendering), `command-evolution` (staged-write display), a new heartbeat-driven decay sweep, and `dsh-storage-domain`'s schema-version story for this domain. This is larger than any single change built so far this session — comparable in size to the vector channel and dreaming work combined — and is expected to land as its own multi-step implementation plan, not one PR.

## Data model

```ts
/** Whether an artifact came from a fact, a direct observation, or a model inference. */
export type LessonEvidenceKind = 'fact' | 'observation' | 'inference'

/** Scope an artifact's statement applies at, independent of which record stores it. */
export type LessonArtifactScope = 'user' | 'project' | 'global'

/** Merge policy applied when a new candidate statement matches an existing artifact closely enough to need one. */
export type LessonMergeStrategy = 'overwrite' | 'merge' | 'keep_both'

/** One durable extracted fact in a scope's lessons document. */
export interface LessonArtifact {
  /** Stable identity assigned at creation; staged ops address an artifact by this id, never by text offset. */
  id: string
  /** Short, clear, actionable statement of the fact. */
  statement: string
  /** Conversation or task the fact was drawn from: a session id, or a short label for a manually staged entry. */
  source: string
  /** When this fact applies. */
  conditions: string
  /** Whether it is a fact, a direct observation, or a model inference. */
  evidence: LessonEvidenceKind
  /** 0..1 confidence. */
  confidence: number
  /** Times a later extraction confirmed this fact. */
  validationCount: number
  /** Times a later extraction contradicted this fact. */
  refutationCount: number
  /** Scope this applies at. */
  scope: LessonArtifactScope
  /** Days of no confirmation before this artifact is eligible for decay-pruning; undefined never expires by age. */
  ttlDays?: number | undefined
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 instant of the last validation, refutation, or edit. */
  updatedAt: string
}
```

`EvolutionMemoryRecord.agentLessons` changes from `string` to `readonly LessonArtifact[]`. `lessonsUpdatedAt` keeps its existing meaning (latest write to the array). The domain schema (`spec.ts`'s `evolutionMemoryRecord`, and its generated `.d.ts`) gets a matching zod shape; `dsh-storage-domain`'s schema version for this domain bumps, with the migration below as the upgrade path (never rewriting a prior generation in place per this repo's schema-evolution rule).

## Write path: staged ops

Replace the three substring ops with id-addressed CRUD:

- `addArtifact` — payload `{ candidate: LessonArtifactInput }` (id/createdAt/updatedAt/counts are server-assigned, never caller-supplied).
- `updateArtifact` — payload `{ id, patch: Partial<Pick<LessonArtifact, 'statement' | 'conditions' | 'confidence' | 'validationCount' | 'refutationCount' | 'ttlDays'>> }`. This is also how validation/refutation counters get bumped (see below) and how a manual edit lands.
- `removeArtifact` — payload `{ id }`.

`stageWrite`/`approveStaged`/`rejectStaged` keep their existing shape (stage → approve/reject → resolution log); only `applyMemoryStagedOp`'s memory-kind switch changes to dispatch these three ops instead of the substring ones.

## Merge strategy: dedupe by meaning, not by exact text

`addArtifact` runs a dedupe check before deciding whether it is really an add: embed the candidate statement, embed each existing artifact's statement (cached per artifact the same way `session-query-sqlite`'s vector channel caches document vectors — content-hash keyed, embedded once), and take the nearest match. Above a configured similarity floor, the caller's requested `LessonMergeStrategy` decides the outcome:

- `overwrite` — replace the matched artifact's `statement`/`evidence`/`conditions`, keep its `id`, `createdAt`, `validationCount`, `refutationCount`; bump `updatedAt`.
- `merge` — union `conditions`, take the higher `confidence`, keep the matched `id`; bump `updatedAt`.
- `keep_both` — add as a genuinely new, independent artifact despite the match (the caller has a reason two similar-sounding facts should both survive).

Below the similarity floor, `addArtifact` always creates a new artifact regardless of the requested strategy — there is nothing to merge against.

`ctx.embeddings` is an **optional** dependency for this dedupe step, matching the graceful-degradation pattern this session already established for `dsh-active-memory-context` and `searchSessionsSemantic`: without it, dedupe falls back to exact normalized-statement equality (the same fingerprint approach `evolution-dreaming`'s `DreamCandidate.id` already uses), which only catches literal duplicates, not paraphrases. This is a real capability difference to document, not a silent gap.

## Validation and refutation: owned by `evolution-reviewer`'s existing extraction pass

`evolution-reviewer` already makes one LLM call per `/refine` to rebuild lessons from session history. This design extends that same call rather than adding a new integration point: the prompt is given the scope's *current* artifacts as context and asked, per candidate fact it derives from the session history, to judge one of `confirms <existing id>` / `contradicts <existing id>` / `new` / `unrelated`.

- `confirms` → `updateArtifact` bumping `validationCount` and `updatedAt`.
- `contradicts` → `updateArtifact` bumping `refutationCount`, `updatedAt`, and lowering `confidence` (halved, floored at 0.05, never auto-deleted by a single contradiction — that is what `refutationCount` combined with decay is for).
- `new` → `addArtifact` (which itself runs the merge-strategy dedupe above as a backstop, in case the extraction call missed an existing near-duplicate).
- `unrelated` → no-op.

This makes `refutationCount` and repeated low confidence the signal a decay sweep prunes on, rather than inventing a second, separate contradiction-detection pipeline.

## Decay: a new heartbeat task, not reused dreaming decay

`evolution-dreaming`'s decay logic prunes stale *dreams*, a completely separate domain; it is not reused here. This design registers a new `evolution-memory` heartbeat task (via `ctx.evolutionHeartbeat`, the same registration path `evolution-dreaming` already uses) that sweeps every scope's artifacts and removes any artifact whose `ttlDays` has elapsed since `updatedAt` with no confirming validation in that window, or whose `refutationCount` has crossed a configured floor regardless of age. An artifact with no `ttlDays` never expires by age.

## Rendering: `evolution-memory-context`

The lessons section renderer changes from "the whole markdown string, truncated by byte count" to "each artifact rendered as one line, best-first": `- <statement> (confidence: 0.82, source: <label>)`, sorted by `confidence` descending, weakest (lowest-confidence) artifacts dropped first under budget pressure — the same best-first, drop-weakest-last render discipline this session already used for `dsh-active-memory-context`'s brief.

## Rendering: `command-evolution`

The `/memory`/staged-write display changes from a text diff to an artifact diff: an `addArtifact` staged entry shows the full candidate fields; `updateArtifact` shows only the changed fields against the current artifact; `removeArtifact` shows what would be dropped.

## Migration for existing persisted records

Existing scope records hold `agentLessons: string`. The reshape cannot be a lazy per-read migration as first written here: `read()` is deliberately **synchronous** (every consumer calls it without awaiting), while an LLM split is asynchronous, and a synchronous reader has no way to await one. The migration is therefore two-stage:

1. **Structural admission, synchronous, at parse time.** The record schema accepts `agentLessons` as either the legacy string or the artifact array (`z.union`), under `version: 2` with `compatibleVersions: [1]`. A legacy record parses; its string is wrapped into exactly one artifact (`id` derived from the normalized text, `source: 'migration-pending'`, `evidence: 'inference'`, `confidence: 0.5`, `conditions: ''`, `scope: 'project'`, both counters `0`). No record ever fails to open because of this change, and no read ever blocks.
2. **LLM refinement, asynchronous, on a heartbeat.** The new maintenance task (see Decay) also finds every artifact still marked `source: 'migration-pending'`, splits its `statement` into discrete artifacts via one LLM call per scope, and replaces the coarse one through the ordinary `addArtifact`/`removeArtifact` write path. Refinement is best-effort: a failed call leaves the coarse artifact in place and retried on the next pass, so the coarse form is a permanent, correct fallback rather than a transient broken state.

A bare `version: 2` bump without `compatibleVersions: [1]` would **silently empty the domain** — the json per-record backend reads an unaccepted version stamp as an absent record, never an error. This is the exact failure the [projection-cache cross-version note](../../../.agents/notes/implemented/architecture/2026-09-02-projcache-cross-version-read-compat.md) documents; the bump follows its procedure (declare compat, keep the stored schema able to parse every accepted shape, let the owning reader interpret). Unlike that precedent, this domain deliberately does **not** adopt `invalidRecords: 'backup-and-skip'`: evolution memory holds user-authored instructions and staged writes that cannot be rebuilt from a log, so a record that fails even the compat schema must still fail the domain open loudly, which is what `spec.ts`'s existing comment ("instructions are user-authored, not disposable derived data") already promises.

## Delivery phases

Research for the implementation plan found `evolution-reviewer`'s extraction to be **free-form markdown under four fixed headings** — no structured output, no output schema, no parse step; its `squeeze.ts` exists only to trim that markdown under byte pressure. The design's per-candidate `confirms`/`contradicts` protocol therefore replaces that whole pipeline rather than extending it. That, plus six affected packages and a storage-format bump, is more than one plan should carry. Split:

- **Phase 1 — the artifact model itself** (`evolution-memory` + its synchronous-read consumers): the `LessonArtifact` type and schema, `version: 2` with `compatibleVersions: [1]` and the sync structural migration, the three id-addressed staged ops, the merge-strategy dedupe step, `digestOf`/`usedBytesOf`/capacity over the array, the `evolution-memory-context` renderer, `evolution-dreaming`'s one read of the field, and the heartbeat maintenance task (decay + migration refinement). Phase 1 ships working software on its own: extraction still writes one artifact per document, everything reads correctly, and every existing domain is preserved.
- **Phase 2 — structured extraction and the quality loop** (`evolution-reviewer` + wire surfaces): replace the markdown prompt with a structured per-candidate protocol, delete `squeeze.ts` and its config, make both extraction paths (`rebuild` and background) feed current artifacts into the prompt, wire `confirms`/`contradicts` to the counters, resize `maxOutputTokens`, and update the `evolution-controller` Remote request shape.

Each phase is independently testable and independently landable; Phase 1 alone changes no model-facing output beyond the lessons section's rendering.

## Consumers not touched

`evolution-graph`, `evolution-dreaming`'s own `DreamsRecord`, and `evolution-feedback` are untouched — none of them read or write `agentLessons`.

## Open questions for the implementation plan (not blocking design approval)

- Similarity floor, decay-refutation floor, decay cadence, and the migration-refinement cadence are new tunable `Config` fields (per this repo's "no hardcoded tunables" rule) whose default *values* need picking; the design fixes their existence and role, not their numbers.
- `evolution-reviewer`'s `maxOutputTokens` default (1024 today) is sized for a short markdown document; a per-candidate structured protocol over a whole transcript needs a larger default, or a chunking story. Sized during planning against a real transcript.
- `evolution-controller`'s `setLessons` Remote RPC is a public wire contract with a `lessons: string` request field. Whether it becomes an artifact-shaped request, or is replaced by an artifact-add request, is a wire-compatibility decision for the plan — no in-repo caller does protobuf-style version negotiation, so it can change, but every affected README and host test moves with it.

## Self-review

- Placeholder scan: no TBD/TODO left; the two open questions above are explicitly deferred to planning, not gaps in the design itself.
- Internal consistency: the merge-strategy section and the validation/refutation section agree on the same embeddings-optional degradation story; the rendering sections both follow the same best-first/drop-weakest convention already established this session.
- Scope check: this is one coherent design (one new type, one write-path change, one new consumer trigger, one new heartbeat task, one migration) — large, but not multiple unrelated projects bundled together.
- Ambiguity check: "artifact" scope is explicitly bounded to `agentLessons` only, with the reasoning stated, so it cannot be misread as also covering `instructions`/`userProfile`.
