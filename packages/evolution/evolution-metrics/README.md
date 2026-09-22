---
description: "Evolution metrics: capability gain per unit of compute and the supporting set, read from the evolution stores (ctx.evolutionMetrics)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-metrics

English | [中文](README.zh.md)

## Summary

`dsh-evolution-metrics` measures whether the evolutionary harness is getting better. Its north-star metric is capability gain per unit of compute — a pass-rate delta over tokens or compute hours those runs spent. The supporting metrics answer what it raises: how fast gain accumulated, what the search spent, whether failures recur, open regression debt, the value of recalled memory, and how promotions, rollbacks, and the evaluator ensemble held up.

It never writes or calls a model; values come from stores other packages record, and missing records report unmeasurable, never zero, so "nothing improved" stays distinct from "nothing was measured".

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

Mount the plugin; it needs no storage domain and injects nothing. One call returns the whole report, optionally restricted to one task class.

```ts
const report = ctx.evolutionMetrics.report({ taskClass: 'writer' })

report.window        // runs, from, to, and the two half-rates the gain compares
report.northStar     // one entry per compute denominator
report.supporting    // the ten supporting metrics
```

Every entry is the same shape: `value` (a number, or `null` when it is not computable), `unit`, `inputs` (the exact store, read path, and fields it came from), `unavailableReason` (why it is not computable, `null` when measured), and `caveat` (what the number does not tell you, `null` when the measurement is complete).

| Metric | Measured from | Meaning |
|---|---|---|
| `capability-gain-per-million-tokens` | `ctx.evolutionMeta.runs()` | Pass-rate gain of the window's newer half over its older half, per million tokens the window spent. |
| `capability-gain-per-compute-hour` | `ctx.evolutionMeta.runs()` | The same gain per hour of scorer-summed wall time. |
| `learning-velocity` | `ctx.evolutionMeta.runs()` | The same gain per elapsed day of the window. |
| `compute-overhead-ratio` | `ctx.evolutionBudget.spends()`, `ctx.evolutionMeta.runs()` | Tokens the search spent over the tokens the winning runs measured. |
| `failure-recurrence` | `ctx.evolutionFeedback.signals()`, `ctx.evolutionSkillTelemetry.entries()` | Share of observed failures seen in more than one session. |
| `regression-debt` | `ctx.evolutionCurator.debt()` | Failures still open after a curator pass. |
| `promotion-quality` | `ctx.evolutionLineage.experiments()` | Share of recorded experiments whose candidate improved. |
| `rollback-rate` | `ctx.evolutionCanary.summary()` | Share of deployments that went live and were then rolled back. |
| `evaluator-reliability` | `ctx.evolutionEvaluatorHealth.summary()` | Share of evaluator verdicts that were not later contradicted. |
| `skill-incremental-utility` | — | Not measurable: no store pairs a skill-using run with a run that used no skill. |
| `memory-utility` | `ctx.evolutionMemory.recallUtility()` | Mean §24 utility of the recalled memories in the recall ledger: `relevance × decision impact × outcome gain`. |
| `benchmark-robustness` | — | Not measurable: no record scores a benchmark task. |

### Configuration

The layer's deployed choices, validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `windowRuns` | `200` | Newest engine runs one report covers when the query sets no limit. |
| `minimumRunsPerHalf` | `2` | Runs each half of the split needs before a gain is reported. |
| `maxSignals` | `50` | Failure signals one recurrence reading covers. |

The query narrows the window further: `taskClass` restricts it to one class, `since`/`until` bound it by recorded instant (inclusive), and `limit` caps it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One recorded source per metric, and no arithmetic across sources that describe different scopes.

A single engine run's cost is durable in three places: `evolution_meta.runs` (the winning candidate's own evaluation, with the pass, the cost, and the instant of the same run), `evolution_router.outcomes` (the same triple for the same staged write), and `evolution_budget.spends` (a run-cumulative sum over every variant the batch evaluated, so a superset of the other two). Adding any two of them would report two to three times the compute spent, so the north star reads `runs` alone — the only one that carries the pass and the cost of the same run — and the extra cost the search paid is reported as `compute-overhead-ratio` instead of being folded into the denominator.

