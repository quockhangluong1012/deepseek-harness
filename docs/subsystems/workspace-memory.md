# Workspace Memory

English | [中文](workspace-memory.zh.md)

A Workspace in DeepSeek Harness is the durable record of a directory the user works in: a stable id over a canonical path, a display title, and the ordered account of Sessions that ran there (`ctx.workspaceRegistry`, `packages/workspace/workspace`). Workspace Memory gives each Workspace a durable body of knowledge that every Session in that Workspace inherits, and a Workspace page reachable by clicking the Workspace name in the sidebar.

Source: [`packages/workspace/workspace-memory/README.md`](../../packages/workspace/workspace-memory/README.md)

## Parts

| Part | Written by | Reaches the model | Counts against capacity |
|---|---|---|---|
| **Instructions** | the user | yes | yes |
| **Memory** | the model from this Workspace's own chat history; the user may edit or regenerate it | yes | yes |
| **Context** | the user, as attached workspace files or pasted text | yes | yes |
| **Description** | the user | no — page metadata | no |
| **Outputs** | derived from successful mutation-tool calls | no — a navigation index | no |

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`workspace-memory`](../../packages/workspace/workspace-memory/README.md) | Durable per-Workspace record, caps, and capacity accounting | `ctx.workspaceMemory` |
| [`workspace-memory-llm`](../../packages/workspace/workspace-memory-llm/README.md) | Per-turn output indexing, per-turn extraction, on-demand rebuild | `ctx.workspaceMemoryExtractor` |
| [`workspace-memory-context`](../../packages/context/workspace-memory-context/README.md) | Renders the brief and splices it into `agent/pre-step` | — |
| [`ui-workspace-memory`](../../packages/client/ui-workspace-memory/README.md) | Host `workspaceMemory` Remote namespace and the browser Workspace page | `ctx.workspaceMemoryController` |

The brief is one durable `user/message` appended from an `agent/pre-step` contribution, carrying source `{ kind: 'workspace-memory', form: 'instructions', workspaceId, digest }`. Empty sections are omitted; an unchanged record adds no second message. Storage is machine-local under `$DSH_HOME`; nothing writes inside the project directory.

## Generated API

The [Cordis API](#cordis-surface) section below owns the exhaustive service, event, and Remote listing for the packages above. The generated [configuration catalog](../config-catalog.md) owns every accepted config field.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [WorkspaceId](workspace.md)

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

Types: [WorkspaceId](workspace.md)

Source: [`packages/workspace/workspace-memory-llm/src/index.ts`](../../packages/workspace/workspace-memory-llm/src/index.ts)
<!-- END GENERATED cordis-surface -->
