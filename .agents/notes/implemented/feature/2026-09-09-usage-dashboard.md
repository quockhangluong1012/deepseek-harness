# Agent Note: Usage dashboard tab with Host usage ledger

Status: implemented

English | [中文](2026-09-09-usage-dashboard.zh.md)

## Problem

Operators of the web and desktop surfaces had no product-visible usage accounting: per-session figures existed only as chat-composer pills (`tokenUsage` and `sessionStats` projections), and nothing aggregated billed attempts across sessions by day or by model. Telemetry export is outbound-only and cannot answer local questions, and no storage seam owned cross-session aggregates.

## Decision

Ship two packages, split on the client/host dependency policy:

- `@deepseek-ai/dsh-usage-ledger` (session group) owns the fold and the persistence. Its `ctx.usageLedger` service folds every live session's billed LLM attempts — one provider usage sample on `assistant/message` or `assistant/attempt`, retries included — into a durable ledger on the `usage_dashboard` storage domain and serves range summaries.
- `@deepseek-ai/dsh-client-ui-usage-dashboard` (client group) owns the product surface. Its Host half (`ctx.usageDashboard`) is only the `summary` Remote over the ledger. The surface is split with the [dashboard-split note](2026-09-10-dashboard-split-current-and-all-sessions.md): the browser half keeps a `usage` page type in the right Sidebar (guide entry included) whose body shows only the current session's live header and cumulative stat cards from its projections (no filter, no fetch), and adds a `Dashboard` entry in `sidebar.footer.action` whose overlay shows the cross-session totals — total requests, split input/output tokens, total cache hits, the average cache-hit share, a stacked input/output bar chart by UTC+7 day with a today/7-day/30-day/all filter defaulting to today, and a per-model table.
- One billed attempt is one validated usage sample; unprovable samples are skipped, never zero-filled. Input tokens are billed prompt tokens (`uncached + cacheRead + cacheWrite`); the average cache hit is `cacheRead / billedInput`. Days are fixed to UTC+7. An empty window still draws the chart frame with its no-data line.

The ledger persists as one atomic document (per-day counters, per-day-per-model counters, per-session fold cursors) under `single` layout with `backup-and-skip`, so a crash can persist neither counters without their cursor nor a cursor without its counters. Per-step buckets hold samples until `step/end` and re-attribute unknown-routed samples when the step's settled message arrives; backfill folds only child-owned events past a per-event fresh cursor read, so live events folded mid-backfill are never counted twice and forks never double-count. Writes run write-behind (count/interval throttle plus mandatory `turn/end` and session disposal, the live-to-cold moment) and are fail-soft: a lost write only costs a longer backfill. Process teardown carries no flush of its own — fiber disposers race the domain close — so the tail is covered by disposal writes and cursor-guarded backfill instead.

## Chart without a chart dependency

The stacked bars are hand-drawn SVG. No chart dependency exists anywhere else in the tree, and the dashboard needs stacked bars only; adding one would trade a small, fully covered renderer for a new third-party surface in the client bundle. A richer chart stays a one-file swap, recorded in the package's Known Limitations.

## Alternatives considered

- **One dual-face package holding the fold.** Rejected by `verify-package-dependencies`: a client/host package's Host entry may only value-import classified workspace exports (agents may not add classifications), and neither the stream-sample reader nor the storage-domain declaration is classified. The fold therefore lives in a role-less session package behind `ctx.usageLedger`, and the dashboard's Host entry only delegates through injected services.
- **Per-session projections only, no Host service.** Rejected: `useProjection` reads the current session alone, so cross-session days and the model table are unreachable from the browser. The Host must own the fold.
- **Telemetry/OTel as the dashboard source.** Rejected: the telemetry seam is best-effort outbound reporting with crash loss and no local query face — the wrong durability and direction for a dashboard.
- **Session-query SQLite as the aggregate store.** Rejected: that index is a disposable full-text materialized view owned by search, not a numeric rollup store; sharing it would couple two unrelated consumers to one schema.
- **Per-record tables for days and models.** Rejected: three tables cannot update counters and cursors atomically, and either crash order double-counts or under-counts on the next backfill. The single atomic document keeps the KB-scale ledger consistent.
- **Recharts (or another chart library).** Rejected for v1 for the bundle and gate cost above; the SVG renderer and its geometry helpers carry full unit coverage instead.

## Consequences

The dashboard gives operators totals, daily trends, and per-model breakdowns in the product surface, at the cost of a new Host write path on every committed usage event (throttled, off the model-request path) and one more storage domain under the home directory. Counts begin at mount: durable sessions that ended before the ledger first mounts contribute nothing, which the package README states. The totals are advisory under-counts by construction, never billing records.

## Testing

Ledger behavior rides REAL composition (SessionStore, storage stack): live folding with route moves and unknown routes, retries counting, cursor-guarded backfill without double-counting, fork exclusion, restart retention through the stored document, interval-timer flushes, and fail-soft writes that keep serving memory state. Pure coverage pins sample validation, UTC+7 bucketing, retention sweeps, and range summaries. The dashboard face spec pins the Remote delegation; client specs pin the store, the generation-guarded face, the type registration, the Remote binding, the display helpers, the session-only panel, and the overlay across loading, failure/retry, empty-frame, filter-switch, and open/close states.
