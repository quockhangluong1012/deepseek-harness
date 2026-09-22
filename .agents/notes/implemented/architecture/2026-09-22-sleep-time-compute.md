# Agent Note: Sleep-time compute

Status: implemented

English | [中文](2026-09-22-sleep-time-compute.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §25 defines sleep-time compute (mechanism family W): idle time anticipates likely future tasks and precomputes summaries, retrieval structures, and candidate plans, caching reasoning artifacts modeled as an economic optimization of offline cost versus expected future savings plus quality gain. The harness had no durable record of what idle time expects, no cached reasoning artifacts, and no policy saying which precomputation pays back its offline cost — so quiet hours produced nothing and any future precompute would spend blind.

## Decision

One new package, `dsh-evolution-sleeptime`, holding durable anticipated tasks with a derived economic plan over them:

1. **Anticipation is an upserted durable fact.** `anticipate(input)` stores one task per identity with its likelihood, expected queries, and per-query savings; re-anticipating refreshes the expectations in place. `tasks(domain?)` lists likeliest first with task-id ascending tie-break.
2. **Worth is a strict inequality on the expected net.** `expectedNet` weights savings by likelihood and subtracts the estimated offline cost; `decideWorth` needs a strictly positive net, because a zero net spends idle time for nothing. The reason names the numbers, so a `/sleeptime` render never has to explain the arithmetic twice.
3. **The plan is greedy inside the offline budget.** `planFor` keeps worth-it decisions, sorts net descending with task-id ascending tie-break, and takes them while the cumulative estimated cost fits. `plan(cost?, budget?)` defaults both from validated config (`defaultEstimatedCostTokens` 2000, `maxOfflineTokens` 50000) and covers only tasks with no cached artifact yet.
4. **Artifacts account for themselves.** `precompute(input)` caches one artifact per caller-chosen id for a known task — unknown tasks reject loudly — starting at zero hits and zero saved tokens. `hit(artifactId, savedTokens)` accumulates both, so `savingsOf` stays negative until the precompute pays back. The `evolution_sleeptime` domain (v1) holds a `tasks` table and an `artifacts` table; heartbeat-driven anticipation stays deferred and operator-driven.

## Alternatives considered

- Derive the plan from the dreaming cycle's candidates — rejected: dreaming consolidates repeated past observations into memory (§5), while sleep-time bets on likely futures; one reads failures, the other reads likelihoods, and merging them would tangle two different subjects in one schedule.
- Enforce per-kind cost estimates now — rejected: `plan` prices every precompute at one estimated cost; a per-kind cost model is real work that needs measured offline spends first, recorded as a limitation.
- Evict artifacts by value decay at ship — rejected: retention needs lifecycle logic on the domain with no consumer yet; the store accumulates and the gap is documented.

## Consequences

- Idle time is now plannable: `plan()` names exactly which anticipated tasks deserve tonight's offline budget and in which order, so quiet hours stop producing nothing.
- Every cached artifact carries its payback ledger: hits and saved tokens against offline cost, visible through `artifacts()` without any model call.
- The heartbeat has a defined future job: its quiet ticks become the trigger for `anticipate`/`precompute` once wired, with stable caller-chosen artifact ids ready for a driver to derive.

## Deviations from the plan

None beyond routine. The initial draft derived `plan` over all tasks; it now covers only tasks with no cached artifact yet, since re-precomputing a task that already has one is the first waste the budget policy must refuse.

## Fixes found on the way

The zod task row with `scope: z.string().optional()` did not satisfy `AnticipatedTask` under `exactOptionalPropertyTypes`: the inferred `string | undefined` is not assignable to `scope?: string`, so both task interfaces now declare `scope?: string | undefined`. `KvTable.entries()` returns an `IterableIterator` with no `.map`, so the cached-task set spreads first. Test boot passes `{}` explicitly to `ctx.plugin` because Cordis passes `undefined` config to services with a `static Config` schema.

## Testing

Pure helpers: net math including zero likelihood and zero cost, the worth-it boundary at exactly zero with reason content, plan ordering with drops, tie-break, greedy budget fit and overflow, empty plans, savings sign both ways. Store: anticipate upsert/at with and without scope, task order/filter/detached copies, unknown-task precompute throw, artifact filter/order with a frozen-clock tie-break, hit accumulation with unknown throw, plan skipping cached tasks under default and explicit budgets, restart persistence through the zod spec, reads-before-start. 15 pure tests and 9 store tests pass; the new package is at 100% statements/branches/functions/lines on every file under `src/`.

## Left alone

Heartbeat wiring is deferred: anticipation and precomputation are operator-driven, and idle time is planned, not yet automatic (documented in the package's Known Limitations). The store is record-only and never generates artifacts itself. One estimated cost prices every precompute; per-kind costs need a measured cost model. Cached artifacts accumulate with no eviction.
