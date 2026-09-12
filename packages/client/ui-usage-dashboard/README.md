---
description: "Usage dashboard right-Sidebar tab and its Host usageDashboard Remote face over the usage ledger."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-usage-dashboard

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-usage-dashboard` shows billed LLM usage in two surfaces. The left-sidebar **Dashboard** entry opens an overlay with cross-session totals: the today/7-day/30-day/all filter, total requests, input/output tokens, cache hits, the average cache-hit share, a stacked input/output bar chart by day (UTC+7) whose columns show that day's input and output totals on hover, and a per-model table. The right-Sidebar `usage` tab keeps the current session only: its live header and cumulative cards read the session's `tokenUsage` and `sessionStats` projections with no filter and no Remote fetch. The Host half serves range summaries over the `usageDashboard` Remote from the usage ledger.

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

The all-sessions overlay opens from the left sidebar's Dashboard entry. No configuration is required on the browser half. The Host half takes no configuration either: it delegates to `ctx.usageLedger`, which owns the three durability choices. Mount both rows:

```yaml
- id: usage-ledger
  name: '@deepseek-ai/dsh-usage-ledger'
  config:
    retentionDays: 90
    writeEveryEvents: 100
    writeIntervalMs: 60000
- id: ui-usage-dashboard
  name: '@deepseek-ai/dsh-client-ui-usage-dashboard'
```

One billed attempt is one provider usage sample on an `assistant/message` or `assistant/attempt` event — retries count, because each sample represents tokens a previous request already spent. Input tokens are billed prompt tokens (`uncached + cacheRead + cacheWrite`); the average cache hit is `cacheRead / billedInput`. Days are fixed to UTC+7. An empty window still draws the chart frame with its no-data line.

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
- id: ui-usage-dashboard
  name: '@deepseek-ai/dsh-client-ui-usage-dashboard'
```

The ledger persists as one atomic document on the `usage_dashboard` domain (`single` layout, `backup-and-skip`): per-day counters, per-day-per-model counters, and per-session fold cursors. Retries that settle in the same step attribute to that step's message route; steps that never settle attribute to the unknown route.

### Reading the numbers

Totals are advisory, not billing records: unprovable samples are skipped, never zero-filled. Counts begin when the ledger first mounts — sessions that ended before that contribute nothing until they run again.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design philosophy

The browser half holds no accounting: cross-session figures arrive from the Host ledger over the Remote, and the session header reads the current session's projections. The Host face delegates to `ctx.usageLedger`, which owns the fold, the cursors, and the write policy — this package's Host entry holds no storage imports of its own, which keeps it inside the client/host dependency policy.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `UsageDashboard` service: the `summary` Remote over the ledger |
| [`src/client/index.ts`](src/client/index.ts) | Browser half: current-session tab-type and body plus the all-sessions footer action |
| [`src/client/DashboardAction.tsx`](src/client/DashboardAction.tsx) | Left-sidebar trigger row and all-sessions overlay dialog |
| [`src/client/display.tsx`](src/client/display.tsx) | Shared count formatting, chart geometry, and summary body |
| [`src/client/UsageDashboard.tsx`](src/client/UsageDashboard.tsx) | Current-session panel: live header and cumulative cards |
| [`src/client/store.ts`](src/client/store.ts) | Per-tab filter range and fetched summaries |
| [`src/client/face.ts`](src/client/face.ts) | Generation-guarded summary fetch |
| [`src/client/definition.ts`](src/client/definition.ts) | The `usage` page-type definition |

### Fold flow

The fold lives in `@deepseek-ai/dsh-usage-ledger`: `session/event` folds usage samples into step buckets scoped by session; a step's first settled message re-attributes earlier unknown-routed samples; `step/end` retires the bucket and `turn/end` forces a durable write alongside the count/interval throttle.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Token meter](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md) — the projected-usage design the ledger's validation mirrors.
- [Usage ledger](../../session/usage-ledger/README.md) — the durable counters and fold behind the `summary` Remote.
- [Slots reference](../../../docs/subsystems/slots.md) — the two-stage tab registration this package follows.

-----

<a id="model-experience"></a>
## Model Experience

### No model-facing surface

#### What the model sees

Nothing. The package adds no prompt, message, schema, tool, or model call; the Host half folds the durable log and serves the read-only `usageDashboard` Remote, and the browser half renders it.

#### Token effect

Zero. The dashboard reads counters other packages already billed, and it neither assembles a request nor adds content to one.

#### KV Cache effect

No invalidation; the package changes no request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define where the dashboard stops and future work begins.

- **Counts begin at mount** — durable sessions that ended before the ledger first mounts contribute nothing; only live sessions backfill, and only from their cursors.
- **Advisory totals** — skipped unprovable samples under-count by construction; the ledger is not a billing record.
- **Hand-drawn chart** — the stacked bars are dependency-free SVG; a column's hover band and totals bubble are hand-built too, so a chart library swap stays a one-file change if richer interactions are ever needed.
- **Fixed UTC+7 days** — the reporting zone is a product decision, not a deployment choice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The ledger is a one-way fold of the session logs with no independent observation to check against; restarts reconcile through cursors and the atomic document rather than through an invariant.
