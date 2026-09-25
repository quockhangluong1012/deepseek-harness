---
description: "Durable ledger of billed LLM attempts aggregated by day and model for the DeepSeek Harness usage dashboard."
kind: "package-reference"
---

# @deepseek-ai/dsh-usage-ledger

English | [中文](README.zh.md)

## Summary

`dsh-usage-ledger` folds every live session's billed LLM attempts into durable per-day and per-day-per-model counters and serves range summaries to the usage dashboard. One billed attempt is one provider usage sample on an `assistant/message` or `assistant/attempt` event — retries count, because each sample represents tokens a previous request already spent. The state persists as one atomic document on the `usage_dashboard` storage domain, and every write is fail-soft.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a consumer needs billed-usage aggregates across sessions. The plugin has no model-visible surface; all three durability choices are explicit validated `Config` with no silent defaults:

```yaml
- id: usage-ledger
  name: '@deepseek-ai/dsh-usage-ledger'
  config:
    retentionDays: 90
    writeEveryEvents: 100
    writeIntervalMs: 60000
```

### Composition

```yaml
- {name: '@deepseek-ai/dsh-storage'}
- {name: '@deepseek-ai/dsh-storage-json', config: {root: /var/lib/dsh/data}}
- {name: '@deepseek-ai/dsh-storage-domain', config: {backend: json}}
- id: usage-ledger
  name: '@deepseek-ai/dsh-usage-ledger'
  config:
    retentionDays: 90
    writeEveryEvents: 100
    writeIntervalMs: 60000
```

### Reading the numbers

`summary(range)` answers totals, per-day buckets, and the per-model table for `today`, `7d`, `30d`, or `all`. Input tokens are billed prompt tokens (`uncached + cacheRead + cacheWrite`); the average cache hit is `cacheRead / billedInput`; days are fixed to UTC+7. Totals are advisory, not billing records: unprovable samples are skipped, never zero-filled, and counts begin when the ledger first mounts.

The same UTC+7 calendar is exported from the package root — `dayKeyUTC7`, `dayStartUTC7`, `daysOfRange`, `isUsageRange`, and `windowStartOfRange` — so a surface that reports per-day history (the evolution journey) buckets on the dashboard's days instead of re-deriving the zone offset. The root also exports the pricing primitives — `priceSample(sample, cost)` bills one normalized sample through provider rates and their volume tiers, with `normalizeSample`, `sampleOfAttempt`, `sampleOfMessage`, and `messageRoute` alongside it — for a surface that prices a single session tree on demand, as `/cost` does.

### Cache-hit alert (opt-in)

`cacheHitAlertThreshold` (unset by default) turns on a live `usage/cache-hit-low` event when today's rolling cache-hit share drops below the given fraction (`0`-`1`), after at least `cacheHitAlertMinRequests` (default `20`) billed requests today — a floor that keeps a thin early-day sample from tripping it. The event is edge-triggered: it fires once on a healthy-to-unhealthy crossing, stays silent while the day remains unhealthy, and can fire again after a recovery crosses back down. It is ephemeral (`ctx.emit`, not logged to any session) — a live listener observes it, or a caller re-derives the same rate any time from `summary()`.

```yaml
- name: '@deepseek-ai/dsh-usage-ledger'
  config:
    retentionDays: 90
    writeEveryEvents: 100
    writeIntervalMs: 60000
    cacheHitAlertThreshold: 0.7
    cacheHitAlertMinRequests: 20
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

The ledger derives from the durable session logs and never writes to them: per-session cursors plus child-owned event ranges keep restarts and forks from double-counting, and the single atomic document keeps counters and cursors consistent across crashes. The in-memory counters stay ahead of the medium, so a lost write only costs a longer backfill on the next boot.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `UsageLedger` service: live fold, write-behind, and range summaries |
| [`src/aggregate.ts`](src/aggregate.ts) | Pure fold: sample validation, UTC+7 bucketing, route moves, retention, summaries; its calendar helpers are re-exported from the package root |
| [`src/spec.ts`](src/spec.ts) | The `usage_dashboard` domain declaration |
| [`src/types.ts`](src/types.ts) | Shared range/summary vocabulary |

### Fold flow

`session/event` folds usage samples into step buckets scoped by session; a step's first settled message re-attributes earlier unknown-routed samples; `step/end` retires the bucket and `turn/end` forces a durable write alongside the count/interval throttle. Init opens the domain, adopts its document, and backfills live sessions past their cursors with a fresh cursor read per event, so a live event folded mid-backfill is never counted twice.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Token meter](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md) — the projected-usage design this ledger's validation mirrors.
- [Storage subsystem](../../../docs/subsystems/storage.md) — the domain contract behind the ledger document.
- [Usage dashboard](../../client/ui-usage-dashboard/README.md) — the Sidebar tab reading these summaries.

-----

<a id="model-experience"></a>
## Model Experience

### No model-facing surface

#### What the model sees

Nothing. The package adds no prompt, message, schema, tool, or model call; it folds the durable log and serves one read-only query face on `ctx.usageLedger`.

#### Token effect

Zero. The ledger counts tokens other packages already billed, and it neither assembles a request nor adds content to one.

#### KV Cache effect

No invalidation; the package changes no request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the ledger stops and future work begins.

- **Counts begin at mount** — durable sessions that ended before the ledger first mounts contribute nothing; only live sessions backfill, and only from their cursors.
- **Advisory totals** — skipped unprovable samples under-count by construction; the ledger is not a billing record.
- **Fixed UTC+7 days** — the reporting zone is a product decision, not a deployment choice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The ledger is a one-way fold of the session logs with no independent observation to check against; restarts reconcile through cursors and the atomic document rather than through an invariant.
