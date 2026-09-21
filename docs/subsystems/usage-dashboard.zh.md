# 用量仪表盘

[English](usage-dashboard.md) | 中文

[`@deepseek-ai/dsh-usage-ledger`](../../packages/session/usage-ledger) 把每个活跃会话的已计费 LLM 请求折叠为持久的按天、按天按模型计数，并从 `ctx.usageLedger` 提供按范围汇总。[`@deepseek-ai/dsh-client-ui-usage-dashboard`](../../packages/client/ui-usage-dashboard) 从 `ctx.usageDashboard` 经 `usageDashboard` Remote 命名空间提供同样的汇总，并在右侧 Sidebar 的 `usage` 页面 tab 里绘制。

Source: [`packages/session/usage-ledger/src/types.ts`](../../packages/session/usage-ledger/src/types.ts)

## 公共类型

```ts type-equiv
/** Cross-session aggregation window selected by the dashboard filter. */
type UsageRange = 'today' | '7d' | '30d' | 'all'
```

```ts type-equiv
/** Totals over one summary window. */
interface UsageTotals {
  /** Billed attempts (every usage sample counts, retries included). */
  readonly requests: number
  /** Billed prompt tokens. */
  readonly inputTokens: number
  /** Billed completion tokens. */
  readonly outputTokens: number
  /** Prompt tokens served from cache. */
  readonly cacheReadTokens: number
  /** Share of billed input served from cache, `0` without billed input. */
  readonly cacheHitAvg: number
}
```

```ts type-equiv
/** One calendar day (UTC+7) of billed usage for the stacked bar chart. */
interface UsageDayBucket {
  /** Calendar day in `YYYY-MM-DD` (UTC+7). */
  readonly day: string
  /** Billed attempts that day. */
  readonly requests: number
  /** Billed prompt tokens that day. */
  readonly inputTokens: number
  /** Billed completion tokens that day. */
  readonly outputTokens: number
}
```

```ts type-equiv
/** One provider/model row of the model breakdown table. */
interface UsageModelRow {
  /** Adapter provider name. */
  readonly provider: string
  /** Model name. */
  readonly model: string
  /** Billed attempts on this route. */
  readonly requests: number
  /** Billed prompt tokens on this route. */
  readonly inputTokens: number
  /** Billed completion tokens on this route. */
  readonly outputTokens: number
  /** Share of this route's billed input served from cache. */
  readonly cacheHitAvg: number
}
```

```ts type-equiv
/** The complete dashboard answer for one filter range. */
interface UsageSummary {
  /** The range this summary was computed for. */
  readonly range: UsageRange
  /** Window totals for the stat cards. */
  readonly totals: UsageTotals
  /** Per-day buckets for the bar chart, ascending by day. */
  readonly daily: readonly UsageDayBucket[]
  /** Per-model rows, descending by billed total. */
  readonly models: readonly UsageModelRow[]
}
```

```ts type-equiv
/** Payload of {@link Events['usage/cache-hit-low']}. */
interface CacheHitLowEvent {
  /** Calendar day (UTC+7) the rate was computed for. */
  readonly day: string
  /** The share that crossed below threshold, in `[0, 1]`. */
  readonly cacheHitAvg: number
  /** The configured {@link Config.cacheHitAlertThreshold} that was crossed. */
  readonly threshold: number
  /** Today's billed request count at the moment of the crossing. */
  readonly requests: number
}
```

## 已计费请求与范围

一次已计费请求是 `assistant/message` 或 `assistant/attempt` 事件上一个校验通过的 provider 用量样本。重试会计数，因为每个样本都代表此前请求已花掉的 token；校验失败的样本会被跳过，绝不补零。输入 token 是已计费提示 token（`uncached + cacheRead + cacheWrite`）；平均缓存命中为 `cacheRead / billedInput`。天固定为 UTC+7。有界窗口补零其天数，因此图表永远绘制框架；`all` 只覆盖有数据的天。

## 折叠与持久化

