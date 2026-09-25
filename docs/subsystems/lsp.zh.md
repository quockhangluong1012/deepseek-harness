# LSP 导航与诊断

[English](lsp.md) | 中文

LSP seam 是一个[能力 seam](../glossary.zh.md#capability-seam)：它在单一 `ctx.lsp` 服务上公开语言服务器导航与文件诊断。包组提供服务定义（[dsh-lsp](../../packages/lsp/lsp)）、配置好的 stdio 提供方（[dsh-lsp-stdio](../../packages/lsp/lsp-stdio)）、按需模型消费方（[dsh-tool-lsp](../../packages/lsp/tool-lsp)）以及可选的编辑后上下文（[lsp-post-edit-diagnostics](../../packages/lsp/lsp-post-edit-diagnostics)）。LSP 是可选能力，不属于 agent loop 主干；提供方词汇在此定义，而非 [core.md](core.zh.md)。

源文件：[`packages/lsp/lsp/src/types.ts`](../../packages/lsp/lsp/src/types.ts)

## 操作与坐标

seam 与模型公开五种操作。四种基于光标的导航操作在协议上使用从零开始的 UTF-16 位置与范围；文件级 `diagnostics` 不携带光标。面向模型的工具会转换从 1 开始的光标坐标。该联合是闭合的，新增操作会通过编译强制要求同步修改 seam、提供方和工具。

```ts type-equiv
/**
 * The five semantic queries the seam and model expose. A closed union: adding an operation is a
 * compile-enforced change across the seam, providers, and the tool. Symbols and call hierarchy are
 * not operations here; they need different schemas.
 */
type LspOperation = 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover' | 'diagnostics'
```

```ts type-equiv
/** A zero-based UTF-16 cursor coordinate, matching the LSP wire convention. */
interface LspPosition {
  /** Zero-based line. */
  readonly line: number
  /** Zero-based UTF-16 code-unit offset within the line. */
  readonly character: number
}
```

```ts type-equiv
/** A zero-based UTF-16 half-open range `[start, end)`. */
interface LspRange {
  readonly start: LspPosition
  readonly end: LspPosition
}
```

## 请求

调用方请求的每个成员都要求 `operation`、`filePath` 与 `workspaceRoot`。四种基于光标的操作还要求 `position`；文件级 `diagnostics` 不需要位置。所选提供方会派生 `languageId`，仅用于同步其临时文档；超时与结果上限由消费方负责。

```ts type-equiv
/**
 * A caller's normalized query. Every member requires `operation`, `filePath`, and the caller's
 * `workspaceRoot`. Cursor-based operations also require a zero-based UTF-16 `position`; the
 * file-scoped `diagnostics` operation has no position. The selected provider derives `languageId`;
 * callers own timeouts and result limits, so there is no implementation defaulting or `resolve()` step.
 */
type LspQueryRequest =
  | {
    /** Which cursor-based semantic query to run. */
    readonly operation: 'goToDefinition' | 'findReferences' | 'goToImplementation' | 'hover'
    /** The source file to query (relative to `workspaceRoot` or absolute; the provider canonicalizes). */
    readonly filePath: string
    /** The zero-based UTF-16 cursor position to query at. */
    readonly position: LspPosition
    /** The workspace root the provider resolves against and indexes; required, never defaulted. */
    readonly workspaceRoot: string
  }
  | {
    /** Diagnostics: whole-file, no cursor position. */
    readonly operation: 'diagnostics'
    /** The source file to query (relative to `workspaceRoot` or absolute; the provider canonicalizes). */
    readonly filePath: string
    /** The workspace root the provider resolves against and indexes; required, never defaulted. */
    readonly workspaceRoot: string
  }
```

```ts type-equiv
/**
 * A request as a provider receives it: the caller's {@link LspQueryRequest} plus the `languageId`
 * the seam derived from the provider's extension mapping. The language id only synchronizes the
 * transient document; it does not participate in selection.
 */
type LspProviderQuery = LspQueryRequest & {
  /** The LSP language id for `filePath`, from this provider's extension mapping. */
  readonly languageId: string
}
```

## 结果

这是一个闭合的可辨识联合：导航操作规范化为 `locations`，`hover` 规范化为内容或 `null`，`diagnostics` 则规范化为文件当前诊断列表。若有界等待内没有匹配的推送，stdio 提供方会返回空诊断列表。消费方按 `kind` 穷尽处理，新分支会导致编译失败，直到完成处理。`findReferences` 始终包含声明。`locations` 变体携带提供方的规范工作区 `file:` URI，消费方据此避免对请求根目录应用宿主路径规则。

```ts type-equiv
/** One resolved location: a document URI and the range within it. */
interface LspLocation {
  /** The target document URI (`file:` or otherwise), verbatim from the server. */
  readonly uri: string
  /** The range within the target document. */
  readonly range: LspRange
}
```

```ts type-equiv
/** Normalized hover content, or `null` for no hover at the position. */
interface LspHover {
  /** The normalized hover text (markdown or plaintext, provider-joined). */
  readonly contents: string
  /** The range the hover applies to, when the server supplied one. */
  readonly range?: LspRange
}
```

```ts type-equiv
/** Normalized diagnostic severity, from the LSP wire enum (1=Error, 2=Warning, 3=Information, 4=Hint). */
type LspDiagnosticSeverity = 'error' | 'warning' | 'information' | 'hint'
```

```ts type-equiv
/** One normalized diagnostic: a range, severity, and message, plus the source/code the server attached, if any. */
interface LspDiagnostic {
  /** The range the diagnostic applies to. */
  readonly range: LspRange
  /** Normalized severity; a server that omits severity is treated as `error`. */
  readonly severity: LspDiagnosticSeverity
  /** The diagnostic message text. */
  readonly message: string
  /** The tool/component that produced the diagnostic (e.g. `typescript`, `eslint`), when the server supplied one. */
  readonly source?: string
  /** The diagnostic's rule/error code, when the server supplied one (numeric codes are stringified). */
  readonly code?: string
}
```

```ts type-equiv
/**
 * The closed result union. Navigation operations (`goToDefinition`, `findReferences`,
 * `goToImplementation`) normalize to `locations`; `hover` normalizes to content or `null`;
 * `diagnostics` normalizes to the file's current diagnostic list (possibly empty).
 * Consumers `switch` on `kind` to exhaustiveness so a new arm breaks compilation until handled.
 *
 * The `locations` variant carries `resolvedWorkspaceUri`: the provider's canonical `file:` URI for
 * the request's workspace root. A caller that relativizes location URIs MUST use this, not parse the
 * request's possibly symlinked process path with host-platform rules; the execution platform may
 * differ from the caller's.
 */
type LspQueryResult =
  | { readonly kind: 'locations'; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
  | { readonly kind: 'hover'; readonly hover: LspHover | null }
  | { readonly kind: 'diagnostics'; readonly diagnostics: readonly LspDiagnostic[] }
```

## 提供方与服务

每个提供方拥有一个稳定的品牌化 `id`，以及一份互斥的、小写且以点开头的扩展名映射。`registerProvider` 会原子预留 id 和每个扩展名：注册无效或冲突时不发布任何内容；其 disposer 会释放所有保留项。每次查询独立选择提供方，且选择与顺序无关；没有匹配项时抛出 `LspError` `LSP_UNAVAILABLE`。该 seam 不公开协议类型、进程或文档控制，也不提供通用 JSON-RPC 逃生口。

```ts type-equiv
/**
 * A language-server backend registered on `ctx.lsp`. Each provider owns a stable {@link
 * LspProviderId} and an extension-to-language-id map (lowercase, leading-dot keys).
 * `findReferences` always includes declarations — the provider enforces this internally; callers
 * get no flag.
 */
interface LspProvider {
  /** Stable provider identity, reserved atomically with the extension mappings. */
  readonly id: LspProviderId
  /** Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`). */
  readonly extensionToLanguage: Readonly<Record<string, string>>
  /**
   * Run one query. The seam has already selected this provider and derived `languageId`.
   * @param request - the resolved provider query (caller request + derived language id).
   * @param signal - optional cancellation; the provider stops its own work when it aborts.
   * @returns the normalized, closed-union result.
   */
  query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>
}
```

```ts type-equiv
/**
 * The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query
 * execution; exposes exactly the five operations and no protocol escape hatch.
 */
