# Evolutionary Harness

English | [中文](evolutionary-harness.zh.md)

A scope in the Evolutionary Harness is the durable record of a profile plus a workspace (or the profile-global record): user-authored instructions, model-maintained lessons and user profile, attached context, a produced-file index, and staged writes awaiting approval (`ctx.evolutionMemory`, `packages/evolution/evolution-memory`). The harness learns from user behaviour in the background, curates bounded memory, and improves skills during use; every learned write is capped, staged when configured, logged, and rollback-capable.

Source: [`specs/evolutionary-harness-spec-v10-complete.md`](../../specs/evolutionary-harness-spec-v10-complete.md)

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

Scope identities are opaque `profile:workspaceId` (or `profile:global`) keys built with `EvolutionScopeId`. Lessons are artifacts addressed by identity — the normalized statement — so an edit names the artifact it changes instead of splicing a document. Storage is machine-local under `$DSH_HOME`; nothing writes inside the project directory.

## Generated API

The [Cordis API](#cordis-surface) section below owns the exhaustive service, event, and Remote listing for the packages above. The generated [configuration catalog](../config-catalog.md) owns every accepted config field.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxevolutioncontroller--evolutioncontroller"></a>

### `ctx.evolutionController` — `EvolutionController`

Host Remote service over the durable evolution record. The stream is owned by the feed; reconnect generations belong to the client transport (`RemoteStream`), which opens a fresh `follow` call per generation, so this service never buffers across a transport loss.

```ts cordis-catalog
/**
 * Load one scope's record.
 * @param request - scope identity.
 * @returns the Remote projection.
 */
@Remote('read') async read(request: EvolutionScopeRequest): Promise<EvolutionMemoryValue>

/**
 * Replace the instruction text.
 * @param request - scope identity and new rules.
 * @returns the updated projection.
 */
@Remote('setInstructions') async setInstructions(request: EvolutionSetInstructionsRequest): Promise<EvolutionMemoryValue>

/**
 * Replace the scope's lesson artifacts wholesale. This is the document-level
 * verb the editor drives: the supplied list becomes the whole lessons
 * document, so an artifact the caller omits is dropped rather than kept
 * beside the new ones.
 * @param request - scope identity and the complete artifact list.
 * @returns the updated projection.
 */
@Remote('setLessons') async setLessons(request: EvolutionSetLessonsRequest): Promise<EvolutionMemoryValue>

/**
 * Replace the user-profile document by hand.
 * @param request - scope identity and new document.
 * @returns the updated projection.
 */
@Remote('setProfile') async setProfile(request: EvolutionSetProfileRequest): Promise<EvolutionMemoryValue>

/**
 * Attach pasted text or a file inside the Workspace.
 * @param request - scope identity, kind, label, and text or path.
 * @returns the updated projection.
 */
@Remote('addContextItem') async addContextItem(request: EvolutionAddContextItemRequest): Promise<EvolutionMemoryValue>

/**
 * Detach one context item.
 * @param request - scope identity and item identity.
 * @returns the updated projection.
 */
@Remote('removeContextItem') async removeContextItem(request: EvolutionRemoveContextItemRequest): Promise<EvolutionMemoryValue>

/**
 * Rebuild the lessons document from the scope's sessions.
 * @param request - scope identity.
 * @param signal - caller cancellation.
 * @returns the updated projection.
 */
@Remote('rebuildMemory') async rebuildMemory(request: EvolutionRebuildMemoryRequest, signal: AbortSignal): Promise<EvolutionMemoryValue>

/**
 * List the scope's pending staged writes.
 * @param request - scope identity.
 * @returns the pending entries in record order.
 */
@Remote('listStaged') async listStaged(request: EvolutionListStagedRequest): Promise<EvolutionStagedValue>

/**
 * Apply one staged write and drop it from the pending list.
 * @param request - scope identity and staged entry identity.
 * @returns the updated projection.
 */
@Remote('approveStaged') async approveStaged(request: EvolutionResolveStagedRequest): Promise<EvolutionMemoryValue>

/**
 * Drop one staged write without applying it.
 * @param request - scope identity and staged entry identity.
 * @returns the updated projection.
 */
@Remote('rejectStaged') async rejectStaged(request: EvolutionResolveStagedRequest): Promise<EvolutionMemoryValue>

/**
 * Render one scope's journey over a window from the record it already keeps.
 * @param request - scope identity and requested window.
 * @returns the timeline.
 */
@Remote('timeline') async timeline(request: EvolutionTimelineRequest): Promise<JourneyTimeline>

/**
 * Stream a complete baseline followed by ordered upserts.
 * @param signal - generation cancellation.
 * @returns baseline followed by ordered scope increments.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<EvolutionFollowFrame>
```

Source: [`packages/evolution/evolution-controller/src/index.ts`](../../packages/evolution/evolution-controller/src/index.ts)

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
 * bookkeeping and defers one interval. Idleness defaults to the newest
 * host-wide session activity this process observed; before any activity is
 * observed the host counts as idle.
 * @param options - clock and idleness overrides plus the dry-run flag.
 * @returns the pass report, or undefined when this call defers.
 */
async maybeRun(options: CuratorMaybeRunOptions = {}): Promise<CuratorReport | undefined>

/**
 * Survey agent-created skills for a future consolidation verdict: names,
 * catalog routing, lifecycle state, idle age, use counters, and the failures
 * recorded in the sessions that loaded each one. The verdict itself (keep,
 * patch, consolidate, archive) arrives separately; the survey never writes.
 * @param options - clock override.
 * @returns the verdict evidence per skill.
 */
async surveyCandidates(options: CuratorRunOptions = {}): Promise<ConsolidationSurvey>

/**
 * Run one opt-in LLM consolidation over the agent-created skills this
 * curator tracks. Returns undefined when consolidation is off, when the
 * seam is unmounted, or when no candidate awaits a verdict. A cost row
 * reaches the ledger before the fork starts; the fork runs as a bounded
 * in-package tool loop over `ctx.llm`; the returned verdicts apply under
 * the full-package rule and land in the same snapshot, ledger, and rollback
 * machinery as an automatic pass.
 * @param options - clock override.
 * @returns the consolidation report, or undefined when no run happened.
 */
async consolidate(options: CuratorRunOptions = {}): Promise<ConsolidationReport | undefined>

/**
 * List the skills the ledger currently stages, worst failure rate first
 * with ties by ascending name. Only the newest entry per skill counts, so a
 * skill restaged after further failures appears once at its latest rate.
 * @returns one row per staged skill.
 */
async staged(): Promise<StagedSkill[]>

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
 * lifecycle state and moving every package a consolidation run relocated
 * back to its original path. Verifies all evidence and every move before
 * writing anything, and snapshots current records first so the rollback
 * stays reversible.
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

/**
 * List every open regression debt, worst first: most passes, then most
 * sessions, then name and merge key. Passes count consecutive sightings, so
 * two co-open debts with equal passes opened on the same pass — the order
 * stays total through the key without reading timestamps. Synchronous: the
 * debt table is an in-memory read over the open domain, unlike the
 * filesystem-backed `staged()` listing.
 * @returns the open debts, detached from the store.
 */
debt(): RegressionDebt[]
```

Source: [`packages/evolution/evolution-curator/src/index.ts`](../../packages/evolution/evolution-curator/src/index.ts)

<a id="ctxevolutioncuratorstatus--evolutioncuratorstatuscontroller"></a>

### `ctx.evolutionCuratorStatus` — `EvolutionCuratorStatusController`

Host Remote face over the mounted curator's ledger summary.

```ts cordis-catalog
/**
 * Read the curator's recorded status plus the two dashboard rates: today's
 * cache-hit share from the usage ledger and the aggregate skill failure
 * rate from telemetry. Either rate is null when its source is unmounted or
 * holds no loads. An unmounted curator is reported as such — never as a
 * pass that never ran.
 * @returns the mounted flag, newest pass instant, recorded passes, and rates.
 */
@Remote('status') async status(): Promise<EvolutionCuratorStatus>
```

Source: [`packages/client/ui-evolution/src/index.ts`](../../packages/client/ui-evolution/src/index.ts)

<a id="ctxevolutiondreaming--evolutiondreaming"></a>

### `ctx.evolutionDreaming` — `EvolutionDreaming`

Durable per-scope dreaming. Opens the `evolution_dreams` domain at init, registers the automatic cycle with the heartbeat when one is mounted, and closes the domain through `ctx.effect`.

```ts cordis-catalog
/** Read one scope's dreams.
 * @param scopeId - scope identity.
 * @returns a detached copy, or undefined when the scope has never dreamed.
 */
read(scopeId: EvolutionScopeId): DreamsRecord | undefined

/**
 * Run one phase for one scope.
 * @param phase - which phase to run.
 * @param scopeId - scope identity.
 * @param sessionIds - sessions whose recorded failures the cycle scans.
 * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
 * @returns what the phase did.
 */
async run( phase: DreamPhase, scopeId: EvolutionScopeId, sessionIds: readonly string[], now: string = new Date().toISOString(), ): Promise<DreamPhaseReport>

/**
 * Run the complete cycle: light, then REM, then deep.
 * @param scopeId - scope identity.
 * @param sessionIds - sessions whose recorded failures the cycle scans.
 * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
 * @returns what each phase did.
 */
async dream( scopeId: EvolutionScopeId, sessionIds: readonly string[], now: string = new Date().toISOString(), ): Promise<DreamReport>

/**
 * Dream every workspace the registry knows. A missing registry makes this a
 * no-op rather than a failure: the automatic cycle is optional infrastructure,
 * while an explicit `run` or `dream` call always works.
 * @param signal - aborts between workspaces at plugin teardown.
 */
async dreamAll(signal?: AbortSignal): Promise<void>
```

Source: [`packages/evolution/evolution-dreaming/src/index.ts`](../../packages/evolution/evolution-dreaming/src/index.ts)

<a id="ctxevolutionfeedback--evolutionfeedback"></a>

### `ctx.evolutionFeedback` — `EvolutionFeedback`

Per-session failure-observation store. Opens the `evolution_feedback` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Read one session's recorded failures.
 * @param sessionId - session identity.
 * @returns a detached copy, newest first, or an empty list when absent.
 */
entries(sessionId: string): readonly FeedbackEntry[]

/**
 * Aggregate the given sessions' failures by tool and message, most-observed
 * first. Distinct sessions that reported a failure are counted, so a
 * failure seen once in four sessions outranks four repeats in one.
 * @param sessionIds - sessions to aggregate, in caller order.
 * @param limit - maximum entries returned.
 * @returns the aggregated failures, newest-highest-count first.
 */
summary(sessionIds: readonly string[], limit: number): FeedbackSummaryEntry[]

/**
 * Grade the given sessions' failures by how decisive each is for a state
 * transition, most decisive first. A failure whose own call was never
 * observed carries no attribution, so it only observes; an attributable
 * failure seen in `triggerReviewSessions` distinct sessions triggers a
 * review, and fewer sessions rank without deciding. Grading happens before
 * the limit, so a decisive signal is never truncated away by a count-ranked
 * one.
 * @param sessionIds - sessions to aggregate, in caller order.
 * @param limit - maximum signals returned.
 * @returns the graded signals, decisive first.
 */
signals(sessionIds: readonly string[], limit: number): FeedbackSignal[]

/**
 * Reflect the given sessions' failures as structured reflections, most
 * decisive first: the ledger-derived half (symptom, violated expectation,
 * observed behavior, confidence) merged with the analyst-supplied half
 * (root cause, corrected strategy, and friends) when one was recorded.
 * Analytic fields stay null until `recordReflection` states them, so a
 * reader never mistakes missing analysis for measured fact.
 * @param sessionIds - sessions to aggregate, in caller order.
 * @param limit - maximum reflections returned.
 * @returns the structured reflections, decisive first.
 */
reflect(sessionIds: readonly string[], limit: number): StructuredReflection[]

/**
 * Read one failure's recorded analysis.
 * @param mergeKey - tool-and-message identity, as `signals` reports it.
 * @returns the stored analysis, or undefined when none was recorded.
 */
reflection(mergeKey: string): ReflectionRecord | undefined

/**
 * Record an analyst's reading of one failure, merging the supplied fields
 * over any analysis already stored. Omitted fields keep their stored value,
 * so a partial reading never blanks an earlier one.
 * @param mergeKey - tool-and-message identity, as `signals` reports it.
 * @param analysis - analytic fields to state; every field is optional.
 * @returns the stored record after the merge.
 */
async recordReflection(mergeKey: string, analysis: Partial<ReflectionAnalysis>): Promise<ReflectionRecord>
```

Source: [`packages/evolution/evolution-feedback/src/index.ts`](../../packages/evolution/evolution-feedback/src/index.ts)

<a id="ctxevolutiongraph--evolutiongraph"></a>

### `ctx.evolutionGraph` — `EvolutionGraph`

Durable per-scope knowledge graph. Opens the `evolution_graph` domain at init, closes it through `ctx.effect`, and registers the heartbeat task that extracts the scopes it has buffered text for.

```ts cordis-catalog
/**
 * Read one scope's graph.
 * @param scopeId - scope identity.
 * @returns a detached copy, or undefined when the scope has no graph.
 */
read(scopeId: EvolutionScopeId): GraphRecord | undefined

/**
 * Merge extracted triples into one scope's graph. An entity seen again keeps
 * its first label and gains a kind if it had none; a relation seen again
 * raises its count instead of adding a second edge. Triples are dropped, not
 * thrown on, once a cap is reached or a part normalizes to nothing, and the
 * count of dropped triples is reported back.
 * @param scopeId - scope identity.
 * @param triples - relations to record.
 * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
 * @returns what the batch added, reinforced, and dropped.
 */
async observe( scopeId: EvolutionScopeId, triples: readonly GraphTriple[], now: string = new Date().toISOString(), ): Promise<GraphObserveResult>

/**
 * Answer one relation query by traversing outward from a subject.
 * @param scopeId - scope identity.
 * @param subject - subject label, matched by normalized identity.
 * @param relation - relation name, matched by normalized identity.
 * @param limit - maximum objects returned, capped by `maxQueryLimit`.
 * @returns the resolved answer, or undefined when the subject is unknown.
 */
answer( scopeId: EvolutionScopeId, subject: string, relation: string, limit: number = this.resolved.maxQueryLimit, ): GraphAnswer | undefined

/**
 * Expand the neighborhood of one entity breadth-first, in both directions,
 * so a caller can navigate connections instead of naming a relation.
 * @param scopeId - scope identity.
 * @param subject - subject label, matched by normalized identity.
 * @param depth - maximum hops, at least 1.
 * @param limit - maximum reached entities, capped by `maxQueryLimit`.
 * @returns the reached entities, origin first, or an empty list when unknown.
 */
expand( scopeId: EvolutionScopeId, subject: string, depth: number = 1, limit: number = this.resolved.maxQueryLimit, ): GraphReach[]

/**
 * Find entities whose label contains a query, most-connected first.
 * @param scopeId - scope identity.
 * @param query - case-insensitive label substring; empty matches every node.
 * @param limit - maximum entities returned, capped by `maxQueryLimit`.
 * @returns the matching entities.
 */
find( scopeId: EvolutionScopeId, query: string, limit: number = this.resolved.maxQueryLimit, ): GraphNode[]

/**
 * Extract relations from text and merge them. One `temperature: 0` call
 * returns JSON, which is validated here before anything is stored: a
 * malformed answer rejects rather than storing a partial graph.
 * @param scopeId - scope identity.
 * @param text - source text to read relations from.
 * @param route - provider and model to call.
 * @param signal - caller cancellation.
 * @returns what the extraction observed and merged.
 */
async extract( scopeId: EvolutionScopeId, text: string, route: { provider: string; model: string }, signal: AbortSignal, ): Promise<GraphExtractResult>
```

Source: [`packages/evolution/evolution-graph/src/index.ts`](../../packages/evolution/evolution-graph/src/index.ts)

<a id="ctxevolutionheartbeat--evolutionheartbeat"></a>

### `ctx.evolutionHeartbeat` — `EvolutionHeartbeat`

Host-wide idle-triggered task registry. Opens the `evolution_heartbeat` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Register one task. The task runs only while its registration is live, so a
 * consumer disposes it by calling the returned disposer. A task registered
 * after start-up is seeded by the next due-check and defers one interval.
 * @param task - identity, cadence, and the work to run.
 * @returns the disposer removing the task; idempotent.
 */
register(task: HeartbeatTask): () => void

/**
 * Inspect the registered tasks' schedule and last outcome.
 * @param name - one task's identity, or every task when omitted.
 * @returns one state per matching task, in registration order.
 */
state(name?: string): HeartbeatTaskState[]

/**
 * Read one task's last attempt instant.
 * @param name - task identity.
 * @returns the ISO-8601 instant, or null when unknown or never attempted.
 */
lastRunAt(name: string): string | null

/**
 * Consider every registered task once, in registration order. A task whose
 * bookkeeping is absent is seeded and deferred; a task whose interval has
 * not elapsed, or whose idle gate is unsatisfied, is deferred. Tasks run
 * sequentially, and a failing task is recorded without stopping the pass.
 * @param options - clock, idleness, and force overrides.
 * @returns one entry per registered task.
 */
async runDue(options: HeartbeatRunOptions = {}): Promise<HeartbeatReport>

/**
 * Run one registered task now, ignoring its interval and the idle gate.
 * @param name - task identity.
 * @param options - clock override.
 * @returns the task's report, or undefined when no such task is registered.
 */
async runTask(name: string, options: HeartbeatRunOptions = {}): Promise<HeartbeatTaskReport | undefined>
```

Source: [`packages/evolution/evolution-heartbeat/src/index.ts`](../../packages/evolution/evolution-heartbeat/src/index.ts)

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
 * Add one candidate artifact to the lessons. A candidate whose identity —
 * its normalized statement — is already present stores nothing under
 * `keep_both`, and under `overwrite` or `merge` folds into the artifact the
 * candidate matches: the one its identity already keys, otherwise the most
 * similar artifact at or above `mergeSimilarityFloor`, measured through the
 * optional `ctx.embeddings` seam. Without that seam only identity matches,
 * so a paraphrase is stored as an artifact of its own. `keep_both` never
 * merges: a candidate that is not an exact identity is stored beside the
 * artifact it resembles.
 * @param id - scope identity.
 * @param candidate - the fact to store.
 * @param strategy - how the candidate folds into the artifact it matches.
 * @returns the stored record, or the current record unchanged when the add
 * stores nothing.
 */
async addArtifact( id: EvolutionScopeId, candidate: LessonArtifactInput, strategy: LessonMergeStrategy = 'keep_both', ): Promise<EvolutionMemoryRecord>

/**
 * Patch one existing artifact. Identity, counters, statement, and the
 * creation instant are not patchable.
 * @param id - scope identity.
 * @param artifactId - the addressed artifact.
 * @param patch - changes to apply; absent fields keep their stored value.
 * @returns the stored record.
 */
async updateArtifact( id: EvolutionScopeId, artifactId: string, patch: LessonArtifactPatch, ): Promise<EvolutionMemoryRecord>

/**
 * Drop one existing artifact.
 * @param id - scope identity.
 * @param artifactId - the addressed artifact.
 * @returns the stored record.
 */
async removeArtifact(id: EvolutionScopeId, artifactId: string): Promise<EvolutionMemoryRecord>

/**
 * Apply one extraction pass's whole decision batch: a `confirms` bumps the
 * addressed artifact's `validationCount`, a `contradicts` bumps its
 * `refutationCount` and replaces the statement and confidence it carries,
 * and a `new` candidate is added through {@link addArtifact}'s
 * merge-by-meaning path — so a candidate the model called new that
 * coincides with an artifact outside the list it was shown folds into that
 * artifact rather than accumulating beside it.
 *
 * A decision naming an artifact the record no longer holds is skipped, not
 * refused: the target was resolved against an earlier read, and a prune can
 * land in between.
 *
 * The batch is one write: it stages or applies as a unit and stamps one
 * lessons family stamp, matching the one-item-per-call shape this path
 * replaces. A batch that changed nothing — an empty one, or one whose only
 * decisions named artifacts the record no longer holds — stamps no family,
 * exactly as {@link addArtifact} does when its add stores nothing; the
 * provenance of the call that found nothing is still recorded.
 * @param id - scope identity.
 * @param decisions - the confirmed, contradicted, and new facts, in the
 * order the extraction reported them.
 * @param extraction - provenance of the call that produced the batch.
 * @returns the stored record.
 */
async applyExtractionDecisions( id: EvolutionScopeId, decisions: readonly LessonDecision[], extraction?: EvolutionExtraction, ): Promise<EvolutionMemoryRecord>

/**
 * Replace the whole lessons document from a candidate list: the
 * document-level counterpart to {@link addArtifact}, {@link updateArtifact},
 * and {@link removeArtifact}, not a compatibility shim. A caller replaces
 * the whole list by hand this way; the controller's `setLessons` Remote op
 * is its one caller. Every candidate is validated and given a fresh
 * identity, counters, and instants, so a candidate list that repeats an
 * identity is refused.
 * @param id - scope identity.
 * @param candidates - the whole lessons document, one candidate per fact.
 * @param extraction - provenance when model-written.
 * @returns the stored record.
 */
async replaceArtifacts( id: EvolutionScopeId, candidates: readonly LessonArtifactInput[], extraction?: EvolutionExtraction, ): Promise<EvolutionMemoryRecord>

/**
 * Apply decay to one scope's artifacts: drop every artifact `prunable`
 * condemns by ttl or refutation floor and leave the rest untouched. A sweep
 * that finds nothing to drop reaches no write at all, so it moves neither
 * `updatedAt` nor the lessons family stamp; a sweep that drops something
 * stamps the lessons family like any other lessons write.
 *
 * `refined` is always 0. The extraction protocol folds decisions into the
 * artifacts it reads rather than refining them, so nothing yet splits the
 * coarse artifact `wrapLegacyLessons` admits from a legacy lessons
 * document; until a pass does that, the coarse artifact is a correct,
 * permanent fallback and this sweep never calls an extractor.
 * @param scopeId - scope identity.
 * @param now - ISO-8601 instant to judge decay at and stamp the write with,
 * defaulting to the wall clock.
 * @returns what the sweep changed.
 */
async sweep(scopeId: EvolutionScopeId, now: string = new Date().toISOString()): Promise<SweepResult>

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
 * capacity; `memoryUpdatedAt` stays untouched until approval. The payload
 * is a durable record field, so it is validated as a JSON value here: a
 * non-JSON payload is refused loudly and nothing is stored.
 *
 * A non-empty `mergeKey` dedupes while pending: re-staging the same key in
 * the same scope bumps the pending entry's `recurrence` instead of
 * appending a duplicate, so a repeatedly proposed candidate is remembered,
 * not silently retried.
 * @param input - scope, kind, op, payload, origin session, gist, and merge key.
 * @returns the staged entry, or the bumped pending entry on a repeated key.
 */
async stageWrite(input: StagedWriteInput): Promise<StagedWrite>

/**
 * Approve one staged write. Memory-kind entries apply their op first, so a
 * cap or substring rejection keeps the entry staged and propagates; the
 * entry drops only after the op lands. Skill-kind entries only drop: the
 * approver reads the payload from the scope record and performs the skill
 * write before approving. A `create` proposal is additionally admitted on
 * its capture contract — a capability claim needs independent validation
 * evidence — so without one the entry stays staged with its `blockedReason`
 * and `neededEvidence` set and the block propagates, like a cap rejection.
 * A `patch` revises a capability that was already admitted: its evidence is
 * the baseline-versus-candidate measurement its proposer recorded, which
 * this store has no way to read, so it drops on the human's approval.
 * Either decision is recorded in the scope's resolution log, newest first.
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
 * Mark one pending staged write as blocked, keeping it pending. A blocked
 * entry remembers why approval cannot proceed and what evidence would
 * unblock it, so the same proposal is not silently retried. Re-blocking
 * overwrites the previous reason; approving or rejecting clears it by
 * removing the entry.
 * @param id - staged entry identity.
 * @param reason - short block code, e.g. `capture-contract`.
 * @param neededEvidence - evidence that would unblock approval.
 */
async blockStaged(id: string, reason: string, neededEvidence: readonly string[]): Promise<void>

/**
 * Attach a capture contract to one pending skill proposal. The contract
 * must be fully valid to land; a rejected supply leaves the entry
 * untouched. A valid supply lifts the block, but the entry still needs an
 * explicit approval.
 * @param id - staged entry identity.
 * @param contract - the admission evidence to attach.
 */
async supplyStagedContract(id: string, contract: unknown): Promise<void>

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
 * Rebuild the scope's lessons from its chat history, read through the
 * asynchronous session query seam: ranked recall selects candidate events
 * first, and each one still passes the shared admission rule.
 *
 * A rebuild folds its findings into the artifacts already stored — the same
 * relevance-bounded decision protocol a live turn uses, run against the whole
 * selected history instead of one turn's buffer — so it confirms and corrects
 * what it finds rather than wiping what is there. Rebuilds write directly
 * even when background approval staging is on: the caller explicitly asked
 * for them.
 * @param scopeId - scope identity.
 * @param signal - caller cancellation.
 * @returns resolution after the store write.
 */
async rebuild(scopeId: EvolutionScopeId, signal: AbortSignal): Promise<void>
```

Source: [`packages/evolution/evolution-reviewer/src/index.ts`](../../packages/evolution/evolution-reviewer/src/index.ts)

<a id="ctxevolutionscorer--evolutionscorer"></a>

### `ctx.evolutionScorer` — `EvolutionScorer`

Recorded-session scorer. One score runs the scenario in `attempts` fresh processes, measures each attempt's harvested sessions through `ctx.tokenMeter`, and reduces the attempts to the metric triple. Nothing is written: the runner's replay fixtures and the expected workspace are read-only inputs.

```ts cordis-catalog
/**
 * Score one scenario against its recorded fixtures.
 *
 * Every attempt boots a fresh process through the caller's runner in the
 * keyless replay tier, and is scored against `workspace.expected/` when the
 * scenario ships one, or against its own initial workspace otherwise.
 * @param request - scenario name plus the agent composition and runner to boot it with.
 * @returns the metric triple, or the reason the scenario could not be scored.
 * @throws when the configured corpus does not exist, a shipped fixture cannot be parsed,
 * or the runner fails; only an unknown scenario and an absent fixture are skips.
 */
async score(request: ScoreRequest): Promise<ScoreOutcome>

/**
 * Evaluate one skill over its corpus scenarios and aggregate the metric
 * triple an optimizer selects on. Every scenario must score: a skipped
 * scenario means the corpus does not describe what the skill was asked to
 * prove, and optimizing on a partial evaluation would select on evidence
 * that is not there — so one skip skips the whole evaluation with its
 * reason attached.
 * @param request - skill name plus the scenarios, agent composition, and runner to score it with.
 * @returns the aggregated triple with per-scenario records, or the reason the skill could not be evaluated.
 */
async evaluateSkill(request: EvaluateSkillRequest): Promise<SkillEvaluation>

/**
 * Evaluate one skill revision through the three behavior gates: the
 * frontmatter contract check, positive/negative trigger-query routing
 * through the real selector, and a baseline-vs-candidate replay over the
 * same scenarios. The cheap gates run first, so a candidate that cannot be
 * committed or routes where it must not never spends fresh processes; only
 * replay evidence approves. A skipped replay composition skips the whole
 * evaluation with its reason attached.
  * @param request - baseline and candidate replay compositions, the candidate
  * body, the routing catalog and queries, and the routing window.
  * @returns the gate verdicts with channel disagreement and approval, the gating reason, or the skip.
 */
async evaluateBehavior(request: BehaviorEvalRequest): Promise<BehaviorEvaluation>
```

Source: [`packages/evolution/evolution-scorer/src/index.ts`](../../packages/evolution/evolution-scorer/src/index.ts)

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
 * @param sessionId - loading session, recorded so a later pass can pull the
 *   failures observed while this skill was in play. Omitted by callers with
 *   no session, which leaves the recorded list untouched.
 * @returns the stored record, or undefined for excluded sources.
 */
async markUsed(name: string, source?: string, sessionId?: string): Promise<SkillUsageRecord | undefined>

/**
 * Count one failed `skill`-tool load. Successful loads arrive through
 * {@link markUsed}; this is the failure half, called by the same
 * `tools/post-execute` observer. Exclusion matches {@link markUsed}.
 * @param name - skill name.
 * @param source - catalog source when the caller already resolved it.
 * @returns the stored record, or undefined for excluded sources.
 */
async markFailed(name: string, source?: string): Promise<SkillUsageRecord | undefined>

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
 * Record model authorship of a skill body. The model wrote this skill
 * through `skill_manage`, so its standing is provisional until evidence or
 * `/curator adopt` vouches for it. Resolves without writing when the record
 * already carries both facts.
 * @param name - skill name.
 * @returns the stored record.
 */
async markAgentCreated(name: string): Promise<SkillUsageRecord>

/**
 * Adopt one model-authored skill into user-directed standing. Only records
 * carrying model authorship move; everything else rejects, and clocks never
 * reset.
 * @param name - skill name.
 * @returns the stored record with user-directed provenance.
 */
async markAdopted(name: string): Promise<SkillUsageRecord>

/**
 * Record one trust observation for a skill. A failure with attribution
 * demotes the skill and restamps the anchor; a success counts only when its
 * session is newer than that anchor and has not been counted yet, so
 * evidence gathered before a fix cannot promote the skill again. Excluded
 * sources resolve to no record, and an observation that changes nothing
 * writes nothing.
 * @param name - skill name.
 * @param outcome - the observed outcome.
 * @param sessionId - the session that loaded this skill.
 * @param failure - attribution evidence, used only for `'failure'`.
 * @returns the stored record, or undefined for excluded sources.
 */
async recordTrustObservation( name: string, outcome: 'success' | 'failure', sessionId: string, failure?: SkillTrustFailure, ): Promise<SkillUsageRecord | undefined>

/**
 * Record a new revision of the SKILL.md body. The store hashes the content
 * itself, so one place defines the shape of `contentSha`; the same bytes
 * again is a no-op, and a real change resets trust like any other edit.
 * @param name - skill name.
 * @param content - the exact bytes just written to SKILL.md.
 * @returns the stored record, or undefined for excluded sources.
 */
async markRevised(name: string, content: string): Promise<SkillUsageRecord | undefined>

/**
 * Forget one skill's record entirely. Purge calls this after removing the
 * skill directory; absent names resolve without writing.
 * @param name - skill name.
 * @returns whether a record was removed.
 */
async drop(name: string): Promise<boolean>

/**
 * Record the cost row of a consolidation-scale run before its fan-out
 * begins, so the curator and command surfaces read one frozen shape of
 * planned spend instead of quoting ad-hoc numbers. Only the latest row is
 * kept; a run that never fans out leaves the previous row untouched.
 * @param row - planned cost facts of the upcoming run.
 */
recordConsolidationCost(row: ConsolidationCostRow): void

/**
 * Read the cost row recorded for the most recent consolidation-scale run.
 * @returns a detached copy of the row, or undefined when no run was recorded.
 */
readConsolidationCost(): ConsolidationCostRow | undefined

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

<a id="ctxevolutiontrajectory--evolutiontrajectoryexporter"></a>

### `ctx.evolutionTrajectory` — `EvolutionTrajectoryExporter`

Host-side ShareGPT exporter over session persistence and the Workspace roster.

```ts cordis-catalog
/**
 * Shape one Session's committed events into ShareGPT conversations. Pure: it
 * reads no service and writes nothing.
 * @param input - the Session identity and its committed events.
 * @returns conversations in turn order, empty when no turn produced a message.
 */
toShareGpt(input: ShareGptInput): ShareGptConversation[]

/**
 * Write one Session's conversations as a ShareGPT JSON file: one file per
 * call, an empty array when the Session produced no admitted message.
 * @param sessionId - stored or live Session to export.
 * @param options - destination file override.
 * @returns the written path, its conversation count, and its UTF-8 byte size.
 * @throws RemoteError with `session/not-found` when storage holds no such Session.
 */
@Remote async exportSession(sessionId: string, options?: TrajectoryExportOptions): Promise<TrajectoryExportResult>

/**
 * Write one file per non-archived Session of a Workspace scope. Archived
 * sessions are skipped, and a roster entry whose log is gone is skipped with
 * a warning rather than voiding the export.
 * @param scopeId - opaque scope identity naming the Workspace.
 * @param options - destination directory override.
 * @returns the written directory, the summed conversation count, and the summed UTF-8 byte size.
 * @throws RemoteError with `workspace/not-found` when the scope names no registered Workspace.
 */
@Remote async exportScope(scopeId: string, options?: TrajectoryExportOptions): Promise<TrajectoryExportResult>
```

Source: [`packages/evolution/evolution-trajectory/src/index.ts`](../../packages/evolution/evolution-trajectory/src/index.ts)
<!-- END GENERATED cordis-surface -->