台账从持久会话日志派生，从不写回。按步桶在 `step/end` 前持有样本，落定 message 到达时把早到的未知路由样本搬移到其路由；从未落定路由的步归因到未知路由。按会话游标加子会话自有事件范围让重启与 fork 不重复计数。整个状态——按天计数、按天按模型计数、游标——以一个原子文档持久化在 `usage_dashboard` 存储域上，每次写都是 fail-soft：丢一次写只意味着下次启动回填更长。计数从台账首次挂载开始。

可选的 `cacheHitAlertThreshold` 在今天滚动缓存命中占比由健康转为不健康时发出 `usage/cache-hit-low`，触发前提是当天已有至少 `cacheHitAlertMinRequests` 次已计费请求落定——这是一个边沿触发的临时信号，不是持久事件。

## Web 界面

`usage` tab 类型以 `builtin` 页面（含引导页入口）注册进 `ctx.sidebarRightTabs`，正文注册进 keyed `sidebar.right.pane.tab` 坑位。正文经生成的 `usageDashboard` Remote 命名空间读跨会话数字，经其 `tokenUsage` 与 `sessionStats` 投影读当前会话头部。`@deepseek-ai/dsh-api-remotes` 挂载生成的贡献，因此插件调用 `ctx.remote.usageDashboard`，从不触碰传输层。

## 边界与限制

- 总数按构造少计，是参考值，绝非账单记录。
- 台账首次挂载前结束的持久会话没有贡献。
- 报告时区固定为 UTC+7；这是产品决定，不是部署选项。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxusagedashboard--usagedashboard"></a>

### `ctx.usageDashboard` — `UsageDashboard`

Host Remote service delegating dashboard summaries to the ledger.

```ts cordis-catalog
/**
 * Dashboard summary for one filter range, served from the ledger.
 * @param range - the requested window (`today` by dashboard default).
 * @param signal - caller cancellation.
 * @returns totals, per-day buckets, and the per-model table.
 */
@Remote('summary') summary(range: UsageRange, signal: AbortSignal): Promise<UsageSummary>
```

Source: [`packages/client/ui-usage-dashboard/src/index.ts`](../../packages/client/ui-usage-dashboard/src/index.ts)

<a id="ctxusageledger--usageledger"></a>

### `ctx.usageLedger` — `UsageLedger`

The usage-ledger service. Opens the `usage_dashboard` domain at init, backfills live sessions from their cursors, folds live events as they commit, and serves range summaries.

```ts cordis-catalog
/**
 * Dashboard summary for one filter range.
 * @param range - the requested window (`today` by dashboard default).
 * @param signal - caller cancellation.
 * @returns totals, per-day buckets, and the per-model table.
 */
summary(range: UsageRange, signal: AbortSignal): Promise<UsageSummary>
```

Source: [`packages/session/usage-ledger/src/index.ts`](../../packages/session/usage-ledger/src/index.ts)

<a id="usage-events"></a>

### `usage/*` events

<a id="usagecache-hit-low--emit"></a>

#### `usage/cache-hit-low` — emit

Today's rolling cache-hit share (all routes, UTC+7 day) dropped below Config.cacheHitAlertThreshold after at least Config.cacheHitAlertMinRequests billed requests. Edge-triggered: fires once per healthy-to-unhealthy crossing, not on every request while the day is already below threshold. Ephemeral (not logged to any session): a live listener observes it, or re-derives the same rate any time from UsageLedger.summary.

```ts cordis-catalog
/**
 * Today's rolling cache-hit share (all routes, UTC+7 day) dropped below
 * {@link Config.cacheHitAlertThreshold} after at least
 * {@link Config.cacheHitAlertMinRequests} billed requests. Edge-triggered:
 * fires once per healthy-to-unhealthy crossing, not on every request
 * while the day is already below threshold. Ephemeral (not logged to any
 * session): a live listener observes it, or re-derives the same rate any
 * time from {@link UsageLedger.summary}.
 * @param data - the day, its rate, the crossed threshold, and its request count.
 * @mode emit
 */
'usage/cache-hit-low'(data: CacheHitLowEvent): void
```

Source: [`packages/session/usage-ledger/src/index.ts`](../../packages/session/usage-ledger/src/index.ts)
<!-- END GENERATED cordis-surface -->
