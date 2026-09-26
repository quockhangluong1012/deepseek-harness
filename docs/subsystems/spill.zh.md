# spill 存储

[English](spill.md) | 中文

spill 存储[能力 seam](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)持久保存调用方提供的文本，并返回面向模型的定位符与检索指引。其 Service Definition 是 [dsh-spill](../../packages/spill/spill)（`ctx.spillStore`），本地 Service Provider 是 [dsh-spill-local](../../packages/spill/spill-local)。消费方包括[工具结果策略](../../packages/spill/spill-policy)与[会话引用](../../packages/context/session-reference/README.zh.md)。spill 是可选能力，不属于[智能体循环主干](core.zh.md)；预览与 spill 决策由消费方负责，存储则原样保存所提供的文本。

源码：[`packages/spill/spill/src/types.ts`](../../packages/spill/spill/src/types.ts)

## 保存请求

`saveText` 是唯一的服务操作：原样持久保存 `content`，并返回不透明的定位符、后端提供的检索提示和精确字节数。请求携带保存时的存储命名空间（`owner`）、描述性的生产者来源信息（`source`，绝非访问控制）以及后端可用作命名提示而非路径的 `suggestedName`。工具来源标识实际工具调用；会话引用来源标识被捕获的源会话，而其归属是接收上下文的目标会话。

```ts type-equiv
/** One request to persist text to a spill artifact. */
interface SaveTextSpill {
  owner: SpillOwner
  source: SpillSource
  /**
   * A caller-suggested base name (e.g. `web_fetch.txt`). The backend sanitizes
   * it to a single safe path segment before use — it is a hint, never a path.
   */
  suggestedName: string
  /** The full text to persist (UTF-8). */
  content: string
}
```

```ts type-equiv
/**
 * Save-time storage namespace for a spilled artifact. The session id lets a
 * backend group storage under the producing session, but the returned
 * {@link SpillLocator} is the model-facing handle. Forked sessions inherit
 * locators already present in the seeded log; those artifacts are not copied or
 * re-owned, and spills produced after the fork use the child session id.
 */
interface SpillOwner {
  sessionId: SessionId
}
```

保留期清理可以连同其他旧会话产物一起使旧定位符失效；spill seam 不定义逐会话的清理策略。

```ts type-equiv
/**
 * Producer of a spilled artifact. Tool results carry their model-issued call id;
 * session references identify the captured source session instead. Descriptive
 * source description only, never access control.
 */
type SpillSource = {
  kind: 'tool'
  /** The tool whose result was spilled (e.g. `web_fetch`). */
  toolName: string
  /** The model-issued call id the result belongs to. */
  callId: ToolCallId
  /** A short human label for the artifact (e.g. `result`). */
  label: string
} | {
  kind: 'session-reference'
  /** Session whose projected conversation was captured. */
  sessionId: SessionId
  /** Host-provided label for the referenced session. */
  label: string
}
```

## 结果

```ts type-equiv
/** A saved spill artifact: its locator, byte length, and backend-specific retrieval guidance. */
interface SpillRef {
  locator: SpillLocator
  bytes: number
  retrievalHint: string
}
```

