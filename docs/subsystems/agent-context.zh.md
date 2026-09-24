# 上下文编译器

[English](agent-context.md) | 中文

由 [`@deepseek-ai/dsh-agent-context`](../../packages/runtime/agent-context/README.zh.md) 拥有的上下文编译器。它观察 [`core/system-prompt`](../../packages/core/system-prompt/README.zh.md) 产出的组装，把每条贡献与每条持久任务事实包装成来源信封，为其排序与计价，在所配置的 token 上限处切分放置，并为每次组装记录一条 `context/compiled` 事件。它不拥有任何提示词贡献，也不拥有任何模型请求：`system-prompt` 保留每个 section 与运行时 context，[`agent-kernel`](agent-kernel.zh.md) 保留它所读取的任务契约，`core/agent-loop` 依据编译器交回的组装渲染请求。声明位于 [`packages/runtime/agent-context/src/types.ts`](../../packages/runtime/agent-context/src/types.ts)；包 README 定义配置与挂载契约。

## 来源信封

`ContextSourceKind` 是封闭联合 `policy | task | plan | memory | evidence | artifact | history | tool`。`RetentionClass` 是 `required | compressible`，`OmissionReason` 是 `budget | duplicate`。

`ContextSource` 是编译器可以放置的一条贡献：一次编译内唯一的 `id`、`kind`、该来源贡献的确切 `content`、来自 [`agent-kernel`](agent-kernel.zh.md) 的 `TrustLabel` 与 `Provenance`、`retention` 等级，以及可选的 `subject`——它指名该来源所做的断言。编译器从组装读到的来源以其注册名作为 `id`；持久事实使用派生的键。

组装出的贡献，其 kind、trust 与归属来自 [`src/classify.ts`](../../packages/runtime/agent-context/src/classify.ts) 中的前缀表，未列出的前缀解析为不可信的仓库内容。从 `KernelView` 读到的事实始终是 `trusted` 且始终是 `required`：目标、每个验收标准一条来源、每条约束一条、最新计划修订、每个未结动作一条，以及每个未解决失败一条。保留等级随 kind，因此 `policy`、`task`、`plan` 与 `evidence` 来源即使单独超出上限也仍被放置。

## 放置

`CompiledSource` 是被放置的信封，带有它与任务目标的词面 `relevance`（[0,1]）以及来自 `dsh-token-meter` 的固定启发式 `tokens` 价格。

`ContextCompiler.compile()` 接收一个 `ContextCompileInput`——组装、额外的持久来源、相关性打分所依据的目标，以及可选的上限——并返回 `CompiledContext`：按放置顺序排列的 `included` 来源、带有原因的 `omitted` 来源、被保留的 `conflicts`、放置的 `tokenEstimate`、其 `digest`，以及产出它的 `compilerVersion`。默认编译器是纯的、确定的，且不含 I/O。

排序是全序，因此重放能从相同来源复现一次放置：先可信度（`trusted`、`unknown`、`untrusted`），再 kind（`policy`、`task`、`plan`、`evidence`、`memory`、`artifact`、`history`、`tool`），再相关性降序，最后 `id` 的码元顺序。上限切掉该顺序的一个前缀，因此一旦某条可压缩来源放不下，其后每条可压缩来源都以 `budget` 被省略。内容已被某个已放置来源承载的可压缩来源以 `duplicate` 被省略；`required` 来源不会被这两条规则中的任何一条丢弃。

`ContextConflict` 指名两条被放置的 `required` 来源互不相同的、关于同一个断言的争议：`subject` 与按放置顺序排列的相异来源 id。编译器报告分歧，但从不裁决分歧；对于只有一条来源声明的 `subject`，它不记录任何东西。

`digest` 是重放必须复现的身份：对编译器版本、上限，以及每个被放置来源的 id、kind、trust、retention、价格、相关性与内容哈希，加上每条遗漏与每个冲突计算的 SHA-256。它不覆盖任何时钟，也不覆盖任何生成式身份。

## 持久记录

`ContextCompilationEntry` 是日志所保留的一条被放置来源，不含其面向模型的内容；`ContextCompilationRecord` 是 `context/compiled` 的完整载荷：摘要、编译器版本、上限、token 估算、各条目、各遗漏与各冲突。

该记录在每次指名了某个 agent 的组装后写一次，提示词文本本身留在 `system/message` 面上，因此日志承载的是放置的身份，而不是提示词的第二份副本。该事件仅入日志，绝不进入模型上下文；[Session 页面](session.zh.md)拥有它所扩展的事件映射契约。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxagentcontext--agentcontextservice"></a>

### `ctx.agentContext` — `AgentContextService`

The compiler service (`ctx.agentContext`). It attaches to the prompt assembly waterfall in its constructor, so unloading the plugin unloads the listener with it.

```ts cordis-catalog
/**
 * Register one producer's descriptor and item supplier (S2). The compiler
 * places its items alongside the assembly and the kernel's task facts on
 * every later compile, until the disposer runs.
 * @param descriptor - the producer's source descriptor.
 * @param provide - the item supplier, called once per compile.
 * @returns a disposer that unregisters the producer.
 */
register(descriptor: ContextSourceDescriptor, provide: ContextSourceProvider): () => void

/**
 * Compile one assembly for a live agent and record the placement.
 * @param agent - the agent the assembly is for.
 * @param assembly - the assembled prompt contributions.
 * @param signal - cancellation forwarded to every registered provider.
 * @returns the placement, already appended as `context/compiled`.
 */
async compile(agent: Agent, assembly: PromptAssembly, signal: AbortSignal = new AbortController().signal): Promise<CompiledContext>
```

Types: [Agent](core.zh.md)

Source: [`packages/runtime/agent-context/src/index.ts`](../../packages/runtime/agent-context/src/index.ts)
<!-- END GENERATED cordis-surface -->
