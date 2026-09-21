# Lesson Artifact Memory — Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `evolution-reviewer`'s free-form markdown extraction (one coarse document, wholesale-replaced every call) with a structured per-candidate protocol that confirms, contradicts, or adds discrete `LessonArtifact`s against a relevance-bounded slice of the scope's current facts, wiring `validationCount`/`refutationCount` live and retiring `squeeze.ts`.

**Architecture:** Two new pure `evolution-reviewer` modules — `relevance.ts` (embeddings-optional top-N selection of the scope's own current artifacts) and `protocol.ts` (the structured prompt plus the model's index-referenced decision schema) — replace `prompt.ts`. The reviewer resolves the model's index references back to real artifact ids using the same list it sent, then calls one new `evolution-memory` write path, `applyExtractionDecisions`, that folds confirms/contradicts/new through the existing `mergeArtifact`/`addArtifactTo`/`patchArtifactIn` primitives and the existing async-then-sync merge-target resolution `addArtifact` already uses. One extraction call's whole decision batch stages or applies as a single unit, matching today's one-item-per-call staging shape.

**Tech Stack:** TypeScript (strict, ESM), Cordis services (`ctx.effect`, optional `ctx.get('embeddings')`), `@deepseek-ai/dsh-llm` streaming `GenerateOptions`, `zod` for the decision protocol and the staged payload, `@deepseek-ai/schemastery` for `Config`, Vitest.

**Spec:** [docs/superpowers/specs/2026-09-13-lesson-artifact-memory-design.md](../specs/2026-09-13-lesson-artifact-memory-design.md) (Phase 2 section, lines 116–131)

## Design decisions carried from planning (binding, not open)

