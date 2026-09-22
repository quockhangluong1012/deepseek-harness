# 演进式 Harness

[English](evolutionary-harness.md) | 中文

演进式 Harness 中的作用域是 profile 加 workspace（或 profile 全局记录）的持久化记录：用户编写的指令、模型维护的经验与用户画像、附加上下文、产出文件索引，以及等待审批的暂存写入（`ctx.evolutionMemory`，`packages/evolution/evolution-memory`）。Harness 在后台从用户行为中学习，整理有界记忆，并在使用中改进技能；每一次习得性写入都有上限，可按配置暂存，有日志，可回滚。

来源：[`specs/evolutionary-harness-v11-deep-research.md`](../../specs/evolutionary-harness-v11-deep-research.md)

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

[evolution 组地图](../../packages/evolution/README.zh.md#packages)拥有完整的软件包列表——每个包的职责与 `ctx` key——下方生成的 [Cordis API](#cordis-surface) 拥有它们的服务、事件与 Remote 面。本参考文档不再自带软件包列表，以免两者相互漂移。

作用域标识是以 `EvolutionScopeId` 构造的不透明 `profile:workspaceId`（或 `profile:global`）键。经验是按身份（即规范化后的 statement）寻址的工件，因此一次编辑命名它所改动的工件，而不是拼接一份文档。存储位于本机 `$DSH_HOME` 之下；不向项目目录内写入任何内容。

## 生成的 API

下方的 [Cordis API](#cordis-surface) 分节拥有上述软件包详尽的服务、事件与 Remote 列表。生成的[配置目录](../config-catalog.zh.md)拥有每个可接受配置字段。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxevolutionadversary--evolutionadversary"></a>

### `ctx.evolutionAdversary` — `EvolutionAdversary`

Adversary store over durable probes and defense rows. Opens the `evolution_adversary` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one adversarial probe, unrepaired: repair is a separate explicit
 * step so a recorded weakness is never silently marked fixed.
 * @param input - the probe to record.
 * @returns the stored probe.
 */
async probe(input: ProbeInput): Promise<AdversarialProbe>

/**
 * Mark one probe repaired — or unrepaired again when a fix regresses.
 * @param probeId - the probe to update.
 * @param repaired - the repaired flag to set.
 * @returns the updated probe.
 */
async setRepaired(probeId: string, repaired: boolean = true): Promise<AdversarialProbe>

/**
 * List every probe, optionally filtered by skill, newest first.
 * @param skill - optional skill filter.
 * @returns the probes, detached from the store.
 */
probes(skill?: string): readonly AdversarialProbe[]

/**
 * The next probing challenge of one skill under the configured probe
 * minimum: the first uncovered category, or the least-probed category once
 * every category is covered.
 * @param skill - the skill to challenge.
 * @returns the challenge naming the next category.
 */
challenge(skill: string): Challenge

/**
 * Set one gaming defense on the checklist.
 * @param defense - the defense to set.
 * @param satisfied - whether the defense is satisfied.
 * @returns the checklist status.
 */
async setDefense(defense: GamingDefense, satisfied: boolean): Promise<DefenseStatus>

/**
 * The full defense checklist in canonical order; a defense never set reads
 * unsatisfied with a null instant.
 * @returns the checklist, detached from the store.
 */
defenses(): readonly DefenseStatus[]

/**
 * The defenses still open, in canonical order.
 * @returns the open defenses.
 */
defenseGaps(): GamingDefense[]

/**
 * The §46 checklist as the recorded stores show it, rather than as an
 * operator set it: each defense reads `observed-satisfied`, `observed-open`,
 * or `unobserved` from the evaluator-strategy, benchmark, and router stores
 * plus this store's own probes. A defense no store answers from is
 * `unobserved`, never reported open on nobody's evidence. Read-only: this
 * neither writes to those stores nor starts a run (§58.12).
 * @returns the observations, in canonical order.
 */
observedDefenses(): readonly DefenseObservation[]
```

Source: [`packages/evolution/evolution-adversary/src/index.ts`](../../packages/evolution/evolution-adversary/src/index.ts)

<a id="ctxevolutionbenchmark--evolutionbenchmark"></a>

### `ctx.evolutionBenchmark` — `EvolutionBenchmark`

Benchmark store over durable tasks. Opens the `evolution_benchmark` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Admit candidate tasks, deduplicating against every still-learnable task.
 * Contaminated and retired tasks do not block re-admission. The admission
 * pass stages at most `maxAdmit` new tasks.
 * @param inputs - candidate tasks, in caller order.
 * @returns the admitted tasks and the duplicate texts.
 */
async admit(inputs: readonly BenchmarkInput[]): Promise<{ admitted: readonly BenchmarkTask[]; duplicates: string[] }>

/**
 * List every task, optionally filtered by state, learnable states first in
 * pipeline order then newest first.
 * @param state - optional state filter.
 * @returns the tasks, detached from the store.
 */
tasks(state?: BenchmarkState): readonly BenchmarkTask[]

/**
 * Move one task to another state. Learning advances one step per call
 * (fresh → search → validation → holdout), any learnable state may derail to
 * `contaminated` or `retired`, a same-state call resolves without writing,
 * and terminal states never leave. Unknown ids and illegal transitions
 * reject loudly.
 * @param id - task identity.
 * @param to - requested state.
 * @returns the stored task after the transition.
 */
async transition(id: string, to: BenchmarkState): Promise<BenchmarkTask>
```

Source: [`packages/evolution/evolution-benchmark/src/index.ts`](../../packages/evolution/evolution-benchmark/src/index.ts)

<a id="ctxevolutionbudget--evolutionbudget"></a>

### `ctx.evolutionBudget` — `EvolutionBudget`

Evolution-budget store over durable allocations, spends, and candidate pools. Opens the `evolution_budget` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record a budget allocation for one batch, pricing its candidate class
 * against the base ceilings, including §37's cost, deadline, and parallelism
 * dimensions, and upserting by batch identity. The stored instant is now.
 * @param input - the batch, its task class, and its candidate class.
 * @returns the stored allocation.
 */
async allocate(input: AllocationInput): Promise<BudgetAllocation>

/**
 * Record a budget allocation for one candidate a batch's pool already holds,
 * pricing the class the §37 policy decides from its recorded evidence and
 * naming that branch in the allocation's reason.
 * @param batchId - the batch whose pool holds the candidate.
 * @param candidateId - the pooled candidate to price.
 * @returns the stored allocation.
 */
async allocateForCandidate(batchId: string, candidateId: string): Promise<BudgetAllocation>

/**
 * Record one spend of a batch and settle it against the allocation across
 * every recorded spend of the batch. The allocation must exist: a spend
 * without a priced batch is a surprise, not budget use.
 * @param batchId - the batch spending.
 * @param input - the spend to record.
 * @returns the cumulative settlement of the batch.
 */
async spend(batchId: string, input: SpendInput): Promise<BudgetSettlement>

/**
 * Record the candidates one batch screens, upserting each by candidate
 * identity so a re-recorded candidate replaces its evidence and leaves its
 * siblings alone. The stored instant is now.
 * @param input - the batch and the candidates entering its pool.
 * @returns the batch's pool, in candidate-id order.
 */
async recordPool(input: PoolInput): Promise<readonly PooledCandidate[]>

/**
 * List a batch's recorded candidate pool in candidate-id order.
 * @param batchId - the batch whose pool to list.
 * @returns the pool, detached from the store.
 */
pool(batchId: string): readonly PooledCandidate[]

/**
 * The successive-halving screening schedule the batch's recorded pool
 * implies (§38): how many candidates each round evaluates and keeps.
 * @param batchId - the batch whose schedule to derive.
 * @returns the schedule, or undefined when the batch recorded no pool.
 */
schedule(batchId: string): HalvingSchedule | undefined

/**
 * Read every §27 resource-aware objective the batch's records answer.
 * @param batchId - the batch to read.
 * @returns the readings, canonical order.
 */
objectives(batchId: string): readonly ObjectiveReading[]

/**
 * List recorded allocations, optionally filtered by task class, in
 * batch-id order.
 * @param taskClass - optional task-class filter.
 * @returns the allocations, detached from the store.
 */
batches(taskClass?: BudgetTaskClass): readonly BudgetAllocation[]

/**
 * List spend records, optionally filtered by batch, newest first with
 * record-key ascending tie-break.
 * @param batchId - optional batch filter.
 * @returns the spend records, detached from the store.
 */
spends(batchId?: string): readonly SpendRecord[]

/**
 * Whether a batch's cumulative recorded spend stays inside its allocation.
 * @param batchId - the batch to check.
 * @returns true when every measured ceiling holds.
 */
withinBudget(batchId: string): boolean
```

Source: [`packages/evolution/evolution-budget/src/index.ts`](../../packages/evolution/evolution-budget/src/index.ts)

<a id="ctxevolutioncanary--evolutioncanary"></a>

### `ctx.evolutionCanary` — `EvolutionCanary`

Canary deployment store over durable rollout records. Opens the `evolution_canary` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one deployment entering shadow. Each staged write starts exactly
 * one deployment, so an existing id rejects loudly instead of silently
 * re-entering shadow.
 * @param input - the deployment to record.
 * @returns the stored record.
 */
async enter(input: DeploymentInput): Promise<DeploymentRecord>

/**
 * Move one deployment to another state. The ladder advances one step per
 * call, each staged rollout may exit to its terminal state, a same-state
 * call resolves without writing, and terminal states never leave. Unknown
 * ids and illegal transitions reject loudly.
 * @param id - deployment identity.
 * @param to - requested state.
 * @returns the stored record after the transition.
 */
async advance(id: string, to: DeploymentState): Promise<DeploymentRecord>

/**
 * List every deployment, optionally filtered by state and skill, newest
 * first in the ladder order then by `at`.
 * @param state - optional state filter.
 * @param skill - optional skill filter.
 * @returns the records, detached from the store.
 */
deployments(state?: DeploymentState, skill?: string): readonly DeploymentRecord[]

/**
 * Summarize deployments, optionally for one skill: the total and per-state
 * counts with every state present, so absent states read as zero.
 * @param skill - optional skill filter; omitted summarizes the whole store.
 * @returns the summary.
 */
summary(skill?: string): DeploymentSummary
```

Source: [`packages/evolution/evolution-canary/src/index.ts`](../../packages/evolution/evolution-canary/src/index.ts)

<a id="ctxevolutioncontroller--evolutioncontroller"></a>

### `ctx.evolutionController` — `EvolutionController`

Host Remote service over the durable evolution record. The stream is owned by the feed; reconnect generations belong to the client transport (`RemoteStream`), which opens a fresh `follow` call per generation, so this service never buffers across a transport loss.

```ts cordis-catalog
/**
 * Load one scope's record.
 * @param request - scope identity.
 * @returns the Remote projection.
 */
@Remote('read') read(request: EvolutionScopeRequest): Promise<EvolutionMemoryValue>

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
@Remote('listStaged') listStaged(request: EvolutionListStagedRequest): Promise<EvolutionStagedValue>

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
@Remote('timeline') timeline(request: EvolutionTimelineRequest): Promise<JourneyTimeline>

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

<a id="ctxevolutioncurriculum--evolutioncurriculum"></a>

### `ctx.evolutionCurriculum` — `EvolutionCurriculum`

Automatic curriculum over durable proposals. Opens the `evolution_curriculum` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Measure current capability gaps from the mounted seams: for every tracked
 * skill with sessions, the distinct failure gists of its compressed trace
 * rows. Without either seam nothing is measured.
 * @returns the measured gaps, in caller order.
 */
async gaps(): Promise<readonly CurriculumGap[]>

/**
 * Stage one task per gap that clears the evidence floor, skipping any
 * already-open proposal for the same capability and task. A capability with
 * no proposed task contributes nothing.
 * @param gaps - measured capability gaps, in caller order.
 * @returns the staged proposals.
 */
async propose(gaps: readonly CurriculumGap[]): Promise<readonly CurriculumProposal[]>

/**
 * List every staged proposal, open first then retired, each group newest
 * first.
 * @returns the proposals, detached from the store.
 */
proposals(): readonly CurriculumProposal[]

/**
 * Retire one proposal; an absent id rejects loudly, and an already-retired
 * proposal resolves without writing.
 * @param id - proposal identity.
 * @returns the stored proposal after retirement.
 */
async retire(id: string): Promise<CurriculumProposal>
```

Source: [`packages/evolution/evolution-curriculum/src/index.ts`](../../packages/evolution/evolution-curriculum/src/index.ts)

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
 * The narratives that still answer, newest first. A superseded one keeps its
 * place in the record and its evidence but answers no query, exactly as the
 * claim graph treats a retired claim, so a corrected statement replaces an
 * older one instead of editing it.
 * @param scopeId - scope identity.
 * @returns detached copies of the active promotions.
 */
promotions(scopeId: EvolutionScopeId): DreamPromotion[]

/**
 * Read one scope's promotion ledger, newest first, for audit and as the
 * source of the identities {@link rollback} takes.
 * @param scopeId - scope identity.
 * @returns detached copies of the ledger entries.
 */
ledger(scopeId: EvolutionScopeId): readonly DreamLedgerEntry[]

/**
 * Restore the promotions one ledger entry replaced. The entry holds its own
 * preimage, so nothing can go missing between the write and the rollback: an
 * unknown identity fails before anything is written, and the rollback appends
 * its own entry, which makes it as reversible as the pass it undoes.
 * @param scopeId - scope identity.
 * @param entryId - ledger entry identity, from {@link ledger}.
 * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
 * @returns what the rollback restored and the entry that recorded it.
 */
async rollback( scopeId: EvolutionScopeId, entryId: string, now: string = new Date().toISOString(), ): Promise<DreamRollbackReport>

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

<a id="ctxevolutionevaluatorhealth--evolutionevaluatorhealth"></a>

### `ctx.evolutionEvaluatorHealth` — `EvolutionEvaluatorHealth`

Evaluator ensemble health over durable verdicts. Opens the `evolution_evaluator_health` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one behavior-evaluation verdict. A skipped evaluation has no
 * judgment and rejects loudly.
 * @param input - the verdict to record.
 * @returns the stored run.
 */
async observe(input: EvaluatorRunInput): Promise<EvaluatorRun>

/**
 * List recorded verdicts, newest first, optionally for one skill.
 * @param skill - optional skill filter.
 * @returns the runs, detached from the store.
 */
runs(skill?: string): readonly EvaluatorRun[]

/**
 * Summarize evaluator health over every recorded verdict.
 * @returns the aggregated health facts.
 */
summary(): EvaluatorHealthSummary

/**
 * Record the later ground truth that judged one verdict (§13): whether it
 * agreed with the evaluator, and whether it was measured independently. An
 * unknown verdict identity rejects loudly, so a ground truth is never
 * attached to a verdict that does not exist.
 * @param runId - the recorded verdict being judged.
 * @param judgment - the ground truth's reading.
 * @returns the updated verdict.
 */
async judge(runId: string, judgment: RunJudgmentInput): Promise<EvaluatorRun>

/**
 * The calibration facts of the recorded verdicts (§13): the false-negative
 * rate beside the summary's false-positive rate, and how the evaluator
 * correlates with the independent ground truths that later judged it.
 * @returns the calibration facts.
 */
calibration(): JudgeCalibration
```

Source: [`packages/evolution/evolution-evaluator-health/src/index.ts`](../../packages/evolution/evolution-evaluator-health/src/index.ts)

<a id="ctxevolutionevaluatorstrategy--evolutionevaluatorstrategy"></a>

### `ctx.evolutionEvaluatorStrategy` — `EvolutionEvaluatorStrategy`

Evaluator-strategy store over durable statistics rows. Opens the `evolution_evaluator_strategy` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one verdict/ground-truth pair, upserting the evaluator's
 * statistics for its task class. The stored instant is now.
 * @param outcome - the verdict and the ground truth it is judged against.
 * @returns the updated statistics.
 */
async observe(outcome: EvaluatorOutcome): Promise<EvaluatorStrategy>

/**
 * List every recorded statistics row, optionally filtered by task class, in
 * evaluator order then task-class order.
 * @param taskClass - optional task-class filter.
 * @returns the rows, detached from the store.
 */
strategies(taskClass?: TaskClass): readonly EvaluatorStrategy[]

/**
 * Rank one task class's evaluators by their smoothed corroboration weight,
 * each entry naming the route §28 assigns to the final promotion review — the
 * strongest configured verifier — so the recommendation says which model
 * should re-check what it recommends.
 * @param taskClass - the task class to rank evaluators for.
 * @returns the ranked evaluators, most trustworthy first.
 */
ranking(taskClass: TaskClass): readonly StrategyRanking[]

/**
 * The evaluator to trust for one task class: the best-ranked evaluator with
 * at least `minimumSamples` independent samples, or undefined while no
 * evaluator has that much independent evidence. The entry names the route
 * §28 puts on the final promotion review, so the caller knows which model
 * should check the verdict before it is acted on. Naming it routes nothing:
 * no run is started from a recommendation (§58.12).
 * @param taskClass - the task class to recommend for.
 * @returns the recommended evaluator, or undefined.
 */
recommend(taskClass: TaskClass): StrategyRanking | undefined
```

Source: [`packages/evolution/evolution-evaluator-strategy/src/index.ts`](../../packages/evolution/evolution-evaluator-strategy/src/index.ts)

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
 * observed behavior, confidence) merged with the analytic half (root cause,
 * corrected strategy, and friends) when one is stored. Analytic fields stay
 * null until something states them, so a reader never mistakes missing
 * analysis for measured fact.
 * @param sessionIds - sessions to aggregate, in caller order.
 * @param limit - maximum reflections returned.
 * @returns the structured reflections, decisive first.
 */
reflect(sessionIds: readonly string[], limit: number): StructuredReflection[]

/**
 * Author and store one deterministic reflection per graded `trigger_review`
 * signal that has none, sweeping the store's own sessions newest-write first.
 * A signal that already has a stored reflection is left alone, so a second
 * pass over unchanged evidence writes nothing. No model is called: every
 * authored field is a template over the observed failure identity and its
 * recurrence, which is why `rootCause` and `whatWorked` stay null.
 * @param limit - maximum reflections this pass authors.
 * @param now - ISO-8601 instant stamped on every reflection this pass writes.
 * @returns the reflections written, decisive first.
 */
async reflectSignals(limit: number, now: string): Promise<readonly StructuredReflection[]>

/**
 * Stored reflections whose failure was reported by one of `sessionIds`,
 * newest write first: the retrieval half of the failure → explanation →
 * corrective heuristic association (§4.1). A stored reflection whose failure
 * none of the given sessions reported is not one of theirs and stays out.
 * @param sessionIds - sessions to read, in caller order.
 * @param limit - maximum reflections returned.
 * @returns the stored reflections, newest first.
 */
async reflections(sessionIds: readonly string[], limit: number): Promise<readonly StructuredReflection[]>

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
 * Record assertions about the scope's claims. Each assertion creates the
 * claim the scope does not hold yet or merges into the one it does, adding
 * evidence, lineage edges, and observed traces; a `supersedes` marks the
 * claims it names `retired` so they stop answering {@link claims}.
 *
 * An assertion whose statement is blank once normalized is dropped and
 * counted, and so is a new claim once the scope holds `maxClaims` of them:
 * a saturated scope keeps answering from the claims it has instead of
 * failing its caller.
 * @param scopeId - scope identity.
 * @param assertions - claims to record, in input order.
 * @param now - ISO-8601 instant to stamp, defaulting to the wall clock.
 * @returns what the batch added, updated, retired, and dropped.
 */
async recordClaims( scopeId: EvolutionScopeId, assertions: readonly ClaimAssertion[], now: string = new Date().toISOString(), ): Promise<ClaimObserveResult>

/**
 * Answer one claim query: the active claims whose statement contains the
 * query, most believed first. A retired claim is never among them — it no
 * longer answers anything — and is reachable only by identity through
 * {@link claim}, which reports what retired it.
 * @param scopeId - scope identity.
 * @param query - case-insensitive statement substring; empty matches every active claim.
 * @param limit - maximum claims returned, capped by `maxQueryLimit`.
 * @returns the matching claims, best-supported first.
 */
claims( scopeId: EvolutionScopeId, query: string = '', limit: number = this.resolved.maxQueryLimit, ): Claim[]

/**
 * Read one claim by identity, retired or active, so a caller can tell a
 * claim that still stands from one a later claim replaced.
 * @param scopeId - scope identity.
 * @param statement - the claim's statement or its normalized identity.
 * @returns the claim, or undefined when the scope holds none under that identity.
 */
claim(scopeId: EvolutionScopeId, statement: string): Claim | undefined

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

<a id="ctxevolutionislands--evolutionislands"></a>

### `ctx.evolutionIslands` — `EvolutionIslands`

Island store over durable islands and migrations. Opens the `evolution_islands` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Register one island for a skill's evolution job. A duplicate island id
 * rejects loudly: an island is a durable lane, not a replaceable row.
 * @param input - the island to register.
 * @returns the stored island.
 */
async register(input: IslandInput): Promise<Island>

/**
 * Record one generation tick for a skill's evolution job: the head island
 * of the skill — the newest registered — advances its generation and
 * last-activity instant. Returns `undefined` when the skill has no island
 * yet, so the optimizer seam stays a no-op until an operator registers one.
 * @param skill - the skill whose job advances.
 * @returns the advanced island, or undefined without one.
 */
async advance(skill: string): Promise<Island | undefined>

/**
 * Record one migration between two islands. Both islands must exist, and
 * they must serve the same skill — a candidate migrating across jobs is
 * meaningless. The migration is keyed by a fresh identity, so a candidate
 * may migrate repeatedly and every move stays on record.
 * @param input - the migration to record.
 * @returns the stored migration.
 */
async migrate(input: MigrationInput): Promise<Migration>

/**
 * List every island, optionally filtered by skill, newest registration
 * first.
 * @param skill - optional skill filter.
 * @returns the islands, detached from the store.
 */
islands(skill?: string): readonly Island[]

/**
 * List every migration, optionally filtered by skill, newest first.
 * @param skill - optional skill filter.
 * @returns the migrations, detached from the store.
 */
migrations(skill?: string): readonly Migration[]

/**
 * The schedule view of every island (optionally per skill): each island
 * with its last migration instant and whether a scheduled migration is due
 * under the configured cadence, ordered by island id for a stable render.
 * @param skill - optional skill filter.
 * @returns the schedule rows, detached from the store.
 */
schedule(skill?: string): readonly IslandSchedule[]
```

Source: [`packages/evolution/evolution-islands/src/index.ts`](../../packages/evolution/evolution-islands/src/index.ts)

<a id="ctxevolutionlineage--evolutionlineage"></a>

### `ctx.evolutionLineage` — `EvolutionLineage`

Dependency-aware lineage store over durable experiment envelopes. Opens the `evolution_lineage` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one experiment envelope, stamping its recording instant.
 * @param input - the experiment to record.
 * @returns the stored envelope.
 */
async record(input: ExperimentInput): Promise<ExperimentEnvelope>

/**
 * List every envelope, optionally filtered by skill, newest first.
 * @param skill - optional skill filter.
 * @returns the envelopes, detached from the store.
 */
experiments(skill?: string): readonly ExperimentEnvelope[]

/**
 * Read one envelope by identity, detached from the store.
 * @param id - the experiment identity.
 * @returns the envelope, or undefined when unknown.
 */
envelope(id: string): ExperimentEnvelope | undefined

/**
 * Compare two envelopes over the configured compared keys: comparable
 * exactly when none of those keys changed versions between them.
 * @param idA - the first experiment identity.
 * @param idB - the second experiment identity.
 * @returns the comparability verdict, or undefined when either id is unknown.
 */
compare(idA: string, idB: string): ExperimentComparison | undefined

/**
 * Replay one experiment from its record: the envelope carries the seeds
 * it ran, so the run is reproducible from what this returns (§48).
 * @param id - the experiment identity.
 * @returns the envelope, detached, or undefined when unknown.
 */
replay(id: string): ExperimentEnvelope | undefined
```

Source: [`packages/evolution/evolution-lineage/src/index.ts`](../../packages/evolution/evolution-lineage/src/index.ts)

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
 *
 * A batch applied with provenance is also published as one
 * `evolution/decisions-applied` event once the write is durable, carrying
 * the artifacts as they read before it. A batch applied without provenance
 * is not published: every decision would carry unattributable evidence.
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
 * Attach pasted text or a scope file. An item whose label carries the stored
 * `RECALL_LABEL_PREFIX` is a recall of the memory the label names, so the
 * write also appends one row to the scope's recall ledger: that is §23's
 * `retrieved` link, counted where the shipped recall path already writes.
 * @param id - scope identity.
 * @param input - label plus text or path with its observed size.
 * @returns the stored record.
 */
async addContextItem(id: EvolutionScopeId, input: EvolutionContextItemInput): Promise<EvolutionMemoryRecord>

/**
 * Every recall the profile's scopes recorded, newest first within its scope,
 * each naming the scope it landed in. §23's loop is read from here; which
 * session read a recalled item is not among the recorded links.
 * @returns one row per recorded recall.
 */
recalls(): readonly RecordedRecall[]

/**
 * Record the graded outcome of one recall: the §23 loop's `helped outcome`
 * link. The grader is whichever pass reads the outcome record — the
 * curator's idle pass is the shipped one, which grades the session the
 * recall's decision batch was extracted from off the feedback store. The
 * newest recall of that memory still awaiting an outcome is the one graded,
 * so a memory recalled again after an outcome is graded again on its newer
 * recall. A memory with no awaiting recall is refused loudly rather than
 * graded twice.
 * @param id - scope identity.
 * @param recalledId - recalled memory's identity, as its label carried it.
 * @param outcome - `ok` when the graded session's evidence was clean, else `failed`.
 * @param at - ISO-8601 instant the outcome was recorded, defaulting to the wall clock.
 * @returns the stored record.
 */
async recordRecallOutcome( id: EvolutionScopeId, recalledId: string, outcome: 'ok' | 'failed', at: string = new Date().toISOString(), ): Promise<EvolutionMemoryRecord>

/**
 * §24's utility for every memory the recall ledger holds, one reading per
 * recalled memory across the profile's scopes. Reads the same rows
 * {@link recalls} returns.
 * @returns the derived readings.
 */
recallUtility(): readonly MemoryUtility[]

/**
 * Detach one context item. The recall ledger keeps its row: the recall
 * happened, and dropping the item from the brief does not un-retrieve it.
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
 * An approved `applyDecisions` batch is published as one
 * `evolution/decisions-applied` event under the entry's origin session, on
 * the same terms {@link applyExtractionDecisions} states.
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

<a id="ctxevolutionmeta--evolutionmeta"></a>

### `ctx.evolutionMeta` — `EvolutionMeta`

Meta-evolution store over durable engine runs. Opens the `evolution_meta` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one engine run, completing its configuration with the default
 * choices where the caller named none and storing the sequence it performed
 * as given. An absent sequence records that the caller observed none — the
 * store never invents the order a run took. The stored instant is now.
 * @param input - the run, its (possibly partial) configuration, and its workflow.
 * @returns the stored run.
 */
async record(input: EngineRunInput): Promise<EngineRun>

/**
 * List recorded engine runs, optionally filtered by task class, newest
 * first with run-id ascending tie-break.
 * @param taskClass - optional task-class filter.
 * @returns the runs, detached from the store.
 */
runs(taskClass?: MetaTaskClass): readonly EngineRun[]

/**
 * The derived per-configuration summaries, optionally filtered by task
 * class, grouped by task class and best configuration first.
 * @param taskClass - optional task-class filter.
 * @returns the summaries, detached from the store.
 */
summaries(taskClass?: MetaTaskClass): readonly ConfigSummary[]

/**
 * The engine configuration to run next on one task class: the best-scored
 * configuration with at least `minimumSamples` runs, or undefined while no
 * configuration has that much evidence.
 * @param taskClass - the task class to recommend for.
 * @returns the recommended configuration, or undefined.
 */
recommend(taskClass: MetaTaskClass): ConfigRecommendation | undefined
```

Source: [`packages/evolution/evolution-meta/src/index.ts`](../../packages/evolution/evolution-meta/src/index.ts)

<a id="ctxevolutionmetrics--evolutionmetrics"></a>

### `ctx.evolutionMetrics` — `EvolutionMetrics`

Metric layer over the evolution stores. It opens no domain and holds no state, so every reading is the current state of the stores it reads; a store that is not mounted makes its metrics unmeasurable rather than absent, so one report always carries the whole §55 set.

```ts cordis-catalog
/**
 * Measure the §55 metric set over one window of recorded engine runs. The
 * north star is reported per compute denominator; every supporting metric
 * is either measured from the store that owns it or reported unmeasurable
 * with the missing record named. Reads only.
 * @param query - which runs the window covers; omitted fields take defaults.
 * @returns the window, the north star per denominator, and the supporting set.
 */
report(query: MetricsQuery = {}): MetricsReport
```

Source: [`packages/evolution/evolution-metrics/src/index.ts`](../../packages/evolution/evolution-metrics/src/index.ts)

<a id="ctxevolutionmodelroutes--evolutionmodelroutes"></a>

### `ctx.evolutionModelRoutes` — `EvolutionModelRoutes`

Adaptive model-routing store over durable assignments, evidence, and the identities that filled a run's evolutionary roles. Opens the `evolution_model_routes` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one measured outcome of a route used in a role, upserting the route
 * as `observed` unless it is already pinned (a pin outlives its evidence).
 * @param input - the role, route, and measured triple.
 * @returns the stored evidence row.
 */
async observe(input: RouteEvidenceInput): Promise<RouteEvidence>

/**
 * Pin one route for one role: the operator's explicit assignment outranks
 * every observed route in `recommend`. Pinning an existing route flips its
 * origin; pinning a fresh route creates the row.
 * @param role - the role to assign.
 * @param provider - provider half of the route.
 * @param model - model half of the route.
 * @returns the stored assignment.
 */
async pin(role: EvolutionRole, provider: string, model: string): Promise<RouteRow>

/**
 * List route assignments merged with their evidence as per-route summaries,
 * optionally for one role, in role-topology order then provider/model order.
 * @param role - optional role filter.
 * @returns the summaries, detached from the store.
 */
routes(role?: EvolutionRole): readonly RouteSummary[]

/**
 * List recorded evidence, newest first, optionally filtered by role and
 * route.
 * @param role - optional role filter.
 * @param route - optional route filter.
 * @returns the evidence rows, detached from the store.
 */
evidence(role?: EvolutionRole, route?: ModelRoute): readonly RouteEvidence[]

/**
 * Recommend the route for one role: the pinned assignment when one exists,
 * otherwise the route with the strongest recorded evidence. Yields undefined
 * when the role has neither.
 * @param role - the role to recommend for.
 * @returns the recommended route, or undefined.
 */
recommend(role: EvolutionRole): ModelRoute | undefined

/**
 * The §28 topology conflicts in the current assignment set: routes that both
 * produce work and judge it, which make the judging role's verdicts
 * non-independent by construction. Recorded, never enforced — the assignment
 * set still answers `recommend` exactly as recorded.
 * @returns the conflicts, ordered by provider then model.
 */
conflicts(): readonly RoleConflict[]

/**
 * Record the identity that filled one evolutionary role of one run, so §53's
 * separation of duties has the pair to compare. Recording a role twice for
 * one run replaces its identity: the newest fill wins.
 * @param input - the run, the role, and the identity that filled it.
 * @returns the stored duty row.
 */
async recordDuty(input: DutyInput): Promise<DutyRecord>

/**
 * List one run's recorded role fills, in role-topology order.
 * @param runId - the run to list.
 * @returns the duty rows, detached from the store.
 */
duties(runId: string): readonly DutyRecord[]

/**
 * §53's separation of duties for one decision over one run: whether the
 * judging role's recorded identity differs from the producing role's. The
 * store records what a caller filled each role with and refuses on what it
 * read, so a decision taken without recording both identities is refused as
 * unknown rather than assumed independent.
 * @param runId - the run the decision concerns.
 * @param decision - the decision being taken.
 * @returns the verdict, whose refusal names both roles.
 */
checkDuties(runId: string, decision: DutyDecision): DutyVerdict
```

Source: [`packages/evolution/evolution-model-routes/src/index.ts`](../../packages/evolution/evolution-model-routes/src/index.ts)

<a id="ctxevolutionnovelty--evolutionnovelty"></a>

### `ctx.evolutionNovelty` — `EvolutionNovelty`

Novelty-search store over the durable archive. Opens the `evolution_novelty` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one descriptor, measuring its novelty against the skill's archive
 * excluding the descriptor itself, so re-recording a candidate keeps its
 * original novelty instead of degrading to zero. One entry per staged write:
 * the archive is keyed by candidate identity.
 * @param input - the descriptor to archive.
 * @returns the stored entry with its measured novelty.
 */
async record(input: NoveltyArchiveInput): Promise<NoveltyArchiveEntry>

/**
 * List every archive entry, optionally filtered by skill, newest first.
 * @param skill - optional skill filter.
 * @returns the entries, detached from the store.
 */
entries(skill?: string): readonly NoveltyArchiveEntry[]

/**
 * Mean archive novelty of one skill, in 0..1, or zero when the skill has no
 * entries. A falling mean is the frontier-stagnation signal the command
 * plane renders.
 * @param skill - the skill to summarize.
 * @returns the skill's mean archive novelty.
 */
mean(skill: string): number
```

Source: [`packages/evolution/evolution-novelty-search/src/index.ts`](../../packages/evolution/evolution-novelty-search/src/index.ts)

<a id="ctxevolutionoperators--evolutionoperators"></a>

### `ctx.evolutionOperators` — `EvolutionOperators`

Mutation-operator store over durable statistics and instruction rows. Opens the `evolution_operators` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one measured outcome of an operator, upserting the operator's
 * statistics for its artifact class. The stored instant is now.
 * @param outcome - the operator used and its accepted/delta outcome.
 * @returns the updated statistics.
 */
async record(outcome: OperatorOutcome): Promise<OperatorStats>

/**
 * Record the instruction one operator and artifact class should send. The
 * pair holds one instruction at a time: a different text replaces the
 * previous proposal and starts its verdict tally over, while re-proposing
 * the same text keeps the verdicts it earned. The stored instant is now.
 * @param input - the operator, the artifact class, and the proposed instruction.
 * @returns the stored instruction row.
 */
async recordInstruction(input: InstructionInput): Promise<OperatorInstruction>

/**
 * Record one verdict on the instruction its operator and artifact class
 * holds. The pair must hold an instruction: a verdict on nothing would be
 * evidence for a proposal that was never made.
 * @param verdict - the verdict and why it landed that way.
 * @returns the updated instruction row.
 */
async judgeInstruction(verdict: InstructionVerdict): Promise<OperatorInstruction>

/**
 * Read the instruction one operator and artifact class holds.
 * @param operator - the operator whose instruction to read.
 * @param artifactClass - the artifact class whose instruction to read.
 * @returns the row, or undefined when the pair holds no proposal.
 */
instruction(operator: MutationOperator, artifactClass: ArtifactClass): OperatorInstruction | undefined

/**
 * List recorded instruction proposals, optionally filtered by artifact
 * class, in canonical operator order then artifact-class order.
 * @param artifactClass - optional artifact-class filter.
 * @returns the rows, detached from the store.
 */
instructions(artifactClass?: ArtifactClass): readonly OperatorInstruction[]

/**
 * The instruction to try next on one artifact class: the one the ranking's
 * top operator holds, undefined while that operator holds no proposal.
 * @param artifactClass - the artifact class to recommend for.
 * @returns the recommended instruction.
 */
recommendedInstruction(artifactClass: ArtifactClass): OperatorInstruction | undefined

/**
 * List every recorded statistics row, optionally filtered by artifact
 * class, in canonical operator order then artifact-class order.
 * @param artifactClass - optional artifact-class filter.
 * @returns the rows, detached from the store.
 */
stats(artifactClass?: ArtifactClass): readonly OperatorStats[]

/**
 * Rank every canonical operator for one artifact class by the
 * exploration-adjusted score, nudged by the instruction verdicts the class
 * recorded. Untried operators enter with their prior score, so the ranking
 * always names a next operator to try.
 * @param artifactClass - the artifact class to rank operators for.
 * @returns the ranked operators, best first.
 */
ranking(artifactClass: ArtifactClass): readonly OperatorRanking[]

/**
 * The best operator to try next on one artifact class: the ranking's top,
 * the canonical first operator when nothing is recorded for the class.
 * @param artifactClass - the artifact class to recommend for.
 * @returns the recommended operator.
 */
recommend(artifactClass: ArtifactClass): OperatorRanking | undefined
```

Source: [`packages/evolution/evolution-operators/src/index.ts`](../../packages/evolution/evolution-operators/src/index.ts)

<a id="ctxevolutionpopulation--evolutionpopulation"></a>

### `ctx.evolutionPopulation` — `EvolutionPopulation`

Population store over durable candidates. Opens the `evolution_population` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one candidate, auto-wiring lineage: the previous head of the same
 * skill becomes this candidate's parent, and the generation is one past the
 * skill's current highest. The head is the candidate with the highest
 * generation, newest tie first.
 * @param input - the candidate to record.
 * @returns the stored candidate.
 */
async record(input: PopulationRecordInput): Promise<PopulationCandidate>

/**
 * List every candidate, optionally filtered by skill, newest first.
 * @param skill - optional skill filter.
 * @returns the candidates, detached from the store.
 */
candidates(skill?: string): readonly PopulationCandidate[]

/**
 * The current generation of a skill: the highest generation present, or 0
 * when the skill has no candidates yet.
 * @param skill - the skill to inspect.
 * @returns the skill's current generation.
 */
generation(skill: string): number

/**
 * The lineage of one candidate within a skill, oldest ancestor first. The
 * chain walks stored parent links; unknown ids yield an empty chain.
 * @param skill - the skill the candidate belongs to.
 * @param candidateId - the candidate to start from.
 * @returns the candidate and its ancestors, oldest first, detached.
 */
lineage(skill: string, candidateId: string): readonly PopulationCandidate[]

/**
 * The current elite of a skill: approved candidates ranked by pass, then
 * fewer tokens, then faster wall time. Unmeasured candidates rank below every
 * measured one.
 * @param skill - the skill to rank.
 * @returns the approved candidates in elite order, detached.
 */
elite(skill: string): readonly PopulationCandidate[]

/**
 * Move one candidate to another status. A staged candidate may be approved or
 * rejected; approved and rejected are terminal. A same-status call resolves
 * without writing, and unknown ids or illegal transitions reject loudly.
 * @param candidateId - candidate identity.
 * @param status - requested status.
 * @returns the stored candidate after the transition.
 */
async updateStatus(candidateId: string, status: PopulationStatus): Promise<PopulationCandidate>
```

Source: [`packages/evolution/evolution-population/src/index.ts`](../../packages/evolution/evolution-population/src/index.ts)

<a id="ctxevolutionretrieval--evolutionretrieval"></a>

### `ctx.evolutionRetrieval` — `EvolutionRetrieval`

Retrieve configurations learned from the sessions that ran under them. Opens the `evolution_retrieval` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one session under one retrieval configuration. The attribution key
 * is the configuration and the session joined, so recording the same session
 * again — a resumed session, a retried step — upserts the same row and keeps
 * its first instant instead of counting the session twice.
 * @param input - the configuration in force and the session it served.
 * @returns the stored attribution.
 */
async record(input: RetrievalAttributionInput): Promise<RetrievalAttribution>

/**
 * List recorded attributions, optionally for one configuration, newest first
 * with session-id ascending tie-break.
 * @param configKey - optional configuration-key filter.
 * @returns the attributions, detached from the store.
 */
attributions(configKey?: string): readonly RetrievalAttribution[]

/**
 * The derived effectiveness of every configuration, optionally for one task
 * class, in task-class then configuration-key order.
 * @param taskClass - optional task-class filter.
 * @returns the effectiveness rows, detached from the store.
 */
effectiveness(taskClass?: RetrievalTaskClass): readonly RetrievalEffectiveness[]

/**
 * The configuration to run for one task class: the best-ranked configuration
 * with at least `minimumSessions` graded sessions, or undefined while no
 * configuration has that much evidence.
 * @param taskClass - the task class to recommend for.
 * @returns the recommended configuration, or undefined.
 */
recommend(taskClass: RetrievalTaskClass): RetrievalRankingEntry | undefined
```

Source: [`packages/evolution/evolution-retrieval/src/index.ts`](../../packages/evolution/evolution-retrieval/src/index.ts)

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

<a id="ctxevolutionrouter--evolutionrouter"></a>

### `ctx.evolutionRouter` — `EvolutionRouter`

Routing self-optimization store over durable outcomes. Opens the `evolution_router` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one measured outcome of a route serving one role on one task class.
 * The stored instant is now. When the outcome leaves the best-measured routes
 * of its task class and role strongly disagreeing, the §44 disagreement is
 * recorded as an uncertainty signal through the optional store seam — this is
 * the one producer of a `disagreement` signal that starts from route
 * outcomes. A failing record must not fail the observation.
 * @param outcome - the route, role, task class, and measured triple.
 * @returns the stored outcome.
 */
async observe(outcome: RouteOutcomeInput): Promise<RouteOutcome>

/**
 * List measured outcomes, optionally filtered by task class and role,
 * newest first with record-key ascending tie-break.
 * @param taskClass - optional task-class filter.
 * @param role - optional role filter.
 * @returns the outcomes, detached from the store.
 */
outcomes(taskClass?: RouterTaskClass, role?: RoutingRole): readonly RouteOutcome[]

/**
 * The derived effectiveness of every route, optionally filtered by task
 * class and role, in task-class then role-topology then provider/model
 * order.
 * @param taskClass - optional task-class filter.
 * @param role - optional role filter.
 * @returns the effectiveness rows, detached from the store.
 */
effectiveness(taskClass?: RouterTaskClass, role?: RoutingRole): readonly RouteEffectiveness[]

/**
 * The route to use for one task class and role: the best-ranked route with
 * at least `minimumSamples` measured outcomes, or undefined while no route
 * has that much evidence.
 * @param taskClass - the task class to recommend for.
 * @param role - the role to recommend for.
 * @returns the recommended route, or undefined.
 */
recommend(taskClass: RouterTaskClass, role: RoutingRole): RouteRankingEntry | undefined

/**
 * The §44 route disagreements among the recorded outcomes: per task class and
 * role, the two best-measured routes whose pass rates diverge by more than the
 * configured threshold, strongest gap first.
 * @param taskClass - optional task-class filter.
 * @param role - optional role filter.
 * @returns the disagreements, strongest first.
 */
disagreements(taskClass?: RouterTaskClass, role?: RoutingRole): readonly RouteDisagreement[]
```

Source: [`packages/evolution/evolution-router/src/index.ts`](../../packages/evolution/evolution-router/src/index.ts)

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

<a id="ctxevolutionselfmodel--evolutionselfmodel"></a>

### `ctx.evolutionSelfModel` — `EvolutionSelfModel`

Self-model store over durable assessments and capability entries. Opens the `evolution_selfmodel` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one skill's self-assessment, replacing its previous whole
 * self-view and ticking the revision one past it (1 for the first).
 * @param input - the assessment to record.
 * @returns the stored assessment.
 */
async record(input: SelfModelInput): Promise<SelfModel>

/**
 * Read one skill's assessment, detached from the store.
 * @param skill - the skill to inspect.
 * @returns the assessment, or undefined without one.
 */
assessment(skill: string): SelfModel | undefined

/**
 * List every assessment by skill name, detached from the store.
 * @returns the assessments, skill ascending.
 */
assessments(): readonly SelfModel[]

/**
 * Fold one capability observation into the capability's entry, creating
 * the entry on the first observation of its capability.
 * @param obs - the observation to record.
 * @returns the stored entry.
 */
async observe(obs: CapabilityObservation): Promise<CapabilityEntry>

/**
 * Read one capability's entry, detached from the store.
 * @param name - the capability to inspect.
 * @returns the entry, or undefined without one.
 */
capability(name: string): CapabilityEntry | undefined

/**
 * List every capability entry by capability name, detached from the store.
 * @returns the entries, capability ascending.
 */
capabilities(): readonly CapabilityEntry[]

/**
 * Rank every capability weakest first: lower pass rate, then thinner
 * evidence, then fewer covering skills, then the capability name.
 * @returns the frontier gaps, weakest first.
 */
gaps(): readonly FrontierGap[]

/**
 * The capability to learn next: the weakest gap, or null with no entries.
 * @returns the weakest gap, or null when empty.
 */
nextToLearn(): FrontierGap | null
```

Source: [`packages/evolution/evolution-self-model/src/index.ts`](../../packages/evolution/evolution-self-model/src/index.ts)

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
 * The mutation may have changed the body, so the per-session outcome
 * evidence clears with it: those outcomes describe the artifact that just
 * changed, and the utility reading starts over rather than crediting the new
 * body with the old body's results.
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
 * evidence gathered before a fix cannot promote the skill again. Either way
 * the session's outcome is recorded for §40's utility reading. Excluded
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
 * Read one skill's utility: uses, assisted and successful tasks, the
 * library-relative gain, and the recorded cost per success. The baseline arm
 * is the other tracked skills' pooled outcomes, because this harness records
 * no skill-free run; see {@link skillUtility} for exactly what the gain does
 * and does not measure.
 * @param name - skill name.
 * @returns the derived reading, or undefined when the skill has no record.
 */
utility(name: string): SkillUtility | undefined

/**
 * Record a new revision of the SKILL.md body. The store hashes the content
 * itself, so one place defines the shape of `contentSha`; the same bytes
 * again is a no-op, and a real change resets trust and clears the outcome
 * evidence like any other edit.
 * @param name - skill name.
 * @param content - the exact bytes just written to SKILL.md.
 * @returns the stored record, or undefined for excluded sources.
 */
async markRevised(name: string, content: string): Promise<SkillUsageRecord | undefined>

/**
 * List one skill's committed body revisions, oldest first: the durable
 * artifact registry answering lineage without re-reading files. Excluded
 * sources have no rows, and an absent record reads as an empty list.
 * @param name - skill name.
 * @returns the detached revision history, oldest first.
 */
versions(name: string): readonly SkillVersion[]

/**
 * Forget one skill's record and its version history entirely. Purge calls
 * this after removing the skill directory; absent names resolve without
 * writing.
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
 * Move one skill through its curation lifecycle. Entering `suspect` or
 * `archived` stamps that state's instant and leaving it clears the instant,
 * so a revival is judged against when the question was raised rather than
 * against any older clean load. The absorption target replaces any previous
 * one, so plain transitions carry none.
 * @param name - skill name.
 * @param state - new lifecycle state.
 * @param absorbedInto - consolidation umbrella, or null when standalone.
 * @returns the stored record.
 */
async setState(name: string, state: SkillLifecycleState, absorbedInto: string | null = null): Promise<SkillUsageRecord>
```

Source: [`packages/skill/evolution-skill-telemetry/src/index.ts`](../../packages/skill/evolution-skill-telemetry/src/index.ts)

<a id="ctxevolutionsleeptime--evolutionsleeptime"></a>

### `ctx.evolutionSleeptime` — `EvolutionSleeptime`

Sleep-time store over durable anticipated tasks and precomputed artifacts. Opens the `evolution_sleeptime` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Run one anticipation pass over the recurrence the source stores recorded:
 * anticipate each class that recurred often enough inside the window,
 * precompute the artifacts the offline plan justifies for them, and account
 * the recorded turns that consumed an artifact already cached. A class whose
 * recurrence falls outside the window is left to the next pass, and a task
 * the plan rates but no recorded recurrence stands behind is skipped rather
 * than precomputed on the plan's word alone. Every phase is bounded by
 * `maxPerPass` and reads only local storage, so the pass observes disposal at
 * the one unbounded wait — reading traces per skill.
 * @param signal - aborts between skills at plugin teardown.
 */
async anticipateAll(signal?: AbortSignal): Promise<void>

/**
 * Anticipate one future task, upserting by task identity so a re-anticipated
 * task refreshes its likelihood and expectations. The stored instant is now.
 * @param input - the task to anticipate.
 * @returns the stored task.
 */
async anticipate(input: AnticipationInput): Promise<AnticipatedTask>

/**
 * List every anticipated task, optionally filtered by domain, likeliest
 * first with task-id ascending tie-break.
 * @param domain - optional domain filter.
 * @returns the tasks, detached from the store.
 */
tasks(domain?: string): readonly AnticipatedTask[]

/**
 * Precompute one reasoning artifact for an anticipated task. The task must
 * exist: an artifact for a task nobody anticipated is a surprise, not idle
 * work. A fresh artifact has served nothing yet, and its hit cursor starts at
 * its own instant, so the turns recorded before it are never counted as its
 * consumers.
 * @param input - the artifact to cache.
 * @returns the stored artifact.
 */
async precompute(input: PrecomputeInput): Promise<PrecomputeArtifact>

/**
 * List every cached artifact, optionally filtered by task, newest first with
 * artifact-id ascending tie-break.
 * @param taskId - optional task filter.
 * @returns the artifacts, detached from the store.
 */
artifacts(taskId?: string): readonly PrecomputeArtifact[]

/**
 * Account the recorded occurrences that consumed a cached artifact: every
 * occurrence of the artifact's own class strictly newer than the instant its
 * hits are accounted through, credited with the tokens its store recorded and
 * counted as one hit each. The per-occurrence saving is what the recorded turn
 * spent, so an artifact with no later occurrence keeps its totals unchanged
 * and a second call at the same instant is a no-op — which is what makes a
 * repeating pass safe.
 * @param artifactId - the artifact to account.
 * @param occurrences - every occurrence the source stores recorded.
 * @returns the updated artifact.
 */
async hit(artifactId: string, occurrences: readonly TaskOccurrence[]): Promise<PrecomputeArtifact>

/**
 * The greedy budgeted plan over anticipated tasks that have no cached
 * artifact yet: worth-it decisions, best net first, fitted into the offline
 * budget at the estimated cost each.
 * @param estimatedCostTokens - estimated offline cost of one precompute.
 * @param budgetTokens - total offline budget available.
 * @returns the planned decisions, best net first.
 */
plan(estimatedCostTokens?: number, budgetTokens?: number): readonly SleeptimeDecision[]
```

Source: [`packages/evolution/evolution-sleeptime/src/index.ts`](../../packages/evolution/evolution-sleeptime/src/index.ts)

<a id="ctxevolutionstagnation--evolutionstagnation"></a>

### `ctx.evolutionStagnation` — `EvolutionStagnation`

Stagnation-detection store over durable runs. Opens the `evolution_stagnation` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one run, numbering its generation tick one past the skill's run
 * count and flagging whether it meaningfully improved the skill's best
 * score so far.
 * @param input - the run to record.
 * @returns the stored run.
 */
async recordRun(input: StagnationRunInput): Promise<StagnationRun>

/**
 * List every run, optionally filtered by skill, newest first.
 * @param skill - optional skill filter.
 * @returns the runs, detached from the store.
 */
runs(skill?: string): readonly StagnationRun[]

/**
 * The derived stagnation status of one skill: best score, runs since the
 * last meaningful improvement, the stagnant flag against the configured
 * threshold, and the strategy the skill should follow now. A skill with no
 * runs reports zero runs and normal exploitation.
 * @param skill - the skill to inspect.
 * @returns the stagnation status.
 */
status(skill: string): StagnationStatus

/**
 * Drop every recorded run of one skill, returning the count removed. Used
 * when a task regime changes and the skill's history no longer applies.
 * @param skill - the skill to reset.
 * @returns the number of runs removed.
 */
async reset(skill: string): Promise<number>
```

Source: [`packages/evolution/evolution-stagnation/src/index.ts`](../../packages/evolution/evolution-stagnation/src/index.ts)

<a id="ctxevolutiontrace--evolutiontrace"></a>

### `ctx.evolutionTrace` — `EvolutionTrace`

Immutable session trace projection. Opens no domain: the session log is the authoritative raw trace, and every read derives the structured form from it.

```ts cordis-catalog
/**
 * Project one session's committed log into its structured learning trace.
 * @param sessionId - session identity.
 * @returns the structured trace, or undefined when storage holds no such session.
 */
async trace(sessionId: string): Promise<TraceRecord | undefined>

/**
 * Compress the given sessions into learning-trace rows, most decisive first:
 * most failures, then retries, then billed tokens, then newest. Absent
 * sessions contribute nothing.
 * @param sessionIds - sessions to compress, in caller order.
 * @param limit - maximum rows returned.
 * @returns the compressed rows, decisive first.
 */
async summary(sessionIds: readonly string[], limit: number): Promise<LearningTraceRow[]>

/**
 * Replay one stored trace: reconstruct the context each step ran under,
 * restore the artifact the retrievals named, and compare a baseline artifact
 * against a candidate over the same trace (§16, §17). The recorded tool
 * results are the substrate, so the replay is keyless and re-invokes no
 * tool; steps whose recorded output is missing come back unreplayable.
 * @param sessionId - session whose committed trace to replay.
 * @param baseline - artifact revision the recorded run used.
 * @param candidate - artifact revision under consideration.
 * @returns the per-step comparison, or undefined when storage holds no such session.
 */
async replay(sessionId: string, baseline: ReplayArtifact, candidate: ReplayArtifact): Promise<ReplayReport | undefined>
```

Source: [`packages/evolution/evolution-trace/src/index.ts`](../../packages/evolution/evolution-trace/src/index.ts)

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

<a id="ctxevolutionuncertainty--evolutionuncertainty"></a>

### `ctx.evolutionUncertainty` — `EvolutionUncertainty`

Uncertainty-signal store over durable signals. Opens the `evolution_uncertainty` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Record one uncertainty signal, stamping it with the current instant.
 * @param input - the signal to record.
 * @returns the stored signal.
 */
async record(input: UncertaintySignalInput): Promise<UncertaintySignal>

/**
 * List every signal, optionally filtered by skill, newest first with signal
 * identity breaking same-instant ties for determinism.
 * @param skill - optional skill filter.
 * @returns the signals, detached from the store.
 */
signals(skill?: string): readonly UncertaintySignal[]

/**
 * The prioritized evaluation-task queue over the filtered signals, capped at
 * the caller's limit or the configured queue limit.
 * @param skill - optional skill filter.
 * @param limit - optional task cap, defaulting to the configured queue limit.
 * @returns the top evaluation tasks, highest priority first.
 */
queue(skill?: string, limit?: number): readonly EvaluationTask[]

/**
 * Drop the signals behind one evaluation task — without a task identity only
 * the skill-wide (null-task) signals of the skill — returning the count
 * removed. The queue re-derives from the signals that remain.
 * @param skill - the skill whose signals to drop.
 * @param taskId - optional task identity to drop; undefined drops only skill-wide signals.
 * @returns the number of signals removed.
 */
async resolve(skill: string, taskId?: string): Promise<number>
```

Source: [`packages/evolution/evolution-uncertainty/src/index.ts`](../../packages/evolution/evolution-uncertainty/src/index.ts)

<a id="ctxevolutionverifiers--evolutionverifiers"></a>

### `ctx.evolutionVerifiers` — `EvolutionVerifiers`

The ladder, mounted so a host and the packages that admit candidates share one admission rule.

```ts cordis-catalog
/**
 * Run the ladder over one candidate.
 * @param request - candidate body plus the seams the host mounts for the simulated, evaluator, and human rungs.
 * @returns the verdict, naming every consulted rung and the level that decided.
 */
async verify(request: VerifierRequest): Promise<VerifierVerdict>
```

Source: [`packages/evolution/evolution-verifiers/src/index.ts`](../../packages/evolution/evolution-verifiers/src/index.ts)

<a id="evolution-events"></a>

### `evolution/*` events

<a id="evolutiondecisions-applied--emit"></a>

#### `evolution/decisions-applied` — emit

One extraction pass's decision batch landed on a scope's record, emitted once per applied batch strictly after the write is durable. Deriving consumers — the knowledge graph's claim layer is the shipped one — fold the batch into their own state here; a listener failure is their own to contain, because the batch it reports is already stored.

A batch applied without provenance is not published: every decision is attributed to the session that reported it, and a batch whose session is unknown would carry unattributable evidence.

```ts cordis-catalog
/**
 * One extraction pass's decision batch landed on a scope's record,
 * emitted once per applied batch strictly after the write is durable.
 * Deriving consumers — the knowledge graph's claim layer is the shipped
 * one — fold the batch into their own state here; a listener failure is
 * their own to contain, because the batch it reports is already stored.
 *
 * A batch applied without provenance is not published: every decision is
 * attributed to the session that reported it, and a batch whose session
 * is unknown would carry unattributable evidence.
 * @param batch - scope, source session, decisions, and the artifacts they addressed.
 * @mode emit
 */
'evolution/decisions-applied'(batch: EvolutionDecisionsApplied): void
```

Source: [`packages/evolution/evolution-memory/src/index.ts`](../../packages/evolution/evolution-memory/src/index.ts)
<!-- END GENERATED cordis-surface -->
