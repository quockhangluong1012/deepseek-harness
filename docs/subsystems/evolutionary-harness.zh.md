# 演进式 Harness

[English](evolutionary-harness.md) | 中文

演进式 Harness 中的作用域是 profile 加 workspace（或 profile 全局记录）的持久化记录：用户编写的指令、模型维护的经验与用户画像、附加上下文、产出文件索引，以及等待审批的暂存写入（`ctx.evolutionMemory`，`packages/evolution/evolution-memory`）。Harness 在后台从用户行为中学习，整理有界记忆，并在使用中改进技能；每一次习得性写入都有上限，可按配置暂存，有日志，可回滚。

来源：[`specs/evolutionary-harness.spec.md`](../../specs/evolutionary-harness.spec.md)

## 组成部分

| 部分 | 编写者 | 是否进入模型 | 是否计入容量 |
|---|---|---|---|
| **指令** | 用户 | 是 | 是 |
| **经验** | 模型根据本作用域的回合提炼；用户可编辑 | 是 | 是 |
| **用户画像** | 模型根据本作用域的回合提炼；用户可编辑 | 是 | 是 |
| **上下文** | 用户，以附加文件或粘贴文本形式 | 是 | 是 |
| **产出** | 从成功的变更类工具调用派生 | 否——导航索引 | 否 |
| **暂存** | 由后台评审提议，批准后应用 | 否——批准前悬置 | 否 |

## 软件包

| 软件包 | 职责 | ctx key |
|---|---|---|
| [`evolution-memory`](../../packages/evolution/evolution-memory/README.zh.md) | 按作用域持久化的记录、经验/画像写入、暂存写入与容量核算 | `ctx.evolutionMemory` |
| [`evolution-reviewer`](../../packages/evolution/evolution-reviewer/README.zh.md) | 回合缓冲、产出索引、受门控的提取与按需重建 | `ctx.evolutionReviewer` |
| [`evolution-memory-context`](../../packages/context/evolution-memory-context/README.zh.md) | 渲染简报并拼接入 `agent/pre-step`，另加作用域提示 | — |
| [`evolution-skill-telemetry`](../../packages/skill/evolution-skill-telemetry/README.zh.md) | 持久化的按技能使用/查看/补丁计数，带来源、置顶与生命周期状态 | `ctx.evolutionSkillTelemetry` |
| [`evolution-skill-manage`](../../packages/skill/evolution-skill-manage/README.zh.md) | 面向模型的 `skill_manage` 工具，以文件形式创建、补丁、重写、写入、删除技能 | 注册到 `ctx.tools` |
| [`evolution-curator`](../../packages/evolution/evolution-curator/README.zh.md) | 闲置触发的自动技能生命周期流转，带试运行预览 | `ctx.evolutionCurator` |

作用域标识是以 `EvolutionScopeId` 构造的不透明 `profile:workspaceId`（或 `profile:global`）键。经验编辑接受一个期望恰好出现一次的子串：未知子串以 `evolution/item-not-found` 拒绝，歧义子串以 `evolution/ambiguous-match` 拒绝。存储位于本机 `$DSH_HOME` 之下；不向项目目录内写入任何内容。

## 生成的 API

下方的 [Cordis API](#cordis-surface) 分节拥有上述软件包详尽的服务、事件与 Remote 列表。生成的[配置目录](../config-catalog.zh.md)拥有每个可接受配置字段。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
```

Source: [`packages/evolution/evolution-curator/src/index.ts`](../../packages/evolution/evolution-curator/src/index.ts)

<a id="ctxevolutioncuratorstatus--evolutioncuratorstatuscontroller"></a>

### `ctx.evolutionCuratorStatus` — `EvolutionCuratorStatusController`

Host Remote face over the mounted curator's ledger summary.

```ts cordis-catalog
/**
 * Read the curator's recorded status. An unmounted curator is reported as
 * such — never as a pass that never ran.
 * @returns the mounted flag, newest pass instant, and recorded passes.
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
```

Source: [`packages/evolution/evolution-feedback/src/index.ts`](../../packages/evolution/evolution-feedback/src/index.ts)

<a id="ctxevolutiongraph--evolutiongraph"></a>

### `ctx.evolutionGraph` — `EvolutionGraph`

Durable per-scope knowledge graph. Opens the `evolution_graph` domain at init and closes it through `ctx.effect`.

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
 * Replace the whole lessons document from a candidate list: the
 * document-level counterpart to {@link addArtifact}, {@link updateArtifact},
 * and {@link removeArtifact}, not a compatibility shim. The markdown
 * extraction pipeline rewrites a scope's lessons as one document and uses
 * this until it emits per-candidate ops. Every candidate is validated and
 * given a fresh identity, counters, and instants, so a candidate list that
 * repeats an identity is refused.
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
 * `refined` is always 0. Refining the coarse artifact `wrapLegacyLessons`
 * admits from a legacy lessons document needs the structured extraction
 * call that belongs to Phase 2; until then the coarse artifact is a correct,
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
 * @param input - scope, kind, op, payload, origin session, and gist.
 * @returns the staged entry.
 */
async stageWrite(input: StagedWriteInput): Promise<StagedWrite>

/**
 * Approve one staged write. Memory-kind entries apply their op first, so a
 * cap or substring rejection keeps the entry staged and propagates; the
 * entry drops only after the op lands. Skill-kind entries only drop: the
 * approver reads the payload from the scope record and performs the skill
 * write before approving. Either decision is recorded in the scope's
 * resolution log, newest first.
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
 * the asynchronous session query seam: ranked recall selects candidate
 * events first, and each one still passes the shared admission rule.
 * Rebuilds write directly even when background approval staging is on: the
 * caller explicitly asked for them.
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
 * @param sessionId - loading session, recorded so a later pass can pull the
 *   failures observed while this skill was in play. Omitted by callers with
 *   no session, which leaves the recorded list untouched.
 * @returns the stored record, or undefined for excluded sources.
 */
async markUsed(name: string, source?: string, sessionId?: string): Promise<SkillUsageRecord | undefined>

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