- **Relevance-bounded, not whole-scope.** Every extraction call shows the model only the `relevantArtifactLimit` (default 20) artifacts most relevant to this turn — ranked by cosine similarity against `ctx.get('embeddings')` when mounted, falling back to most-recently-`updatedAt`-first when it is not (same embeddings-optional degradation story `merge.ts` already ships). An artifact outside that window is never confirmed by this call; it ages under `defaultTtlDays` exactly as Phase 1 already documents. This bounds cost and required output regardless of scope size.
- **One staged item per extraction call.** The whole turn's decision batch (0 or more confirms/contradicts, 0 or more new artifacts) is one `StagedWrite` under `writeApproval`, applied atomically on approval — matching today's one-item-per-call shape. No per-decision staging.
- **Index in the prompt, id in the store.** The model references existing artifacts by a small ordinal index (`1`, `2`, …) assigned to the relevance-bounded list sent in that call — cheap, unambiguous, no risk of a hallucinated id. The reviewer resolves every index back to the real artifact id from the exact list it sent, before the decision ever reaches a staged payload or a store call. Nothing index-based crosses a persistence boundary.
- **A "new" decision still goes through the existing merge-by-meaning path.** A candidate the model calls `new` might still coincide with an artifact *outside* the relevance window; `applyExtractionDecisions` reuses the same async merge-target pre-resolution `addArtifact` already performs (`evolution-memory/src/index.ts`, the `addArtifact` public method and its threading into `applyMemoryStagedOp`'s `addTarget` parameter), so a genuine duplicate still merges instead of accumulating.

## Global Constraints

- Every package under `packages/evolution/*` and `packages/client/ui-evolution` compiles under `strict: true` with `noImplicitAny`; no new `as unknown as` cast beyond the ones already present at intake.
- Per-file 100% coverage (`pnpm run test:coverage`) on every `packages/*/*/src` file this plan touches. No `v8 ignore` unless the branch is unreachable by construction, justified in a comment.
- Every non-obvious module and export carries JSDoc with `@param`/`@returns`; `verify-export-jsdoc` gates it.
- No hardcoded tunables: every new numeric choice is a validated `Config` field with a `.default()`, added in all four places (`Config` interface, schemastery field const, `ResolvedConfig`, `resolveConfig`).
- Files end with exactly one trailing newline.
- Bilingual docs: any `README.md` change is mirrored in `README.zh.md`, then `pnpm run verify-translation-pairing --write <path>` records the pair.
- Clean cutover: `squeeze.ts`, `LESSON_HEADINGS`, `extractionSystemPrompt`, `frameExtractionInput`, and the dead `clipToBytes` export (identified as unused by the Phase 1 final review) are deleted, not deprecated. Every in-repo importer moves in the same plan.
- Never widen the counters' meaning beyond the spec: `validationCount` only increments on an explicit `confirms` decision; `refutationCount` only increments on an explicit `contradicts` decision. No other code path may touch them.
- Staged-write approval already resolves against the live record at apply time (`evolution-memory/src/index.ts` `approveStaged` → `applyMemoryStagedOp`); every new write path in this plan follows that same resolve-at-write-time rule, never a pre-read snapshot.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/evolution/evolution-memory/src/decisions.ts` **(new)** | `LessonDecision` (id-addressed: `confirms` \| `contradicts` \| `new`), its zod schema, and the pure `applyLessonDecisions` fold over confirms/contradicts/new |
| `packages/evolution/evolution-memory/src/types.ts` | Add `MemoryStagedApplyDecisionsPayload` |
| `packages/evolution/evolution-memory/src/index.ts` | New `applyExtractionDecisions` service method, new `case 'applyDecisions'` in `applyMemoryStagedOp`, async merge-target pre-resolution for `new` sub-decisions before staging/direct-write |
| `packages/evolution/evolution-reviewer/src/relevance.ts` **(new)** | Pure ranking + one async selector: the scope's top-`relevantArtifactLimit` artifacts for this turn, embeddings-optional |
| `packages/evolution/evolution-reviewer/src/protocol.ts` **(new, replaces `prompt.ts`)** | System prompt, user-frame builder showing the indexed relevant-artifact list, `ExtractionDecision` zod schema (index-addressed), fenced-JSON parser |
| `packages/evolution/evolution-reviewer/src/prompt.ts` **(deleted)** | Superseded by `protocol.ts` |
| `packages/evolution/evolution-reviewer/src/squeeze.ts` **(deleted)** | Superseded: the protocol bounds output by construction (relevance window + per-decision shape), not post-hoc byte squeezing |
| `packages/evolution/evolution-reviewer/src/index.ts` | Config (`relevantArtifactLimit` new, `maxOutputTokens` default resized, `squeezeBytes`/`squeezeOrder` removed), `applyExtraction` replaces `storeDocument`, `runExtraction` and `rebuild` both feed the relevance-bounded list and resolve indices to ids |
| `packages/evolution/command-evolution/src/journey.ts` (or wherever the staged-entry pending summary is built — confirm exact file during Task 5) | Render an `applyDecisions` staged entry: counts of confirms/contradicts/new plus each new statement and each contradiction's old→new text |
| READMEs: `evolution-memory`, `evolution-reviewer`, `command-evolution` (+ `.zh.md` each) | Document the live counters, the new write path, and the new staged-entry rendering |

---

### Task 1: `evolution-memory` decision vocabulary and apply path

**Files:**
- Create: `packages/evolution/evolution-memory/src/decisions.ts`
- Test: `packages/evolution/evolution-memory/tests/decisions.spec.ts`
- Modify: `packages/evolution/evolution-memory/src/types.ts` (add `MemoryStagedApplyDecisionsPayload`)
- Modify: `packages/evolution/evolution-memory/src/index.ts` (new `applyExtractionDecisions` method; new `case 'applyDecisions'`; async pre-resolution)
- Test: `packages/evolution/evolution-memory/tests/store.spec.ts` (extend with the new path's coverage)

**Interfaces:**
- Consumes: `LessonArtifact`, `LessonArtifactInput`, `LessonArtifactPatch`, `lessonArtifact`, `lessonArtifactInput` from `./lesson-artifact.ts`; `mergeArtifact`, `pickMergeTarget`, `cosineSimilarity` from `./merge.ts`; the existing pure helpers `addArtifactTo`, `patchArtifactIn`, `removeArtifactFrom`, `checkArtifactCaps` and the async merge-target pre-resolution the public `addArtifact` method already performs (`packages/evolution/evolution-memory/src/index.ts` — read the `addArtifact` method and its call into `applyMemoryStagedOp`'s `addTarget` parameter for the exact pattern to mirror; do not re-derive it independently).
- Produces:
  - `type LessonDecision = { kind: 'confirms'; artifactId: string } | { kind: 'contradicts'; artifactId: string; statement?: string; confidence?: number } | { kind: 'new'; candidate: LessonArtifactInput; strategy?: LessonMergeStrategy }`
  - `const lessonDecision: z.ZodType<LessonDecision>`
  - `function applyLessonDecisions(record: EvolutionMemoryRecord, decisions: readonly LessonDecision[], addTargets: ReadonlyMap<number, LessonArtifact | undefined>, now: string, defaultTtlDays: number): EvolutionMemoryRecord` — `addTargets` keys by the decision's index in the input array, carrying the pre-resolved merge target for each `new` decision (`undefined` for `confirms`/`contradicts`, and for a `new` decision with no match). A `confirms` or `contradicts` decision whose `artifactId` no longer exists in `record` (the target artifact was pruned between resolution and apply) is skipped, not thrown — same "the record changed underneath us, apply what still applies" tolerance `patchArtifactIn` already has for an absent id (read its current behavior and match it).
  - `interface MemoryStagedApplyDecisionsPayload { decisions: LessonDecision[] }` in `types.ts`
  - `applyExtractionDecisions(scope: EvolutionScopeId, decisions: readonly LessonDecision[], extraction: EvolutionExtraction): Promise<void>` on `EvolutionMemoryStore` — the direct-write path (mirrors the existing `replaceArtifacts(scope, candidates, extraction)` method: same async merge-target pre-resolution for `new` decisions, same `checkArtifactCaps` after applying, same `withStagedExtraction`-equivalent provenance stamp)
  - Staged op `'applyDecisions'` (kind `'memory'`), payload `MemoryStagedApplyDecisionsPayload` — `approveStaged` for this op runs the identical `applyLessonDecisions` fold against the record read fresh at approval time; the async merge-target pre-resolution for its `new` decisions happens once at `stageWrite` time (mirroring `addArtifact`'s existing staged path) and is re-validated (not blindly trusted) against the live record at approval, exactly as `addArtifact`'s staged path already does — read that path and mirror it, do not invent a second policy.

- [ ] **Step 1: Read the existing merge-target pre-resolution pattern.** Open `packages/evolution/evolution-memory/src/index.ts`, locate the public `addArtifact` method and its staged counterpart (`stageWrite` with `op: 'addArtifact'`, and `case 'addArtifact'` in `applyMemoryStagedOp`). Write down, in the task's own notes (not committed), exactly which function computes the merge target asynchronously, what it does when the target artifact has vanished by apply time, and how the direct-write and staged paths share that logic. This step has no code output — the next steps depend on getting this right.

- [ ] **Step 2: Write `decisions.ts`'s failing tests.** Cover, at minimum: a `confirms` decision increments `validationCount` and refreshes `updatedAt` on the named artifact and touches nothing else about it; a `contradicts` decision increments `refutationCount`, and when it carries a `statement`/`confidence` those replace the artifact's fields while `id`/`createdAt`/`validationCount` stay fixed (mirror `mergeArtifact`'s field-preservation discipline); a `contradicts` decision with no `statement`/`confidence` only bumps the counter and touches nothing else; a `confirms`/`contradicts` decision whose `artifactId` is absent from the record is a silent no-op (record unchanged) — because it can legitimately race with a concurrent prune; a `new` decision with a resolved `addTarget` merges into that artifact via `mergeArtifact` under the decision's `strategy` (default `keep_both`), exactly as `addArtifactTo` already does for the direct `addArtifact` op; a `new` decision with no `addTarget` inserts a fresh artifact; a decision batch mixing all three kinds applies every one against the SAME resulting record (order: input array order); `checkArtifactCaps` still rejects an over-cap result from `applyExtractionDecisions`, leaving the store unchanged (mirror the existing `evolution/too-large` behavior `replaceArtifacts` already has, including that the caller — Task 4 — is the one that retries with a clipped statement, not this module).

- [ ] **Step 3: Run the tests to verify they fail.** `pnpm exec vitest run packages/evolution/evolution-memory/tests/decisions.spec.ts` — expect failures citing missing exports.

- [ ] **Step 4: Implement `decisions.ts`.** Pure module, no I/O, no `Context`. Reuse `mergeArtifact`/`addArtifactTo`/`patchArtifactIn` rather than re-implementing artifact mutation; `applyLessonDecisions` is a `reduce` over the decisions array, threading the record forward.

- [ ] **Step 5: Wire `applyExtractionDecisions` and the `applyDecisions` staged op into `index.ts`.** Add the method and the switch case following the exact async-pre-resolution/sync-apply split Step 1 documented. Add `MemoryStagedApplyDecisionsPayload` to `types.ts`.

- [ ] **Step 6: Run the tests to verify they pass**, then extend `tests/store.spec.ts` with the service-level and staged-approval-level coverage (direct write, staged write + approve, staged write + reject leaves the record unchanged, cap rejection). Run `pnpm exec vitest run packages/evolution/evolution-memory --coverage` and iterate until `decisions.ts` and the touched regions of `index.ts`/`types.ts` are 100% on all four measures.

- [ ] **Step 7: Commit.**

```bash
git add packages/evolution/evolution-memory/src/decisions.ts packages/evolution/evolution-memory/src/types.ts packages/evolution/evolution-memory/src/index.ts packages/evolution/evolution-memory/tests/decisions.spec.ts packages/evolution/evolution-memory/tests/store.spec.ts
git commit -m "feat(evolution-memory): apply confirms/contradicts/new decision batches"
```

---

### Task 2: `evolution-reviewer` relevance selection

**Files:**
- Create: `packages/evolution/evolution-reviewer/src/relevance.ts`
- Test: `packages/evolution/evolution-reviewer/tests/relevance.spec.ts`

**Interfaces:**
- Consumes: `LessonArtifact` from `@deepseek-ai/dsh-evolution-memory`; the embeddings service shape already used by `evolution-memory`'s own merge step — read `packages/evolution/evolution-memory/src/index.ts`'s embeddings-optional call site (`ctx.get('embeddings')`, its `embed`-style method, and how a missing mount degrades) and mirror the exact same optional-access pattern; do not invent a second embeddings contract.
- Produces:
  - `function rankByRecency(artifacts: readonly LessonArtifact[], limit: number): LessonArtifact[]` — pure, sorts by `updatedAt` descending, takes the first `limit`; this is the no-embeddings fallback.
  - `function rankBySimilarity(query: readonly number[], artifacts: readonly LessonArtifact[], vectors: ReadonlyMap<string, readonly number[]>, limit: number): LessonArtifact[]` — pure, scores each artifact whose id has a vector in `vectors` via `cosineSimilarity` (import from `@deepseek-ai/dsh-evolution-memory`'s exported `merge.ts` surface — confirm the exact export path during implementation; it is a package the reviewer already depends on), descending, takes the first `limit`; an artifact with no vector entry sorts last, not dropped, so a partial embeddings failure degrades gracefully instead of hiding facts.
  - `async function selectRelevantArtifacts(ctx: Context, artifacts: readonly LessonArtifact[], queryText: string, limit: number): Promise<LessonArtifact[]> ` — when `ctx.get('embeddings')` is mounted, embeds `queryText` and every artifact `statement` in one batch call (reuse whatever batching helper `evolution-memory`'s merge integration already calls — same reasoning: mirror, do not reinvent) and calls `rankBySimilarity`; otherwise calls `rankByRecency`. A failed embeddings call (thrown or rejected) falls back to `rankByRecency` rather than propagating — extraction must never fail because ranking failed.

- [ ] **Step 1: Write the failing tests.** `rankByRecency` orders correctly and truncates to `limit`; `rankBySimilarity` orders by descending cosine score and places a vector-less artifact last; `selectRelevantArtifacts` calls the embeddings service when mounted and falls back to recency both when unmounted and when the embeddings call throws (use a stub `ctx.get` returning a rejecting mock for the throw case).

- [ ] **Step 2: Run to verify failure.** `pnpm exec vitest run packages/evolution/evolution-reviewer/tests/relevance.spec.ts`

- [ ] **Step 3: Implement `relevance.ts`.**

- [ ] **Step 4: Run to verify pass**, then `pnpm exec vitest run packages/evolution/evolution-reviewer --coverage` and iterate `relevance.ts` to 100% on all four measures.

- [ ] **Step 5: Commit.**

```bash
git add packages/evolution/evolution-reviewer/src/relevance.ts packages/evolution/evolution-reviewer/tests/relevance.spec.ts
git commit -m "feat(evolution-reviewer): rank the scope's current artifacts for one turn"
```

---

### Task 3: `evolution-reviewer` structured decision protocol (replaces `prompt.ts`, deletes `squeeze.ts`)

**Files:**
- Create: `packages/evolution/evolution-reviewer/src/protocol.ts`
- Test: `packages/evolution/evolution-reviewer/tests/protocol.spec.ts`
- Delete: `packages/evolution/evolution-reviewer/src/prompt.ts`, `packages/evolution/evolution-reviewer/src/squeeze.ts`, `packages/evolution/evolution-reviewer/tests/prompt.spec.ts`, `packages/evolution/evolution-reviewer/tests/squeeze.spec.ts` (confirm the two test file names against the directory listing before deleting — they may differ)

**Interfaces:**
- Consumes: `LessonArtifact` from `@deepseek-ai/dsh-evolution-memory`; `LessonEvidenceKind`, `LessonArtifactScope` from the same package (for the `new`-decision candidate fields the model must supply).
- Produces:
  - `interface IndexedArtifact { index: number; artifact: LessonArtifact }` — the numbering `frameExtractionInput`'s replacement assigns to the relevance-bounded list for one call.
  - `function extractionSystemPrompt(): string` — replaces the deleted one from `prompt.ts`. Instructs the model: read the transcript; for each durable fact it supports, emit one decision — `confirms` (references an existing indexed artifact this turn's evidence supports, no new text needed), `contradicts` (references an existing indexed artifact this turn's evidence contradicts; may supply a corrected `statement`), or `new` (a fact not covered by any listed artifact: full `statement`/`conditions`/`evidence`/`confidence`/`scope`, optional `ttlDays`) — plus the same forbidden-content guidance the deleted prompt already had (credentials, secrets, health/race/religion/political/gender-identity data, anything readable from code). A candidate worth nothing is simply never mentioned; an empty decision list is a valid, common output for a trivial turn.
  - `function frameExtractionRequest(rows: readonly { role: string; text: string }[], relevant: readonly IndexedArtifact[]): string` — replaces `frameExtractionInput`. Frames the transcript as JSON (unchanged from today) plus a numbered list of the relevant artifacts' `statement`s (index, then statement text only — not the full record, to keep the listing cheap).
  - `interface ExtractionDecision` (index-addressed, the model's own output shape) — `{ action: 'confirms'; index: number } | { action: 'contradicts'; index: number; statement?: string; confidence?: number } | { action: 'new'; statement: string; conditions: string; evidence: LessonEvidenceKind; confidence: number; scope: LessonArtifactScope; ttlDays?: number }`
  - `const extractionDecision: z.ZodType<ExtractionDecision>`
  - `function parseExtractionDecisions(text: string): ExtractionDecision[]` — strips a markdown code fence if present (mirror `evolution-graph/src/index.ts`'s established fenced-JSON parse: read that file's parse site and match its error message style and its fence-stripping regex exactly, don't diverge), `JSON.parse`s, validates as `z.array(extractionDecision)`; a genuinely empty/whitespace-only response parses as `[]` rather than throwing (the model chose to report nothing).

- [ ] **Step 1: Confirm the two test files to delete.** Read the reviewer's `tests/` directory listing and note the exact file names covering `prompt.ts` and `squeeze.ts` before deleting anything (they were not re-confirmed while writing this plan).

- [ ] **Step 2: Write `protocol.ts`'s failing tests.** `frameExtractionRequest` numbers artifacts starting at 1 and includes every relevant artifact's statement; `parseExtractionDecisions` accepts a fenced ```json block, accepts unfenced JSON, rejects an action outside the three, rejects a `confirms`/`contradicts` with a non-integer or negative `index`, rejects a `new` missing a required field, accepts an empty array and accepts an all-whitespace/empty string as `[]`; `extractionSystemPrompt` mentions all three action names verbatim (a cheap regression guard against silently drifting the model-visible vocabulary).

- [ ] **Step 3: Run to verify failure.**

- [ ] **Step 4: Implement `protocol.ts`**, then delete `prompt.ts`, `squeeze.ts`, and their two test files.

- [ ] **Step 5: Run `pnpm exec tsc -b packages/evolution/evolution-reviewer`** — expect failures in `index.ts` (it still imports the deleted modules); this is expected and Task 4 fixes it. Confirm the failures are exactly the imports this task intentionally broke, nothing else.

- [ ] **Step 6: Run the new test file to verify it passes**, then coverage on `protocol.ts` alone (the package as a whole will not compile until Task 4 lands, so scope the coverage run to the one file: `pnpm exec vitest run packages/evolution/evolution-reviewer/tests/protocol.spec.ts --coverage --coverage.include='packages/evolution/evolution-reviewer/src/protocol.ts'`).

- [ ] **Step 7: Commit.**

```bash
git add packages/evolution/evolution-reviewer/src/protocol.ts packages/evolution/evolution-reviewer/tests/protocol.spec.ts
git rm packages/evolution/evolution-reviewer/src/prompt.ts packages/evolution/evolution-reviewer/src/squeeze.ts packages/evolution/evolution-reviewer/tests/prompt.spec.ts packages/evolution/evolution-reviewer/tests/squeeze.spec.ts
git commit -m "feat(evolution-reviewer): structured confirms/contradicts/new protocol"
```

Note: this task deliberately leaves the package non-compiling between this commit and Task 4's. That is acceptable only because both tasks land in the same plan before any shared branch state is reviewed or merged — flag this explicitly to whoever reviews Task 3 alone, so a broken `tsc -b` here is not mistaken for a defect.

---

### Task 4: Wire the protocol into `EvolutionReviewer`

**Files:**
- Modify: `packages/evolution/evolution-reviewer/src/index.ts`
- Modify: `packages/evolution/evolution-reviewer/tests/reviewer.spec.ts` — the only file covering `runExtraction`/`rebuild`/`storeDocument`. This is a fixture rewrite, not a touch-up: at planning time it was 1803 lines, 47 `it` blocks, 36 `harness(` calls, 37 markdown-document model fixtures (34 `immediate('## Purpose…`, 3 `textChunks('## Purpose…`), and 27 `lessonsOf(` assertions against a helper at line 155 (`harness` at line 75) — every fixture becomes a JSON decision array and every `toContain('## Purpose')`-style assertion becomes an artifact/counter assertion. Its import of `DEFAULT_SQUEEZE_ORDER, squeezeLessons` from `../src/index.ts` (line 30) drops both names; its two mechanism tests that exercise the removed pipeline directly (`'replaces the lessons document with one artifact holding the squeezed extraction'`, `'clips over-budget output to the store cap before retrying'`) and the config-driven test using `squeezeBytes` (around line 1783) are rewrites, not edits — re-read the file fresh at implementation time, these line numbers will have moved once Tasks 1–3's own edits to neighboring files are accounted for.
- Modify: `packages/evolution/evolution-reviewer/tests/config.spec.ts` — NOT in the original file list, but it asserts the `squeezeBytes`/`squeezeOrder` fields this task deletes (`it('defaults the recall and squeeze budgets')` and `it('rejects a pressure order that drops a lesson heading')`). Remove exactly the squeeze-specific assertions from the first test (keep its `recallLimit`/`recallQueryChars` coverage) and delete the second test outright along with `checkSqueezeOrder`.

**Interfaces:**
- Consumes: `selectRelevantArtifacts` from `./relevance.ts` (Task 2); `extractionSystemPrompt`, `frameExtractionRequest`, `parseExtractionDecisions`, `ExtractionDecision` from `./protocol.ts` (Task 3); `applyExtractionDecisions`, `LessonDecision` from `@deepseek-ai/dsh-evolution-memory` (Task 1).
- Produces: no new public exports; `storeDocument` is renamed `applyExtraction` and its signature/behavior change (private method, no external interface to preserve).

**Corrections from the Tasks 1–3 review (binding — supersede anything above or in the Steps below that conflicts):**
- **Real exported signatures.** `applyExtractionDecisions(scope: EvolutionScopeId, decisions: readonly LessonDecision[], extraction?: EvolutionExtraction): Promise<EvolutionMemoryRecord>` — not `Promise<void>` as earlier plan text said; it returns the updated record, matching `replaceArtifacts`. Root-exported from `@deepseek-ai/dsh-evolution-memory` alongside `LessonDecision`, `lessonDecision`, `applyLessonDecisions`. `artifactIdOf`/`freshArtifact`/`addArtifactTo` are NOT root exports (package-internal to `decisions.ts`) — do not import them.
- **`ExtractionDecision['new']` carries no `source` field, but `LessonArtifactInput` requires one.** When mapping a model `new` decision to a `LessonDecision`, synthesize `candidate.source` from the extraction's own `sessionId` (the same value `meta.sessionId` already carries at the `runExtraction`/`rebuild` call sites) — this is what the retired `storeDocument` did for its one coarse candidate; carry the same convention forward per-candidate now.
- **Numbering is the caller's job.** Neither `protocol.ts` nor `relevance.ts` assigns `IndexedArtifact.index`; this task assigns it when building the indexed list, 1-based (the schema requires `int().min(1)`).
- **Index policy.** The parser accepts any `index >= 1` with no upper bound tied to the list actually sent. A `confirms`/`contradicts` decision whose `index` falls outside the sent list's `1..n` range is a malformed decision: drop it and log a warning (do not throw the whole batch away for one bad entry — same tolerance the store already has for a vanished artifact id). This is a policy this task owns; neither Task 1 nor Task 3 enforces it.
- **`callModel`'s current signature is `(route, rows, currentLessons, signal, sessionId)` with no scope parameter** (`index.ts:946-952` at the time of the review) and builds its prompt directly; it needs a scope (or the already-read `LessonArtifact[]`) added so it can call `selectRelevantArtifacts`. Its two callers before this task: `rebuild` (passes `''` as `currentLessons`) and the turn path (joins artifact statements into `prior` before calling). Both call sites change together with the signature.
- **Delete, don't just stop calling:** `checkSqueezeOrder` and its one call site (removed together with the two Config fields it validates); `fitArtifactCap` once Step 4's decision-dropping retry replaces its clip-and-retry role — leaving it unused fails the per-file coverage gate. `fitArtifactCap`'s only reason for importing `normalizeStatement`/`utf8Bytes`/`truncateUtf8` goes with it; check whether the file's top-level import list needs trimming once it is gone. The `./prompt.ts`/`./squeeze.ts` import and re-export lines are already dangling from Task 3's deletions (that is expected and is what this task resolves, not a new problem to diagnose).
- **The `evolution/too-large` retry this task builds REPLACES the existing clip-and-retry block, it does not stack beside it.** The existing block calls `fitArtifactCap` then `replaceArtifacts`; both go away together with Step 4's new decision-dropping retry.

- [ ] **Step 1: Update `Config`.** Remove `squeezeBytes`, `squeezeOrder` (interface, zod schema, `ResolvedConfig`, `resolveConfig` — all four places). Add `relevantArtifactLimit: number` (`.step(1).min(1).default(20)`) at all four places. Change `maxOutputTokens`'s default from `1024` to `2048`, with an inline comment stating why: the old default sized a short fixed-heading markdown document; the new protocol's output scales with the number of decisions a busy turn produces (each `new` candidate carries full artifact fields, each `confirms`/`contradicts` is a few tokens), and 2048 covers a turn producing on the order of ten decisions with headroom — still a plain `Config` field, override it per deployment if a scope runs busier than that.

- [ ] **Step 2: Add `static inject` optionality note.** `EvolutionReviewer` does not add `'embeddings'` to `static inject` (that would make it a hard dependency); `relevance.ts`'s `selectRelevantArtifacts` reads it via `ctx.get('embeddings')` itself, matching the existing optional-service pattern. No code change to the class's injection list.

- [ ] **Step 3: Replace `callModel`'s return shape and `storeDocument`.** `callModel` now also needs the relevance-bounded, indexed artifact list before it can build the prompt — read it via `this.ctx.evolutionMemory.read(scope)?.agentLessons ?? []`, pass through `selectRelevantArtifacts(this.ctx, artifacts, <the turn's transcript text joined>, this.resolved.relevantArtifactLimit)`, number the result into `IndexedArtifact[]`. Build the prompt with `frameExtractionRequest`. After the model finishes, `parseExtractionDecisions` the response text (catch a parse failure the same way a call failure is caught today — log a warning, leave the previous document intact, per this module's existing "extraction is a deterministic derivation; failures log a warning" contract stated in its module doc). Resolve each `ExtractionDecision`'s `index` back to the real artifact id using the exact `IndexedArtifact[]` list this call sent (an index outside that list's range is a malformed decision — drop it and log a warning, do not throw the whole batch away for one bad entry). Produce `LessonDecision[]`. Replace `storeDocument`'s body: call `this.ctx.evolutionMemory.applyExtractionDecisions(scope, decisions, extraction)` directly, or stage one `'applyDecisions'` write when `writeApproval` is on — same branching `storeDocument` already has, same `evolution/too-large` retry shape (Step 4 covers the retry).

- [ ] **Step 4: Rework the `evolution/too-large` retry.** Today's `fitArtifactCap` clips one coarse document's text. Under the new protocol the cap can be exceeded by any combination of `new` candidates' statements. On `evolution/too-large`, drop the `new` decision with the longest `candidate.statement` from the batch and retry `applyExtractionDecisions` (not clip mid-sentence — a whole fact either fits or is deferred to a later turn, which is a cleaner failure than a truncated one); if the batch has no `new` decisions left to drop and it still fails (confirms/contradicts alone can grow the record if a `contradicts` decision's replacement `statement` is very long), drop that `contradicts` decision's `statement` field (keep the counter bump, lose the text update) and retry once more; log a warning naming what was dropped either way. This must not loop unbounded — cap retries at the number of `new` decisions plus one, matching "eventually there is nothing left to drop but the confirms/contradicts, and those cannot grow unbounded."

- [ ] **Step 5: Update `rebuild`.** Per the design, rebuild also feeds current artifacts into the same protocol rather than replacing the whole document from scratch — read the scope's current `agentLessons` the same way, run the same `selectRelevantArtifacts` → prompt → parse → resolve → `applyExtractionDecisions` pipeline against the full ranked-or-scanned history rows instead of one turn's buffer. This is a behavior change from today's rebuild (which calls `storeDocument` once with the whole regenerated document); update the method's JSDoc to describe the new semantics precisely (a rebuild now folds its findings into the existing artifacts via the same decision protocol, it does not wipe them).

- [ ] **Step 6: Write the failing tests**, covering at minimum: a turn whose transcript supports an existing (relevant-window) artifact produces a `confirms` decision that survives to a `validationCount` bump on the real store; a turn whose transcript conflicts with an existing artifact produces a `contradicts` decision with a bumped `refutationCount`; a turn introducing a genuinely new fact produces a `new` decision that lands as a fresh artifact; an artifact outside the relevance window (construct a scope with more than `relevantArtifactLimit` artifacts) is never referenced by any produced decision, proving the window is enforced, not merely advisory; a malformed model response (unparseable JSON) logs a warning and leaves the store's current artifacts untouched; the `evolution/too-large` path drops the longest `new` statement first and retries; `writeApproval` on produces exactly one staged `applyDecisions` entry carrying the whole batch; `rebuild` folds findings into the existing artifact set rather than replacing it (seed one pre-existing artifact the rebuilt history also supports, assert it is `confirms`-updated, not duplicated).

- [ ] **Step 7: Run to verify failure, implement, run to verify pass.**

- [ ] **Step 8: Coverage.** `pnpm exec vitest run packages/evolution/evolution-reviewer --coverage` and iterate every touched region of `index.ts` to 100% on all four measures. `pnpm exec tsc -b packages/evolution/evolution-reviewer` clean.

- [ ] **Step 9: Commit.**

```bash
git add packages/evolution/evolution-reviewer/src/index.ts packages/evolution/evolution-reviewer/tests/
git commit -m "feat(evolution-reviewer): extract confirms/contradicts/new decisions per turn"
```

---

### Task 5: Repair consumers and render the new staged entry

**Files:**
- Modify: every in-repo importer of the exports Task 3 deleted or Task 4 changed — find them with a repo-wide search for `LESSON_HEADINGS`, `extractionSystemPrompt`, `frameExtractionInput`, `clipToBytes`, `squeezeLessons`, `DEFAULT_SQUEEZE_ORDER`, `squeezeBytes`, `squeezeOrder` before starting; do not trust this plan's file list to be exhaustive — search fresh.
- Modify: the file that renders a `StagedWrite`'s pending summary for the CLI (`packages/evolution/command-evolution/src/journey.ts`'s `pendingOf`, confirmed at planning time to build `TimelinePending` from a `StagedWrite` — verify this is still the render site and not superseded, then add the `applyDecisions` case) and, if `command-evolution` has a second staged-entry display for `/curator status`/`/curator run --dry-run` (the design's "Rendering: command-evolution" section implies the `/memory` staged-write display; confirm during implementation whether that is the same `pendingOf` site or a second one).

**Interfaces:**
- Consumes: `LessonDecision` from `@deepseek-ai/dsh-evolution-memory` (to type the payload once decoded from `StagedWrite.payload`).
- Produces: no new public exports; extends existing rendering functions' `switch`/`case` coverage.

- [ ] **Step 1: Repo-wide search and fix.** `grep -rn` for every symbol Task 3/4 removed, across `packages/` and `docs/`. Update or remove each hit. Expect at minimum: any README code sample quoting the old markdown-headings prompt, any doc-comment referencing `squeeze`.

- [ ] **Step 2: Add the `applyDecisions` case to the staged-entry renderer.** Format: `"N confirms, M contradicts, K new"` as the one-line gist (already supplied by the reviewer's `gist` field on the staged write — confirm whether the renderer needs its own summary or already trusts the caller-supplied `gist`; if the latter, this step may already be satisfied and the task is to add a *detail* view, not a new summary line), plus, where the existing renderer shows per-op detail for `addArtifact`/`updateArtifact`/`removeArtifact` (Phase 1's Task 7 already built this — read that code first and match its shape exactly), a matching detail: each `new` decision's `candidate.statement`; each `contradicts` decision's target artifact's current statement next to its replacement (when supplied); each `confirms` decision's target artifact's statement alone (nothing changed to diff).

- [ ] **Step 3: Write the failing tests** for the new render case (one staged `applyDecisions` entry with all three decision kinds present, asserting the rendered detail names every one), run to verify failure, implement, run to verify pass.

- [ ] **Step 4: `pnpm exec tsc -b` across every touched package** (there is no single umbrella command for a cross-package consumer sweep; run it per package this task touched) — 0 new errors beyond the pre-existing `usage-ledger` baseline.

- [ ] **Step 5: Coverage** on every touched `src` file to 100% on all four measures.

- [ ] **Step 6: Commit.**

```bash
git add -- <exact touched paths>
git commit -m "fix(evolution): repair consumers of the deleted markdown extraction surface"
```

---

### Task 6: Documentation and generated artifacts

**Files:**
- Modify: `packages/evolution/evolution-memory/README.md` + `.zh.md` (document `applyExtractionDecisions`, the `applyDecisions` staged op, and that `validationCount`/`refutationCount` are now live)
- Modify: `packages/evolution/evolution-reviewer/README.md` + `.zh.md` (full rewrite of the extraction section: the confirms/contradicts/new protocol, the relevance window and its embeddings-optional degradation, `maxOutputTokens`'s new default and why, removal of `squeezeBytes`/`squeezeOrder`, addition of `relevantArtifactLimit`; delete every remaining mention of the four fixed markdown headings)
- Modify: `packages/evolution/command-evolution/README.md` + `.zh.md` if Task 5 changed its rendered output in a way the README documents
- Create: `.agents/notes/implemented/architecture/2026-09-14-structured-lesson-extraction.md` + `.zh.md` — bilingual Agent Note covering, as decisions with their costs: why relevance-bounding trades completeness for bounded cost, and what "an artifact nobody discusses again eventually decays even if still true" means for a user relying on a forgotten fact; why a `new` decision still goes through the async merge-target pre-resolution instead of trusting the model's own relevance window; why one staged item per extraction call rather than per decision, and what a reviewer loses by not being able to approve a `confirms` independently of a `contradicts` in the same batch; that `rebuild`'s semantics changed from wholesale replacement to decision-folding, and what that means for a user who rebuilds expecting a clean slate.
- Regenerate: `docs/config-catalog.md` + `.zh.md` (`pnpm run gen-config-catalog`), following the exact "regenerate from committed sources only" discipline Phase 1's Task 8 fix established if the working tree carries any other uncommitted package's config at execution time — check for that condition before regenerating, do not assume a clean tree.

**Acceptance:**
- `pnpm run verify-config-catalog`, `verify-cordis-catalog`, `verify-doc-graphs`, `verify-subsystem-pages`, `verify-tsconfig-paths` all pass.
- `pnpm run verify-translation-pairing` reports no new issue for any file this task touched.
- Every doc sentence matches HEAD's actual code, verified against the source, not assumed from this plan.

- [ ] **Step 1: Write the README updates and the Agent Note.**
- [ ] **Step 2: Regenerate and verify the generated artifacts**, checking for uncommitted sibling-package leakage into the catalog before committing it (Phase 1's Task 8 found and fixed exactly this failure mode once already — do not repeat it).
- [ ] **Step 3: Record the translation pairs** with `verify-translation-pairing --write` for every changed doc.
- [ ] **Step 4: Commit.**

```bash
git add -- <exact touched paths>
git commit -m "docs(evolution): document the structured confirms/contradicts/new protocol"
```

---

## Self-Review

**1. Spec coverage.** Design doc Phase 2 bullets (lines 116–121): structured per-candidate protocol replacing the markdown prompt (Tasks 3–4); delete `squeeze.ts` and its config (Task 3, Config cleanup in Task 4); both extraction paths (`rebuild` and background) feed current artifacts into the prompt (Task 4 Steps 3 and 5); wire `confirms`/`contradicts` to the counters (Task 1, Task 4 Step 3); resize `maxOutputTokens` (Task 4 Step 1); update the `evolution-controller` Remote request shape — already satisfied in Phase 1 (`setLessons` already takes `{ scopeId, artifacts }`; Phase 2 introduces no new controller-facing write path, since `applyExtractionDecisions` is background-only), noted here rather than a phantom task. "Rendering: command-evolution" (design line 101–103) — Task 5.

**2. Placeholder scan.** No "TBD"/"implement later" left. Task 5's exact render file is marked "confirm during implementation" rather than guessed, because Phase 1's own Task 7 already touched command-evolution's rendering and this plan was written without re-reading that diff line by line — this is a stated verification step, not an unwritten one, matching the same category Phase 1's Task 5 refinement-deferral used.

**3. Type consistency.** `LessonDecision` (Task 1, id-addressed, store-facing) and `ExtractionDecision` (Task 3, index-addressed, model-facing) are deliberately two different types with a resolution step between them (Task 4 Step 3) — verified this distinction is used consistently everywhere both are mentioned in this plan; nowhere does a task pass an `ExtractionDecision` directly into `applyExtractionDecisions` or vice versa.

**Known gap, surfaced rather than hidden:** this plan does not add a way for a human to review a `contradicts` decision's evidence before it lands (writeApproval, when on, still shows only the gist + detail Task 5 builds, not the source transcript). That is unchanged from today's coarse-document behavior and out of scope here — flagging it for whoever scopes a future quality-review UI pass.
