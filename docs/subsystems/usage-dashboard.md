# Usage Dashboard

English | [中文](usage-dashboard.zh.md)

[`@deepseek-ai/dsh-usage-ledger`](../../packages/session/usage-ledger) folds every live session's billed LLM attempts into durable per-day and per-day-per-model counters and serves range summaries from `ctx.usageLedger`. [`@deepseek-ai/dsh-client-ui-usage-dashboard`](../../packages/client/ui-usage-dashboard) serves the same summaries over the `usageDashboard` Remote namespace from `ctx.usageDashboard` and draws them in the right Sidebar's `usage` page tab.

Source: [`packages/session/usage-ledger/src/types.ts`](../../packages/session/usage-ledger/src/types.ts)

## Public types

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

## Billed attempts and ranges

One billed attempt is one validated provider usage sample on an `assistant/message` or `assistant/attempt` event. Retries count, because each sample represents tokens a previous request already spent; a sample that fails validation is skipped, never zero-filled. Input tokens are billed prompt tokens (`uncached + cacheRead + cacheWrite`); the average cache hit is `cacheRead / billedInput`. Days are fixed to UTC+7. Bounded windows zero-fill their days so the chart always draws its frame; `all` covers only days with data.

## Fold and durability

The ledger derives from the durable session logs and never writes to them. Per-step buckets hold samples until `step/end` and re-attribute unknown-routed samples when the step's settled message names its route; steps that never settle attribute to the unknown route. Per-session cursors plus child-owned event ranges keep restarts and forks from double-counting. The whole state — per-day counters, per-day-per-model counters, and cursors — persists as one atomic document on the `usage_dashboard` storage domain, and every write is fail-soft: a lost write only costs a longer backfill. Counts begin when the ledger first mounts.

Opt-in `cacheHitAlertThreshold` emits `usage/cache-hit-low` on a healthy-to-unhealthy crossing of today's rolling cache-hit share, once `cacheHitAlertMinRequests` billed requests have landed — an ephemeral, edge-triggered signal, not a durable event.

## Web surface

The `usage` tab type registers into `ctx.sidebarRightTabs` as a `builtin` page with a guide entry, and its body into the keyed `sidebar.right.pane.tab` seat. The body reads cross-session figures through the generated `usageDashboard` Remote namespace and the current session's header through its `tokenUsage` and `sessionStats` projections. `@deepseek-ai/dsh-api-remotes` mounts the generated contribution, so the plugin calls `ctx.remote.usageDashboard` and never touches the transport.

## Boundaries and limitations

- Totals are advisory under-counts by construction, never billing records.
- Durable sessions that ended before the ledger first mounts contribute nothing.
- The reporting zone is fixed to UTC+7; it is a product decision, not a deployment choice.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

/**
 * Estimated spend per session for one filter range: the invoking agents and
 * every subagent, each with the money its own committed attempts cost.
 * Sessions with no priced attempt report `usd` as `undefined` and name the
 * routes no declared price covered, so an unmeasurable total is never
 * reported as a spend of zero.
 * @param range - the requested window (`today` by dashboard default).
 * @param signal - caller cancellation.
 * @returns one row per billing session, busiest first.
 */
async sessionCosts(range: UsageRange, signal: AbortSignal): Promise<readonly UsageSessionCost[]>
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
