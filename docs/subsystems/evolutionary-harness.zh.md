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
