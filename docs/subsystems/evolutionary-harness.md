# Evolutionary Harness

English | [中文](evolutionary-harness.zh.md)

A scope in the Evolutionary Harness is the durable record of a profile plus a workspace (or the profile-global record): user-authored instructions, model-maintained lessons and user profile, attached context, a produced-file index, and staged writes awaiting approval (`ctx.evolutionMemory`, `packages/evolution/evolution-memory`). The harness learns from user behaviour in the background, curates bounded memory, and improves skills during use; every learned write is capped, staged when configured, logged, and rollback-capable.

Source: [`specs/evolutionary-harness.spec.md`](../../specs/evolutionary-harness.spec.md)

## Parts

| Part | Written by | Reaches the model | Counts against capacity |
|---|---|---|---|
| **Instructions** | the user | yes | yes |
| **Lessons** | the model from this scope's own turns; the user may edit them | yes | yes |
| **User profile** | the model from this scope's own turns; the user may edit it | yes | yes |
| **Context** | the user, as attached files or pasted text | yes | yes |
| **Outputs** | derived from successful mutation-tool calls | no — a navigation index | no |
| **Staged** | proposed by background review, applied on approval | no — pending until approved | no |

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`evolution-memory`](../../packages/evolution/evolution-memory/README.md) | Durable per-scope record, lesson/profile writes, staged writes, and capacity accounting | `ctx.evolutionMemory` |
| [`evolution-reviewer`](../../packages/evolution/evolution-reviewer/README.md) | Turn buffering, output indexing, gated extraction, and on-demand rebuild | `ctx.evolutionReviewer` |
| [`evolution-memory-context`](../../packages/context/evolution-memory-context/README.md) | Renders the brief and splices it into `agent/pre-step`, plus scope nudges | — |
| [`evolution-skill-telemetry`](../../packages/skill/evolution-skill-telemetry/README.md) | Durable per-skill use/view/patch counters with provenance, pin, and lifecycle state | `ctx.evolutionSkillTelemetry` |
| [`evolution-skill-manage`](../../packages/skill/evolution-skill-manage/README.md) | Model-facing `skill_manage` tool that creates, patches, edits, writes, removes, and deletes skills as files | registers on `ctx.tools` |
| [`evolution-curator`](../../packages/evolution/evolution-curator/README.md) | Idle-triggered automatic skill lifecycle transitions with dry-run previews | `ctx.evolutionCurator` |

Scope identities are opaque `profile:workspaceId` (or `profile:global`) keys built with `EvolutionScopeId`. Lesson edits take a substring expected exactly once; an unknown substring rejects with `evolution/item-not-found` and an ambiguous one with `evolution/ambiguous-match`. Storage is machine-local under `$DSH_HOME`; nothing writes inside the project directory.

## Generated API

