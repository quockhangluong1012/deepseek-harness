# Workspace Memory

[English](workspace-memory.md) | 中文

DeepSeek Harness 中的 Workspace（工作区）是用户所用目录的持久记录：一个建立在规范路径之上的稳定 id、一个显示标题，以及在该处运行过的会话的有序账本（`ctx.workspaceRegistry`、`packages/workspace/workspace`）。Workspace Memory 为每个 Workspace 提供一份持久的知识主体，供该 Workspace 中的每个会话继承，并提供可通过点击侧边栏中的 Workspace 名称到达的 Workspace 页面。

源码：[`specs/workspace-memory.md`](../../specs/workspace-memory.md)

## 组成部分

| 部分 | 编写者 | 到达模型 | 计入容量 |
|---|---|---|---|
| **指令** | 用户 | 是 | 是 |
| **记忆** | 模型依据该 Workspace 自身的聊天历史编写；用户可编辑或重新生成 | 是 | 是 |
| **上下文** | 用户，以附加的工作区文件或粘贴文本形式提供 | 是 | 是 |
| **描述** | 用户 | 否——页面元数据 | 否 |
| **产出** | 由成功的修改类工具调用派生 | 否——一个导航索引 | 否 |

## 包

| 包 | 作用 | ctx 键 |
|---|---|---|
| [`workspace-memory`](../../packages/workspace/workspace-memory/README.zh.md) | 持久的按 Workspace 记录、上限与容量核算 | `ctx.workspaceMemory` |
| [`workspace-memory-llm`](../../packages/workspace/workspace-memory-llm/README.zh.md) | 按轮次的产出索引、按轮次的提取、按需重建 | `ctx.workspaceMemoryExtractor` |
| [`workspace-memory-context`](../../packages/context/workspace-memory-context/README.zh.md) | 渲染 brief 并将其拼接进 `agent/pre-step` | — |
| [`ui-workspace-memory`](../../packages/client/ui-workspace-memory/README.zh.md) | Host `workspaceMemory` Remote 命名空间与浏览器 Workspace 页面 | `ctx.workspaceMemoryController` |

brief 是由 `agent/pre-step` 贡献追加的一条持久 `user/message`，携带来源 `{ kind: 'workspace-memory', form: 'instructions', workspaceId, digest }`。空小节会被省略；记录未变化时不添加第二条消息。存储位于 `$DSH_HOME` 下的机器本地；不会向项目目录内写入任何内容。

## 生成的 API

