# Agent Note: Evolution metric layer

Status: implemented

English | [中文](2026-09-22-evolution-metric-layer.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §55 names the harness's true north-star metric — capability gain divided by the compute that bought it — and lists nine supporting metrics (learning velocity, failure recurrence, skill incremental utility, memory utility, benchmark robustness, regression debt, promotion quality, rollback rate, evaluator reliability). Nothing computed any of them. Every input was already durable, and eleven evolution stores had been built to record it, but no package divided one by another, so the group could report what each store held and never whether the system was improving per unit of compute spent.

Three facts made the layer harder than a sum:

1. **One run's cost is recorded three times.** A staged write records the winning candidate's evaluation in `evolution_meta.runs`, the same triple for the same write in `evolution_router.outcomes`, and a run-cumulative sum over every evaluated variant in `evolution_budget.spends`. Any two of the three added together report two to three times the compute actually spent.
2. **No metrics existed as a seam.** `ctx.evolutionMetrics` was undefined, so no command could report a metric even if one were computed.
3. **Four of the nine supporting metrics have no input anywhere.** No store pairs a skill-using run with a run that used no skill, no record counts a memory recall hit or links it to an outcome, no record scores a benchmark task, and no monetary field exists in any evolution record.

## Decision

Add one read-only package, `packages/evolution/evolution-metrics` (`ctx.evolutionMetrics`), and one command verb, `/metrics`.

1. **No domain, no state.** Every value derives on read from stores other packages already write, so the layer cannot drift from its inputs, and the report is always the current state of those stores.
2. **One recorded source per metric, and no arithmetic across scopes.** The north star reads `evolution_meta.runs` alone — the only record carrying the pass and the cost of the same run — and divides the window's newer-half pass rate minus its older-half pass rate by the tokens, the compute hours, and the elapsed days of the whole window. The compute the search spent on every evaluated variant is reported as `compute-overhead-ratio` instead of being folded into a denominator it does not match.
3. **A metric other packages already compute is read, not recomputed.** Regression debt is the curator's own table, rollback rate is the canary's own state counts, evaluator reliability is the health summary's own rates, failure recurrence is the feedback store's own per-merge-key session counts.
4. **An unmeasurable metric names the record that is missing.** `MetricValue.value` is `null` exactly when the input does not exist, with `unavailableReason` naming the record, and a `caveat` on every measured value saying what it does not tell you. The report always carries the whole §55 set, so one command answers for every metric.
5. **Mount it in the product profile and classify it in both catalog generators**, as every other evolution service is.

## Alternatives considered

- **A durable metrics domain, snapshotting each report.** Rejected: every input is already durable and every value is a pure function of it, so a second copy would be a second thing to keep in sync, with the same staleness failure the store family exists to avoid. Nothing here needs history a store does not already keep.
- **Taking the compute denominator from `evolution_budget.spends`**, the only store that counts every evaluated variant. Rejected as the north star's denominator — the capability numerator is a pass rate over staged runs from a different store, so the ratio would silently mix two scopes and two coverages. Kept as its own explicitly-named ratio, where the mismatch is the measurement.
- **Summing the run's three cost records and calling it the true cost.** Rejected: they are a duplicate and a superset, not three contributions; summing them overstates spend by two to three times and would have made the north star's denominator meaningless.
- **A dollar denominator backed by a configured price per token.** Rejected: no evolution record holds a monetary field, and `evolution-budget` and `evolution-router` both state they deliberately assume no pricing source. A configured price would make the north star depend on a number the harness never measured, so dollars are reported as unmeasurable with that reason instead.
- **Adding per-task outcome recording to make benchmark robustness and skill incremental utility measurable.** Rejected as scope: that is a recording change in other packages (`evolution-benchmark`, the scorer, the canary), and this layer's job is to report the gap precisely enough that the owner of each store can close it. Both entries name the exact record that is missing.
- **Reporting a zero for an unmeasurable metric.** Rejected: it makes "nothing improved" indistinguishable from "nothing was measured", which is the failure mode the north star exists to prevent.

## Consequences

- `/metrics [<taskClass>]` reports the window, the two half-rates it compared, the two north-star denominators, and all ten supporting metrics, each as `- <id>: <value> — <caveat>` with its source stores, or `- <id>: not measured — <reason>`.
- The layer reads its sources when `report()` runs, not at mount, so it imposes no mounting order and reports each unmounted store as the reason for the metrics that need it. In the product profile every source store is already mounted, so a reading is available as soon as the stores have records.
- Four of the twelve entries are permanently unmeasurable until another package records their input; the tests assert both that they report the gap and that the gap names the missing record rather than a store.
- The catalog gates now carry the layer's vocabulary: six type-link exemptions, one service page entry, and one service-role row. A new exported type in the signature fails `gen-cordis-catalog` until it is classified, like every other evolution package.

## Deviations from the plan

The plan was the ranked remainder of the previous batch's gap audit, which put this block first because it is the only one of the remaining items that measures the other five rather than changing what the engine does: §55's own rule is that a system creating a hundred skills for a one-percent gain is worse than one creating five for twenty percent, and no command could answer which one this is. The remaining ranked items (the record-only loops' missing consumers, the per-task outcome records, the dreaming attribution gate, the claim graph, the retriever seam) are untouched.

## Fixes found on the way

- `packages/evolution/evolution-canary/src/index.ts` did not compile at HEAD: `Object.fromEntries(...)` produced `{ [k: string]: number }`, which is not assignable under `noUncheckedIndexedAccess`, so `tsc -b` failed for the package and for every project referencing it. Replaced with `DEPLOYMENT_STATES.indexOf(...)`, which drops the map allocation and sorts identically. This was blocking the new layer's own build, which is why it was fixed here rather than reported.
- The same `Object.fromEntries` lookup pattern still fails in `evolution-model-routes` and `evolution-router`, and `evolution-optimizer` fails on an `exactOptionalPropertyTypes` mismatch at its capability observation. All three are committed and untouched by this change; the first two are the same mechanical one-line fix, and the optimizer's needs its owner to decide whether an absent failure is `undefined` or omitted.

## Testing

`packages/evolution/evolution-metrics/tests/metrics.spec.ts` covers the arithmetic without a context (the half split giving the newer side the odd run, the two divisions that must refuse a zero denominator, and each compute-denominator scaling), then boots real stores for the behaviour that matters: a six-run window whose older half passes once in three and whose newer half passes three times, asserting the window, both denominators, and the velocity against hand-computed values; the two-run-per-half evidence floor withholding a gain while the window still reports the runs; and the search-overhead ratio measured across `evolution-meta` and `evolution-budget` together. The unmeasurable path boots the layer with nothing mounted and asserts all twelve ids are present, every value is null, every reason is non-null, and the four unrecorded metrics name a missing record rather than a missing store. The supporting metrics are read through stub stores for canary, lineage, curator, evaluator health, telemetry, and feedback. 9 tests pass in the package.

`verify-cordis-config` passes 144 config files, `constraints` passes, and the four generators (`gen-config-catalog`, `gen-cordis-catalog`, `gen-doc-graphs`, `gen-module-graph`) run clean and are idempotent.

## Left alone

The layer measures; it does not act on what it measures. No threshold, alert, or automated rollback was added, and no metric changes what the optimizer runs. The four unmeasurable metrics stay unmeasurable rather than being approximated: per-task outcomes, a no-skill baseline arm, recall-hit counting, and a price table are recording decisions in the packages that own those stores. The metric window's `limit` and the supporting metrics' host-wide scope are documented as current constraints rather than fixed, because widening them needs keys the underlying records do not carry.