The [Cordis API](#cordis-surface) section below owns the exhaustive service, event, and Remote listing for the packages above. The generated [configuration catalog](../config-catalog.md) owns every accepted config field.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxevolutioncurator--evolutioncurator"></a>

### `ctx.evolutionCurator` — `EvolutionCurator`

Idle-triggered automatic skill lifecycle curator. Opens the `evolution_curator` domain at init and closes it through `ctx.effect`. Transitions apply through skill telemetry, which stays optional: without the store a pass only advances the bookkeeping.

```ts cordis-catalog
/**
 * Read the last pass instant.
 * @returns the ISO-8601 instant, or null before the first pass.
 */
lastRunAt(): string | null

/**
 * Run one pass over every tracked skill, applying or previewing idle
 * lifecycle movements. A real pass with movements writes one snapshot
 * tarball plus pass and transition ledger entries when backups are on.
 * @param options - clock override and dry-run preview flag.
 * @returns the pass report with every movement.
 */
async run(options: CuratorRunOptions = {}): Promise<CuratorReport>

/**
 * Run a pass only when enabled, the interval elapsed since the last pass,
 * and enough idleness was observed. The first call only seeds the
 * bookkeeping and defers one interval.
 * @param options - clock and idleness overrides plus the dry-run flag.
 * @returns the pass report, or undefined when this call defers.
 */
async maybeRun(options: CuratorMaybeRunOptions = {}): Promise<CuratorReport | undefined>

/**
 * Survey agent-created skills for a future consolidation verdict: names,
 * catalog routing, lifecycle state, idle age, and use counters, sorted by
 * name. The verdict itself (keep, patch, consolidate, archive) arrives
 * separately; the survey never writes.
 * @param options - clock override.
 * @returns the verdict evidence per skill.
 */
async surveyCandidates(options: CuratorRunOptions = {}): Promise<ConsolidationSurvey>

/**
 * Adopt one agent-created skill into user-directed standing, recording the
 * movement in the ledger. Manual only: clocks never reset.
 * @param name - skill name.
 * @returns the stored record with user-directed provenance.
 */
async adopt(name: string): Promise<SkillUsageRecord>

/**
 * Purge archived skills past their time-to-live: remove the skill directory
 * when resolvable, forget the record, and ledger each removal. Pinned
 * skills stay, a zero TTL purges nothing, and dry runs preview only.
 * @param options - clock override and dry-run preview flag.
 * @returns the purge report.
 */
async purge(options: CuratorRunOptions = {}): Promise<PurgeReport>

/**
 * List recorded passes newest-first for status surfaces and rollback picks.
 * @returns one summary per ledger pass entry.
 */
async passes(): Promise<PassSummary[]>

/**
 * Roll back one whole recorded pass, restoring every transitioned skill's
 * lifecycle state. Verifies all evidence before writing anything, snapshots
 * current records first so the rollback stays reversible, and never touches
 * skill directories.
 * @param passId - pass identity from the report or {@link passes}.
 * @param options - clock override.
 * @returns the rollback report.
 */
async rollbackPass(passId: string, options: RollbackOptions = {}): Promise<RollbackReport>

/**
 * Roll back one ledger transition entry. Fails closed on unknown ids,
 * missing blobs, and untracked skills, before any write.
 * @param entryId - ledger entry identity.
 * @param options - clock override.
 * @returns the rollback report.
 */
async rollbackEntry(entryId: string, options: RollbackOptions = {}): Promise<RollbackReport>
```

Source: [`packages/evolution/evolution-curator/src/index.ts`](../../packages/evolution/evolution-curator/src/index.ts)

<a id="ctxevolutionmemory--evolutionmemorystore"></a>

### `ctx.evolutionMemory` — `EvolutionMemoryStore`

Durable per-scope evolution memory store. Opens the `evolution_memory` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Read one scope's record.
 * @param id - scope identity.
 * @returns a detached copy, or undefined when absent.
 */
read(id: EvolutionScopeId): EvolutionMemoryRecord | undefined

/**
 * Capacity accounting for one scope.
 * @param id - scope identity.
 * @returns charged bytes and the configured ceiling.
 */
usage(id: EvolutionScopeId): EvolutionMemoryUsage

/**
 * Digest of the brief's inputs for one scope.
 * @param id - scope identity.
 * @returns `'empty'` when absent, else the sha1 of the covered inputs.
 */
digest(id: EvolutionScopeId): string

/**
 * Replace the user-authored instruction text. Instructions carry no
 * per-field cap; only the scope capacity bounds them.
 * @param id - scope identity.
 * @param instructions - new rules.
 * @returns the stored record.
 */
async setInstructions(id: EvolutionScopeId, instructions: string): Promise<EvolutionMemoryRecord>

/**
 * Replace the whole lessons document by hand or from extraction.
 * @param id - scope identity.
 * @param text - replacement lessons document.
 * @param extraction - provenance when model-written.
 * @returns the stored record.
 */
async setLessons(id: EvolutionScopeId, text: string, extraction?: EvolutionExtraction): Promise<EvolutionMemoryRecord>

/**
 * Append one lesson. An exact duplicate resolves without writing.
 * @param id - scope identity.
 * @param text - non-empty lesson text to append.
 * @returns the stored record, unchanged when the lesson already exists.
 */
async addLesson(id: EvolutionScopeId, text: string): Promise<EvolutionMemoryRecord>

/**
 * Replace one uniquely-matching lesson substring.
 * @param id - scope identity.
 * @param oldText - non-empty substring expected exactly once.
 * @param content - replacement text.
 * @returns the stored record.
 */
async replaceLesson(id: EvolutionScopeId, oldText: string, content: string): Promise<EvolutionMemoryRecord>

/**
 * Remove one uniquely-matching lesson substring.
 * @param id - scope identity.
 * @param oldText - non-empty substring expected exactly once.
 * @returns the stored record.
 */
async removeLesson(id: EvolutionScopeId, oldText: string): Promise<EvolutionMemoryRecord>

/**
 * Replace the whole user profile document by hand or from extraction.
 * @param id - scope identity.
 * @param text - replacement profile document.
 * @param extraction - provenance when model-written.
 * @returns the stored record.
 */
async setUserProfile(id: EvolutionScopeId, text: string, extraction?: EvolutionExtraction): Promise<EvolutionMemoryRecord>

/**
 * Attach pasted text or a scope file.
 * @param id - scope identity.
 * @param input - label plus text or path with its observed size.
 * @returns the stored record.
 */
async addContextItem(id: EvolutionScopeId, input: EvolutionContextItemInput): Promise<EvolutionMemoryRecord>

/**
 * Detach one context item.
 * @param id - scope identity.
 * @param itemId - context item identity.
 * @returns the stored record.
 */
async removeContextItem(id: EvolutionScopeId, itemId: string): Promise<EvolutionMemoryRecord>

/**
 * Stage one write for later approval. Staged entries never count toward
 * capacity; `memoryUpdatedAt` stays untouched until approval.
 * @param input - scope, kind, op, payload, origin session, and gist.
 * @returns the staged entry.
 */
async stageWrite(input: StagedWriteInput): Promise<StagedWrite>

/**
 * Approve one staged write. Memory-kind entries apply their op first, so a
 * cap or substring rejection keeps the entry staged and propagates; the
 * entry drops only after the op lands. Skill-kind entries only drop: the
 * approver reads the payload from the scope record and performs the skill
 * write before approving.
 * @param id - staged entry identity.
 * @returns resolution after durability.
 */
async approveStaged(id: string): Promise<void>

/**
 * Drop one staged write without applying it.
 * @param id - staged entry identity.
 * @returns resolution after durability.
 */
async rejectStaged(id: string): Promise<void>

/**
 * Index produced files newest-first, collapsing repeats onto the newer
 * `at` and truncating to `maxOutputs`. Resolves without writing when the
 * resulting list is unchanged.
 * @param id - scope identity.
 * @param entries - output entries with path, tool, session, and instant.
 * @returns resolution after durability, or immediately when unchanged.
 */
async recordOutputs(id: EvolutionScopeId, entries: readonly EvolutionOutput[]): Promise<void>
```

Source: [`packages/evolution/evolution-memory/src/index.ts`](../../packages/evolution/evolution-memory/src/index.ts)

<a id="ctxevolutionreviewer--evolutionreviewer"></a>

### `ctx.evolutionReviewer` — `EvolutionReviewer`

Background reviewer. One scope never runs two extractions at once; a turn is never blocked by one.

```ts cordis-catalog
/**
 * Rebuild the lessons document from the scope's chat history, read through
 * the asynchronous session query seam. Rebuilds write directly even when
 * background approval staging is on: the caller explicitly asked for them.
 * @param scopeId - scope identity.
 * @param signal - caller cancellation.
 * @returns resolution after the store write.
 */
async rebuild(scopeId: EvolutionScopeId, signal: AbortSignal): Promise<void>
```

Source: [`packages/evolution/evolution-reviewer/src/index.ts`](../../packages/evolution/evolution-reviewer/src/index.ts)

<a id="ctxevolutionskilltelemetry--evolutionskilltelemetry"></a>

### `ctx.evolutionSkillTelemetry` — `EvolutionSkillTelemetry`

Durable per-skill telemetry store. Opens the `evolution_skill_usage` domain at init and closes it through `ctx.effect`. A passive `tools/post-execute` observer counts successful `skill`-tool loads as uses; views, patches, provenance, pins, and states arrive through the explicit marks below.

```ts cordis-catalog
/**
 * Read one skill's record.
 * @param name - skill name.
 * @returns a detached copy, or undefined when never touched.
 */
read(name: string): SkillUsageRecord | undefined

/**
 * List every tracked skill with its record.
 * @returns name/record pairs with detached copies.
 */
entries(): { name: string; usage: SkillUsageRecord }[]

/**
 * Count one successful model load. Bundled and hub skills resolve to no
 * record: the observer still delegates, only the write is skipped.
 * @param name - skill name.
 * @param source - catalog source when the caller already resolved it.
 * @returns the stored record, or undefined for excluded sources.
 */
async markUsed(name: string, source?: string): Promise<SkillUsageRecord | undefined>

/**
 * Count one human view. Exclusion matches {@link markUsed}.
 * @param name - skill name.
 * @param source - catalog source when the caller already resolved it.
 * @returns the stored record, or undefined for excluded sources.
 */
async markViewed(name: string, source?: string): Promise<SkillUsageRecord | undefined>

/**
 * Count one skill-management mutation. Exclusion matches {@link markUsed}.
 * @param name - skill name.
 * @param source - catalog source when the caller already resolved it.
 * @returns the stored record, or undefined for excluded sources.
 */
async markPatched(name: string, source?: string): Promise<SkillUsageRecord | undefined>

/**
 * Record background-review authorship. Resolves without writing when the
 * record already carries it; foreground creates never call this, so their
 * provenance stays user-directed.
 * @param name - skill name.
 * @returns the stored record.
 */
async markAgentCreated(name: string): Promise<SkillUsageRecord>

/**
 * Adopt one agent-created skill into user-directed standing. Only records
 * carrying background-review authorship move; everything else rejects, and
 * clocks never reset.
 * @param name - skill name.
 * @returns the stored record with user-directed provenance.
 */
async markAdopted(name: string): Promise<SkillUsageRecord>

/**
 * Forget one skill's record entirely. Purge calls this after removing the
 * skill directory; absent names resolve without writing.
 * @param name - skill name.
 * @returns whether a record was removed.
 */
async drop(name: string): Promise<boolean>

/**
 * Pin or unpin one skill. Pins block automatic transitions and managed
 * deletion; patches stay allowed. Resolves without writing when unchanged.
 * @param name - skill name.
 * @param pinned - new pin state.
 * @returns the stored record.
 */
async setPinned(name: string, pinned: boolean): Promise<SkillUsageRecord>

/**
 * Move one skill through its curation lifecycle. Entering `archived`
 * stamps the instant; leaving clears it. The absorption target replaces
 * any previous one, so plain transitions carry none.
 * @param name - skill name.
 * @param state - new lifecycle state.
 * @param absorbedInto - consolidation umbrella, or null when standalone.
 * @returns the stored record.
 */
async setState(name: string, state: SkillLifecycleState, absorbedInto: string | null = null): Promise<SkillUsageRecord>
```

Source: [`packages/skill/evolution-skill-telemetry/src/index.ts`](../../packages/skill/evolution-skill-telemetry/src/index.ts)
<!-- END GENERATED cordis-surface -->