下文的 [Cordis API](#cordis-surface) 小节拥有上述包的完整服务、事件与 Remote 清单。生成的[配置目录](../config-catalog.zh.md)拥有每个受支持的配置字段。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkspacememory--workspacememorystore"></a>

### `ctx.workspaceMemory` — `WorkspaceMemoryStore`

Durable per-Workspace memory store. Opens the `workspace_memory` domain at init and closes it through `ctx.effect`.

```ts cordis-catalog
/**
 * Read one Workspace's record.
 * @param id - Workspace identity.
 * @returns a detached copy, or undefined when absent.
 */
read(id: WorkspaceId): WorkspaceMemoryRecord | undefined

/**
 * Capacity accounting for one Workspace.
 * @param id - Workspace identity.
 * @returns charged bytes and the configured ceiling.
 */
usage(id: WorkspaceId): WorkspaceMemoryUsage

/**
 * Digest of the brief's inputs for one Workspace.
 * @param id - Workspace identity.
 * @returns `'empty'` when absent, else the sha1 of the covered inputs.
 */
digest(id: WorkspaceId): string

/**
 * Replace the page blurb. Never reaches a model request.
 * @param id - Workspace identity.
 * @param description - new blurb.
 * @returns the stored record.
 */
async setDescription(id: WorkspaceId, description: string): Promise<WorkspaceMemoryRecord>

/**
 * Replace the instruction text.
 * @param id - Workspace identity.
 * @param instructions - new rules.
 * @returns the stored record.
 */
async setInstructions(id: WorkspaceId, instructions: string): Promise<WorkspaceMemoryRecord>

/**
 * Replace the memory document by hand or from extraction.
 * @param id - Workspace identity.
 * @param memory - replacement document.
 * @param extraction - provenance when model-written.
 * @returns the stored record.
 */
async setMemory(id: WorkspaceId, memory: string, extraction?: WorkspaceMemoryExtraction): Promise<WorkspaceMemoryRecord>

/**
 * Attach pasted text or a workspace file.
 * @param id - Workspace identity.
 * @param input - label plus text or path with its observed size.
 * @returns the stored record.
 */
async addContextItem(id: WorkspaceId, input: WorkspaceContextItemInput): Promise<WorkspaceMemoryRecord>

/**
 * Detach one context item.
 * @param id - Workspace identity.
 * @param itemId - context item identity.
 * @returns the stored record.
 */
async removeContextItem(id: WorkspaceId, itemId: string): Promise<WorkspaceMemoryRecord>

/**
 * Index produced files newest-first, collapsing repeats onto the newer
 * `at` and truncating to `maxOutputs`. Resolves without writing when the
 * resulting list is unchanged.
 * @param id - Workspace identity.
 * @param entries - output entries with path, tool, session, and instant.
 * @returns resolution after durability, or immediately when unchanged.
 */
async recordOutputs(id: WorkspaceId, entries: readonly WorkspaceOutput[]): Promise<void>
```

Types: [WorkspaceId](workspace.zh.md)

Source: [`packages/workspace/workspace-memory/src/index.ts`](../../packages/workspace/workspace-memory/src/index.ts)

<a id="ctxworkspacememorycontroller--workspacememorycontroller"></a>

### `ctx.workspaceMemoryController` — `WorkspaceMemoryController`

Host Remote service delegating memory verbs to the store and extractor.

```ts cordis-catalog
/**
 * Load one Workspace's record.
 * @param request - Workspace identity.
 * @returns the Remote projection.
 */
@Remote('read') read(request: WorkspaceMemoryReadRequest): Promise<WorkspaceMemoryValue>

/**
 * Replace the page blurb.
 * @param request - Workspace identity and new blurb.
 * @returns the updated projection.
 */
@Remote('setDescription') async setDescription(request: WorkspaceMemorySetDescriptionRequest): Promise<WorkspaceMemoryValue>

/**
 * Replace the instruction text.
 * @param request - Workspace identity and new rules.
 * @returns the updated projection.
 */
@Remote('setInstructions') async setInstructions(request: WorkspaceMemorySetInstructionsRequest): Promise<WorkspaceMemoryValue>

/**
 * Replace the memory document by hand.
 * @param request - Workspace identity and new document.
 * @returns the updated projection.
 */
@Remote('setMemory') async setMemory(request: WorkspaceMemorySetMemoryRequest): Promise<WorkspaceMemoryValue>

/**
 * Attach pasted text or a workspace file.
 * @param request - Workspace identity, kind, label, and text or path.
 * @returns the updated projection.
 */
@Remote('addContextItem') async addContextItem(request: WorkspaceMemoryAddContextItemRequest): Promise<WorkspaceMemoryValue>

/**
 * Detach one context item.
 * @param request - Workspace identity and item identity.
 * @returns the updated projection.
 */
@Remote('removeContextItem') async removeContextItem(request: WorkspaceMemoryRemoveContextItemRequest): Promise<WorkspaceMemoryValue>

/**
 * List candidate paths under the Workspace root for the add-file picker.
 * @param request - Workspace identity and case-insensitive query.
 * @param signal - caller cancellation for the directory walk.
 * @returns workspace-relative paths, sorted, capped at 200.
 */
@Remote('listContextFiles') async listContextFiles(request: WorkspaceMemoryListContextFilesRequest, signal: AbortSignal): Promise<WorkspaceMemoryContextFilesValue>

/**
 * Rebuild the document from the Workspace's chat history.
 * @param request - Workspace identity.
 * @param signal - caller cancellation.
 * @returns the updated projection.
 */
@Remote('rebuildMemory') async rebuildMemory(request: WorkspaceMemoryRebuildRequest, signal: AbortSignal): Promise<WorkspaceMemoryValue>

/**
 * Stream a complete memory baseline followed by ordered upserts.
 * @param signal - generation cancellation.
 * @returns baseline followed by ordered memory increments.
 */
@Remote({ mode: 'stream' }) follow(signal: AbortSignal): AsyncIterable<WorkspaceMemoryFollowFrame>
```

Source: [`packages/client/ui-workspace-memory/src/index.ts`](../../packages/client/ui-workspace-memory/src/index.ts)

<a id="ctxworkspacememoryextractor--workspacememoryextractor"></a>

### `ctx.workspaceMemoryExtractor` — `WorkspaceMemoryExtractor`

Background extractor. One Workspace never runs two extractions at once; a turn is never blocked by one.

```ts cordis-catalog
/**
 * Rebuild the document from the Workspace's chat history.
 * @param workspaceId - Workspace identity.
 * @param signal - caller cancellation.
 * @returns resolution after the store write.
 */
async rebuild(workspaceId: WorkspaceId, signal: AbortSignal): Promise<void>
```

Types: [WorkspaceId](workspace.zh.md)

Source: [`packages/workspace/workspace-memory-llm/src/index.ts`](../../packages/workspace/workspace-memory-llm/src/index.ts)
<!-- END GENERATED cordis-surface -->