interface LspService {
  /**
   * Register a provider, atomically reserving its id and every normalized extension. Any conflict
   * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
   * reservations. Disposed with the calling fiber.
   * @param provider - the backend to register.
   * @returns a synchronous disposer releasing the id and all extension reservations.
   */
  registerProvider(provider: LspProvider): () => void
  /**
   * Select a provider by the file's extension and run one query. Selection is per-query and
   * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
   * @param request - the normalized query.
   * @param signal - optional cancellation forwarded to the selected provider.
   * @returns the normalized, closed-union result.
   */
  query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
}
```

`LspProviderId` 是该 seam 的品牌化 id（来自 [dsh-brand](../../packages/util/brand) 的 `Branded<'LspProviderId'>`）；`LspError` 扩展 `HarnessError`，提供 `LSP_INVALID_PROVIDER`、`LSP_CONFLICT`、`LSP_UNAVAILABLE`、`LSP_DISPOSED`、`LSP_UNSUPPORTED_OPERATION` 和 `LSP_MALFORMED_RESPONSE` 等稳定错误码，调用方应按错误码路由，而不是解析 `message`。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxlsp--lspservice"></a>

### `ctx.lsp` — `LspService`

The LSP capability seam (`ctx.lsp`). Owns provider registration/selection and normalized query execution; exposes exactly the five operations and no protocol escape hatch.

```ts cordis-catalog
/**
 * Register a provider, atomically reserving its id and every normalized extension. Any conflict
 * or invalid input publishes nothing and throws `LspError`; the returned disposer releases all
 * reservations. Disposed with the calling fiber.
 * @param provider - the backend to register.
 * @returns a synchronous disposer releasing the id and all extension reservations.
 */
registerProvider(provider: LspProvider): () => void

/**
 * Select a provider by the file's extension and run one query. Selection is per-query and
 * order-independent; no match throws `LspError` `LSP_UNAVAILABLE`.
 * @param request - the normalized query.
 * @param signal - optional cancellation forwarded to the selected provider.
 * @returns the normalized, closed-union result.
 */
query(request: LspQueryRequest, signal?: AbortSignal): Promise<LspQueryResult>
```

Source: [`packages/lsp/lsp/src/types.ts`](../../packages/lsp/lsp/src/types.ts)
<!-- END GENERATED cordis-surface -->