`SpillLocator` 是后端返回的[品牌化](core.zh.md#branded-ids)面向模型句柄。本地后端将它渲染为文件系统路径；远程或数据库后端可以渲染 URI、键或命令 token。消费方将它视为不透明值，并使用 `retrievalHint` 渲染，而不是假定 `read` 始终是正确的检索机制。

```ts type-equiv
/**
 * Opaque model-facing handle for one spilled artifact. A local backend may use a
 * filesystem path; a remote or database backend may use a URI or key. Consumers
 * render it with {@link SpillRef.retrievalHint}, but do not parse it.
 */
type SpillLocator = Branded<'SpillLocator'>
```

## 服务

`SpillStore`（`ctx.spillStore`，定义于 [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)）是只有一个方法的抽象服务：`saveText(input) → Promise<SpillRef>`。它持久保存完整的 `content`，并在实际存储失败（权限、ENOSPC、后端不可用）时拒绝。该 seam 只负责存储：不负责保留策略、工具结果替换或检索／搜索 API。

本地后端（[dsh-spill-local](../../packages/spill/spill-local)）写入 `<root>/session-<hash>/<random>-<safeName>`：根目录是已配置或延迟创建的私有（0700）目录，会话子目录采用 `sha256(sessionId)`，并通过排他且仅所有者可访问的写入（`open(path, 'wx', 0o600)`）防止预先植入的符号链接重定向写入。其 `locator` 是本地路径，`retrievalHint` 则告知模型在该路径上使用 `read` 或 `grep`。策略消费方（[dsh-spill-policy](../../packages/spill/spill-policy)）会把超过 `maxInlineTokens` 的图文结果替换为按原顺序保留的首尾内容和 spill 地址；该过程尽力而为：保存失败时保留原始内联结果，而不会把成功的调用变成 `isError`。

## 产物取回

`ArtifactStore`（`ctx.artifacts`，定义于 [`packages/spill/spill/src/artifacts.ts`](../../packages/spill/spill/src/artifacts.ts)）是 `SpillStore` 后端所存产物之上的只读取回 seam，暴露演化规范命名的产物 API。它的五个操作是 `search`——按最新优先列出某会话的产物，可选按存储名子串匹配——`read`——返回存储文本或其中一个行窗口——`extract`——投影出匹配正则表达式的行——`diff`——把两个产物比较为统一补丁——以及 `summarize`——在字节预算内保留产物的首尾并报告精确的省略字节数。

定位信息仍是 `saveText` 返回的不透明句柄。除 `search` 外每个操作都接受它们，而后端未曾存储的定位信息——外部路径、未知名称、不是常规文件的条目——会以 `ArtifactLocatorError` 拒绝，而不是读取任意文件。取回绝不写入、替换、导出或删除产物，也绝不改变模型请求，因此无法绕过[工具结果策略](../../packages/spill/spill-policy)：模型能看到超大结果中的哪些内容仍由保留策略决定，而取回操作恢复的正是其提示所指的完整文本。`summarize` 组合该策略使用的字节导向保留库，因此调用方可以用其 `omittedBytes` 渲染既有的提示。

[dsh-spill-local](../../packages/spill/spill-local) 在同一个插件 fiber、同一个根目录上注册两个服务：本地实现读取的正是其 `saveText` 写入的文件，一次 dispose 同时释放两者。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxartifacts--artifactstore-abstract-seam"></a>

### `ctx.artifacts` — `ArtifactStore` (abstract seam)

Abstract artifact retrieval service over the artifacts of one `SpillStore` backend. Subclass, implement every operation, and load the subclass as a plugin — it registers as `ctx.artifacts` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Semantics every implementation must honor:

- Retrieval is READ-ONLY. No operation writes, replaces, exports, or deletes an artifact, and none changes what a model request contains; the writing seam is `SpillStore`, and model-facing preview policy stays in `@deepseek-ai/dsh-spill-policy`.
- read, extract, diff, and summarize accept only locators this backend stored. Another backend's locator, an unknown name, or a non-artifact entry REJECTS with ArtifactLocatorError rather than reading an arbitrary file.
- Search is scoped to the request's SearchArtifacts.owner session, like storage, and never reaches another session's artifacts.
- summarize retains the artifact's head and tail under the request's byte budget with the same byte-oriented retention the spill policy composes, so its exact `omittedBytes` is what the shipped notice formatter consumes.

```ts cordis-catalog
/**
 * List artifacts of the owner session, newest first, filtered by the request's
 * criteria. A session with no stored artifact returns an empty list.
 * @param request - the owner session scope, optional stored-name substring, and match limit.
 * @returns the matching artifacts, newest first; empty when none match.
 */
abstract search(request: SearchArtifacts): Promise<ArtifactMatch[]>

/**
 * Read one line window of a stored artifact, defaulting to all of it.
 * @param request - the artifact locator and the optional 1-based line window.
 * @returns the window text and both the window's and the artifact's sizes.
 */
abstract read(request: ReadArtifact): Promise<ArtifactText>

/**
 * Project the artifact lines matching a regular expression, in artifact order.
 * @param request - the artifact locator, the pattern source, and the optional match limit.
 * @returns the matching lines with their line numbers and the complete match count.
 */
abstract extract(request: ExtractArtifact): Promise<ArtifactExtract>

/**
 * Compare two stored artifacts line by line.
 * @param request - the two artifact locators and the optional unchanged-line context.
 * @returns the unified patch and the added/deleted line counts.
 */
abstract diff(request: DiffArtifacts): Promise<ArtifactDiff>

/**
 * Retain an artifact's head and tail under a byte budget.
 * @param request - the artifact locator and the maximum returned UTF-8 bytes.
 * @returns the retained ends and the exact omitted byte count.
 */
abstract summarize(request: SummarizeArtifact): Promise<ArtifactSummary>
```

Source: [`packages/spill/spill/src/artifacts.ts`](../../packages/spill/spill/src/artifacts.ts)

<a id="ctxspillstore--spillstore-abstract-seam"></a>

### `ctx.spillStore` — `SpillStore` (abstract seam)

Abstract spill storage service. Subclass, implement saveText, and load the subclass as a plugin — it registers as `ctx.spillStore` (one implementation per context; loading a second throws, cordis' standard duplicate-service behavior).

Semantics every implementation must honor:

- saveText persists the FULL `content` verbatim and returns an opaque locator, exact byte length, and model-facing retrieval guidance.
- Storage is scoped by the request's SaveTextSpill.owner session; the backend chooses a private (not world-readable) location and a collision-free name derived from — never equal to — the caller's `suggestedName`.
- `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend unavailable); the caller decides how to degrade (the spill policy treats a rejection as best-effort and keeps the inline result).

```ts cordis-catalog
/**
 * Persist `input.content` to a session-scoped spill artifact.
 * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
 * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
 */
abstract saveText(input: SaveTextSpill): Promise<SpillRef>
```

Source: [`packages/spill/spill/src/index.ts`](../../packages/spill/spill/src/index.ts)
<!-- END GENERATED cordis-surface -->