Capability is the recorded pass rate: the window's runs, oldest first, split into an older and a newer half, and the gain is the newer half's pass rate minus the older half's. An odd count gives the newer half the extra run, so the treatment side never sees less evidence than the baseline. The same gain then divides by the tokens, the compute hours, and the elapsed days of the whole window, which is why every north-star entry shares one numerator and differs only in what it is measured against.

A metric that other packages already compute is read, not recomputed: regression debt is the curator's own table, rollback rate is the canary's own state counts, evaluator reliability is the health summary's own rates. The layer adds arithmetic only where no store answers the question — the window split, the two denominators, and the search-overhead ratio.

### Failure and recovery

A source store that is not mounted makes its metrics unmeasurable with the missing store named, and the report still carries the whole metric set, so one command answers for every metric in the specification. Sources are resolved when `report` runs, not at mount, so the layer never constrains the order its sources mount in.

No domain is opened and nothing is durable, so no invariant companion is published: there is no second independent observation of a value that is derived on every read.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §55 — the north-star metric and the supporting set this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-meta`](../evolution-meta/README.md) — the run, cost, and instant the capability gain is measured over.
- [`dsh-evolution-budget`](../evolution-budget/README.md) — the batch spends the search-overhead ratio reads.
- [`dsh-evolution-curator`](../evolution-curator/README.md) — the regression debt and the failure signals behind it.
- [`dsh-evolution-canary`](../evolution-canary/README.md) — the deployment states the rollback rate counts.
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.md) — the verdict summary the reliability reading comes from.

-----

<a id="model-experience"></a>
## Model Experience

None, as this layer registers nothing model-facing. `/metrics` reports to the operator; no metric enters a prompt, a tool result, or a session event.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the numbers do and do not mean. They are current package constraints.

- **Every run-derived metric is conditioned on the promoted path** — the optimizer records a run when a candidate staged, and records nothing for a rejection, a failed holdout, or a truncated batch. A pass rate here is the share of staged attempts that passed, not a capability level, and no recorded series answers "how often does a change fail to improve anything".
- **No per-task outcome exists** — nothing durable stores whether an individual task, benchmark case, or test passed. `benchmark-robustness`, `skill-incremental-utility`, and per-task regression debt are consequently unmeasurable, and each names the record that would make it computable.
- **Memory utility records three of §23's links and three of §24's factors** — retrieval, the decision batch that followed, and a caller-supplied outcome are recorded, so the reading is real; whether an injected item was *used* or *cited*, and §24's source-quality factor, have no recorded source. The number is therefore a floor, and its caveat names each missing link rather than reporting it as zero.
- **No dollar cost exists** — `evolution-budget` and `evolution-router` deliberately assume no pricing source, so compute is measured in tokens and wall time only. A dollar denominator needs a price table the harness does not have.
- **Only run-derived metrics take a time bound** — `since`, `until`, and `taskClass` filter the engine-run window. The supporting metrics are current-state readings of host-wide stores: a canary summary or a debt table has no task-class key to filter by, and the two counter stores (`evolution-operators`, `evolution-evaluator-strategy`) keep only `lastAt`, so no window can be reconstructed from them at all.
- **Search overhead spans two scopes by construction** — the ratio compares a run-cumulative spend against winner-only tokens. It measures how much compute bought the winners, and it must never be added to either side.
- **The evaluator reliability reading is an inter-verdict proxy** — the health store compares one verdict against a later one, not against a human outcome.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The window is built from `ctx.evolutionMeta.runs()`, whose records are stamped with `toISOString()`, so the `since` and `until` bounds compare as strings; the ordering is chronological because every recorded instant has the same format and zone. `runs()` returns newest first, so the window slices the newest `limit` rows and reverses them before splitting — the split is by position in time, not by count of passes.

Reasons and caveats are carried by the service rather than written by the command, matching the other evolution stores, whose records already carry a `reason` string. `/metrics` renders them, so the layer's honesty about a number travels with the number.

When the stores start recording what this layer cannot measure — a per-task outcome, a no-skill baseline arm, a recall-hit counter — the entry changes from `unavailable(...)` to `metric(...)` in one place, and the metric id stays stable for callers.

</details>
