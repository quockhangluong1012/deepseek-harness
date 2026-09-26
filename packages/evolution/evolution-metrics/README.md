---
description: "Evolution metrics: capability gain per unit of compute and the supporting set, read from the evolution stores (ctx.evolutionMetrics)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-metrics

English | [中文](README.zh.md)

## Summary

`dsh-evolution-metrics` measures whether the evolutionary harness is getting better: its north-star metric is capability gain per unit of compute, a pass-rate delta over the cost, tokens, or hours those runs spent, and supporting metrics cover gain rate, spend, recurring failures, regression debt, recalled-memory value, and the outcome of promotions, rollbacks, and the evaluator ensemble.

It never calls a model: values come from stores other packages record, and a missing record reports unmeasurable, never zero.

Six further read models cover what those runs left behind: `coding`, `research`, `mentor`, `longHorizon`, `uncertainty`, `selfModel`. This layer owns that surface, not the records.

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
| `capability-gain-per-cost-unit` | `ctx.evolutionMeta.runs()`, `ctx.evolutionBudget.spends()` | The same gain per unit of cost the window's own runs were billed. Unmeasurable unless every run's batch recorded a priced spend. |
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
| `benchmark-robustness` | `ctx.evolutionBenchmark.outcomes()` | Share of executed benchmark tasks whose recorded run passed. Unmeasurable until a run pass records an outcome. |

The §13.2 coding set is folded from recorded session logs, the same records the kernel counters and the trace projection are built from, and the §5.4 baseline readings come from that same window. The last seven rows are the §18.3 kernel counters, read from that same fold: the task, verification, run, policy, approval, and checkpoint families §18.3 asks for that no §13.2 or §5.4 reading expresses. `run.wall_ms` and `run.cost_usd` are the `latency` and `cost` rows above, `subagent.success_rate` is the complement of `subagent-waste`, `memory.recall_utility` and `skill.utility` are `memory-utility` and `skill-incremental-utility`, and `evolution.capability_gain_per_compute` is the north star. `context.compactions`, `sandbox.denied`, and `workflow.resume_success` are not kernel counters, so no reading here names them.

```ts
const coding = await ctx.evolutionMetrics.coding({ since: '2026-01-01T00:00:00.000Z' })

coding.window     // sessions, from, to
coding.metrics    // verified success, false completion, regression, recovery, planning,
                  // verification coverage, human intervention, cost, latency, loop rate,
                  // tool failure rate, subagent waste, context utilization, average tokens,
                  // and the three verified-success ratios
```

| Metric | Measured from | Meaning |
|---|---|---|
| `cost` | `assistant/message.usage`, `usdPerMillionTokens` | Billed dollars per session at the deployment's one flat price, cache traffic included. Unmeasurable when no price is configured or no usage was reported. |
| `average-tokens` | `assistant/message.usage` | Billed input, cache, and completion tokens per session: the token side of the same spend. |
| `loop-rate` | `readKernelMetrics().failuresByKind`, `.tasksCreated` | Share of the window's task-opening sessions that recorded a `no-progress` or `stalled` failure, the two kinds the trace projection reads as `loop_detected`. Session-scoped: the counters do not pair a failure with the run it ended. |
| `tool-failure-rate` | `readKernelMetrics().toolCalls`, `.actionsFailed` | Share of recorded tool calls whose own settle receipt reported `failed`. |
| `subagent-waste` | `delegation/received`, `readKernelMetrics().taskOutcomes` | Share of delegated child runs whose receiving session reached no `completed` task status. |
| `context-utilization` | `assistant/message.usage`, `request/context.contextWindow` | Largest prompt side one settled message reported, cache traffic included, over the newest window the session advertised. |
| `verified-success-per-usd` | the window's certified completions, its priced spend | Certified completions per dollar of billed spend. Unmeasurable at zero spend, never reported as an infinite ratio. |
| `verified-success-per-million-tokens` | the window's certified completions, its billed tokens | Certified completions per million billed tokens. |
| `verified-success-per-10-minutes` | the window's certified completions, its closed turns | Certified completions per ten minutes of summed closed turns. |
| `task-success-rate` | `readKernelMetrics().taskOutcomes` | Share of the window's tasks that reached a terminal status and completed. The certified share of the same denominator is `verified-success`. |
| `verification-pass-rate` | `readKernelMetrics().verifications` / `.verificationsPassed` | Share of recorded verification results whose status was `pass`. A status of neither `pass` nor `fail` moves neither side. |
| `steps` | `readKernelMetrics().steps` | Model steps (`step/start`) the window's logs recorded. |
| `tool-calls` | `readKernelMetrics().toolCalls` | Every `tool/call` the window recorded, including a call no action ever settled. |
| `policy-denials` | `readKernelMetrics().policyDenied` | Composed policy decisions whose effect was `deny`. A capability refusal and a sandbox refusal both arrive as one decision, so the two families are not separable. |
| `approval-rejections` | `readKernelMetrics().approvalsRejected` | Human answers that were not `allowed-once`. The prompts behind them are the `human-intervention` rate. |
| `checkpoint-resume-rate` | `readKernelMetrics().checkpoints` / `.checkpointResumes` | Share of recorded checkpoints that were resumed. The counters do not pair a resume with the checkpoint it resumed. |

The §13.3 research set reads the runs `ctx.research` recorded next to the claims and observations their sessions logged. Its window is a run window: `runs`, `sessions`, `from`, and `to`, narrowed by `sessionId`, `since`/`until` on the instant a run settled (else started), and `limit`. Every metric is a share.

```ts
const research = await ctx.evolutionMetrics.research({ sessionId })

research.window   // sessions, runs, from, to
research.metrics  // the seven §13.3 metrics, in spec order
```

| Metric | Measured from | Meaning |
|---|---|---|
| `claim-accuracy` | `claim/updated`, run stages | Share of the claims the runs asserted that evidence settled and that held up: `supported` over `supported`, `contradicted`, and `rejected`. |
| `source-quality` | `evidence/recorded`, `claim/updated` | Share of the observations the window's claims cite whose recorded trust is `trusted`. |
| `evidence-coverage` | run answers, claims, observations | Share of a settled answer's documented, observation, interpretation, and inference statements that rest on a claim citing at least one observation. |
| `contradiction-recall` | run stages | Share of the runs that asserted a claim whose `contradiction-search` stage settled `produced`. |
| `uncertainty-calibration` | `claim/updated` | Share of the settled claims whose recorded confidence agreed with their recorded status at the half-confidence split. |
| `citation-correctness` | run answers, `claim/updated` | Share of the answer's citations that name a claim the run recorded as `supported`. |
| `unsupported-claim-rate` | `claim/updated` | Share of the claims the window's runs asserted that cite no observation. |

The §13.4 mentor set reads one learner's durable record (`ctx.learnerModel`) and the misconception cycles recorded for them (`ctx.misconception`). Its query names the learner, because neither store lists them.

```ts
const mentor = ctx.evolutionMetrics.mentor({ learnerId })

mentor.learnerId  // the learner the report covers
mentor.metrics    // the six §13.4 metrics, in spec order
```

| Metric | Measured from | Meaning |
|---|---|---|
| `misconception-detection` | learner record | Share of the learner's reviewed cases a recorded misconception names in its `caseIds`. |
| `explanation-quality` | recorded cycles | Share of the recorded cycles that moved past the explain stage, whose only recorded completion is a caller's `delivered` observation. |
| `exercise-relevance` | cycles, learner record | Share of the cycles that assigned an exercise whose misconception the record counts as recurring. |
| `learning-improvement` | learner record | Share of the recorded per-concept case impacts that strengthened the concept. |
| `retention` | learner record | Share of the judgements that followed a strengthening and did not weaken the concept again. |
| `repeated-mistake-reduction` | learner record | Share of the misconceptions the record counts as recurring that stand `resolved`. |

The §13.5 long-horizon set reads the durable outcome `ctx.evolutionBenchmark.run()` records for every benchmark task it executes. Its window is an outcome window: `tasks`, `scored`, `failed`, `from`, and `to`, narrowed by `since`/`until` on the instant the outcome was recorded and capped by the newest `limit` (else `maxOutcomes`).

```ts
const horizon = ctx.evolutionMetrics.longHorizon()

horizon.window   // tasks, scored, failed, from, to
horizon.tiers    // one entry per horizon tier: 10, 20, 50, and the open-ended 100+
```

Each tier carries the five axes §13.5 requires, in spec order:

| Metric | Axis | Meaning |
|---|---|---|
| `benchmark-robustness` | success | Share of the tier's verdict-producing outcomes whose run passed. |
| `verification-coverage` | process discipline | Share of them whose run recorded a verification of its own work. |
| `recovery-efficiency` | recoveries | Share of the failures they recorded that a recovery decision answered. |
| `context-pressure` | context pressure | Highest share of its context window any run in the tier reached, over the runs that reported both sides. |
| `cost` | budget usage | Billed tokens per task, summed over the tier's outcomes. |
| `latency` | budget usage | Wall time per task, summed the same way. |

The facts behind those readings are folded once, when a run is recorded: [`dsh-evolution-benchmark`](../evolution-benchmark/README.md)'s run pass folds the kernel's own counters and the token meter's own context-pressure projection over the sessions each attempt harvested, so this layer only aggregates what the outcome row already holds.

The §43 uncertainty read model presents the evaluation-task queue [`dsh-evolution-uncertainty`](../evolution-uncertainty/README.md) derives from its durable signals. The query narrows the queue by `skill` and caps it with `limit`; the window reports `tasks`, `signals`, and the `topPriority` of the queue's first row. The store groups and ranks the queue, so this report never re-derives either.

```ts
const queued = ctx.evolutionMetrics.uncertainty({ skill: 'writer' })

queued.window   // skill, tasks, signals, topPriority
queued.metrics  // queue depth and the corroborated share
```

| Metric | Measured from | Meaning |
|---|---|---|
| `uncertainty-queue-depth` | `ctx.evolutionUncertainty.queue()` | Evaluation tasks the store's queue holds, each one or more grouped signals waiting to be re-evaluated. |
| `uncertainty-corroboration` | `ctx.evolutionUncertainty.queue()` | Share of the queued tasks more than one of the five §43 kinds flagged, whatever signal count each kind contributed. |

The §42 self-model read model presents the capability frontier [`dsh-evolution-self-model`](../evolution-self-model/README.md) ranks from its durable per-capability entries. The window reports `skills` (how many assessments the store holds) and `capabilities` (how many entries the frontier ranks); the store ranks, so this report never re-derives the order.

```ts
const self = ctx.evolutionMetrics.selfModel()

self.window   // skills, capabilities
self.metrics  // the frontier's mean pass rate and its weakest entry's
```

| Metric | Measured from | Meaning |
|---|---|---|
| `self-model-frontier-pass-rate` | `ctx.evolutionSelfModel.gaps()` | Unweighted mean of the frontier's running pass rates, so a capability backed by two observations counts as much as one backed by twenty. |
| `self-model-weakest-pass-rate` | `ctx.evolutionSelfModel.gaps()` | Running pass rate of the capability the frontier ranks first, which is what `nextToLearn()` returns. |

### Configuration

The layer's deployed choices, validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `windowRuns` | `200` | Newest engine runs one report covers when the query sets no limit. |
| `minimumRunsPerHalf` | `2` | Runs each half of the split needs before a gain is reported. |
| `maxSignals` | `50` | Failure signals one recurrence reading covers. |
| `maxSessions` | `200` | Newest sessions one coding report reads, and covers when its query sets no limit. |
| `maxOutcomes` | `200` | Newest benchmark outcomes a long-horizon report covers when its query sets no limit. |
| `usdPerMillionTokens` | none | Flat price of one million billed tokens in USD. Unset leaves every dollar reading over a coding window unmeasurable. |

The query narrows the window further: `taskClass` restricts it to one class, `since`/`until` bound it by recorded instant (inclusive), and `limit` caps it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One recorded source per metric, and no arithmetic across sources that describe different scopes.

A single engine run's cost is durable in three places: `evolution_meta.runs` (the winning candidate's own evaluation, with the pass, the cost, and the instant of the same run), `evolution_model_routes.evidence` (the same triple for the same staged write), and `evolution_budget.spends` (a run-cumulative sum over every variant the batch evaluated, so a superset of the other two). Adding any two of them would report two to three times the compute spent, so the north star reads `runs` alone — the only one that carries the pass and the cost of the same run — and the extra cost the search paid is reported as `compute-overhead-ratio` instead of being folded into the denominator.

The billed-cost denominator is the same runs again, so it is not a second scope: a run is recorded under the batch identity its producer spends against, so the cost of a run is the spend its own batch recorded. That reading is strict about partial bills — a window whose runs did not all record a spend, or whose spends left `cost` unset, reports unmeasurable and names the gap, because a partial sum would divide the gain by less compute than produced it. Cost is the deployment's own unit; it is dollars only where the deployment bills in dollars.

Capability is the recorded pass rate: the window's runs, oldest first, split into an older and a newer half, and the gain is the newer half's pass rate minus the older half's. An odd count gives the newer half the extra run, so the treatment side never sees less evidence than the baseline. The same gain then divides by the cost, the tokens, the compute hours, and the elapsed days of the whole window, which is why every north-star entry shares one numerator and differs only in what it is measured against.

A metric that other packages already compute is read, not recomputed: regression debt is the curator's own table, rollback rate is the canary's own state counts, evaluator reliability is the health summary's own rates. The layer adds arithmetic only where no store answers the question — the window split, the three denominators, and the search-overhead ratio.

**The layer owns the read-model surface, not the records.** Every metric the harness reports is presented here, and the stores behind the evaluator-health, uncertainty, and self-model read models keep their own versioned durable domains and their own writers: `evolution_evaluator_health`, `evolution_uncertainty`, and `evolution_selfmodel` do not move here, because a stateless consumer that opened a domain would have to own the write that fills it, and this layer writes nothing. What moves is the presentation. `evaluator-reliability` was already a supporting row; `uncertainty` and `selfModel` add the queue and the frontier, each reading the store the host already mounted. The control loops keep calling the stores they drive behaviour from — `evolution-actuator` drains the queue, and `command-evolution`'s self-model and uncertainty commands read the frontier and the queue — because presenting a metric and driving a loop are different jobs, and routing a control loop through a metrics layer would invert the dependency. The kernel counters were the same shape of consolidation: `readKernelMetrics` stays the kernel's pure fold, and the §18.3 families no other reading expresses are presented over the coding window that already folds it.

The later sets apply the same rule to the records the work left. The research window is a run window: `ctx.research.runs()` names the runs, each of their sessions is opened once and folded into the claim and observation records the runs' references resolve through, and a session's claims enter the metric set only through the stages of its runs — so the set measures recorded research, not every claim a session recorded. The mentor report reads one learner because the learner record has no roster: the report names the learner it covers, and both of its stores are read synchronously. The §13.5 report reads a record this group's sibling writes: the benchmark run pass records one outcome per executed task, each already folded from that run's own sessions, so `longHorizon` opens no session log — it windows the durable rows and aggregates them per horizon tier.

### Failure and recovery

A source store that is not mounted makes its metrics unmeasurable with the missing store named, and the report still carries the whole metric set, so one command answers for every metric in the specification. Sources are resolved when `report` runs, not at mount, so the layer never constrains the order its sources mount in.

The later sets follow the same rule at a finer grain. An unmounted research controller, session store, learner model, misconception engine, or benchmark store leaves only the metrics that read it unmeasurable with that store named: a research report with no session store still carries the run window it read, a mentor report whose engine is missing still measures detection, improvement, retention, and reduction from the learner record, and a long-horizon report whose benchmark store is missing still names the store rather than reporting four empty tiers as zeros. A store that is mounted but holds nothing for the query is reported as the empty record it is, never as a zero.

The two read models added last degrade the same way. With no uncertainty store mounted, `uncertainty()` still returns both readings with the store named and an empty queue; with a mounted store holding no signal it returns a measured zero tasks and a corroborated share that names the record it needs. With no self-model store mounted, `selfModel()` names that store for both readings; a mounted store with no capability entry names the observation that would have ranked one.

No domain is opened and nothing is durable, so no invariant companion is published: there is no second independent observation of a value that is derived on every read.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §55 — the north-star metric and the supporting set this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-meta`](../evolution-meta/README.md) — the run, cost, and instant the capability gain is measured over.
- [`dsh-evolution-budget`](../evolution-budget/README.md) — the batch spends the cost denominator and the search-overhead ratio read.
- [`dsh-evolution-benchmark`](../evolution-benchmark/README.md) — the run pass whose durable task outcomes the §13.5 report and `benchmark-robustness` read.
- [`dsh-evolution-curator`](../evolution-curator/README.md) — the regression debt and the failure signals behind it.
- [`dsh-evolution-canary`](../evolution-canary/README.md) — the deployment states the rollback rate counts.
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.md) — the verdict summary the reliability reading comes from.
- [`dsh-evolution-uncertainty`](../evolution-uncertainty/README.md) — the durable signals and the grouped evaluation-task queue the uncertainty read model presents.
- [`dsh-evolution-self-model`](../evolution-self-model/README.md) — the per-skill assessments and the capability frontier the self-model read model presents.
- [`dsh-agent-kernel`](../../runtime/agent-kernel/README.md) — `readKernelMetrics`, the pure fold behind the §13.2, §5.4, and §18.3 readings, and the claim and observation records the research set reads, logged as `claim/updated` and `evidence/recorded`.
- [`dsh-research-controller`](../../research/research-controller/README.md) — the runs the research window covers and the answer the review accepted.
- [`dsh-learner-model`](../../mentor/learner-model/README.md) — the per-learner record the mentoring readings come from.
- [`dsh-misconception`](../../mentor/misconception/README.md) — the recorded teach-and-reassess cycles the explain and exercise readings come from.

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
- **Per-task outcomes exist only for the benchmark corpus** — `ctx.evolutionBenchmark.run()` records one durable outcome per executed benchmark task, and the §13.5 report and `benchmark-robustness` read exactly those rows. Nothing records whether an individual *test* passed, and nothing records a no-skill arm of a scenario, so `skill-incremental-utility` and per-task regression debt stay unmeasurable and each names the record that would make it computable.
- **Memory utility records three of §23's links and three of §24's factors** — retrieval, the decision batch that followed, and a caller-supplied outcome are recorded, so the reading is real; whether an injected item was *used* or *cited*, and §24's source-quality factor, have no recorded source. The number is therefore a floor, and its caveat names each missing link rather than reporting it as zero.
- **The billed-cost denominator needs the deployment to state a price** — `evolutionBudget.spend` bills a spend that states no `cost` from the deployment's `pricePerMillionTokens`, and the shipped profile sets no price, so no shipped spend carries a cost. `capability-gain-per-cost-unit` therefore names the unpriced spend until an operator prices their tokens; it is per cost unit rather than per dollar because the unit is whatever the deployment bills in.
- **The coding dollar readings use one flat price the deployment states** — `usdPerMillionTokens` prices every billed token of a coding window at the same rate; unset, `cost` and `verified-success-per-usd` name the missing price instead of reporting a number. No route's catalog price is read for these readings, so a deployment whose routes cost differently reads an average rate applied to its tokens, not a bill, and the dollar unit is dollars only because the deployment states a dollar price.
- **Only run-derived metrics take a time bound** — `since`, `until`, and `taskClass` filter the engine-run window. The supporting metrics are current-state readings of host-wide stores: a canary summary or a debt table has no task-class key to filter by, and the two counter stores (`evolution-operators`, `evolution-evaluator-strategy`) keep only `lastAt`, so no window can be reconstructed from them at all.
- **Search overhead spans two scopes by construction** — the ratio compares a run-cumulative spend against winner-only tokens. It measures how much compute bought the winners, and it must never be added to either side.
- **The evaluator reliability reading is an inter-verdict proxy** — the health store compares one verdict against a later one, not against a human outcome.
- **The research set reads a run's own records, not a corpus** — the population is what the window's runs recorded, resolved through their sessions' logs, and `evidence-coverage` and `citation-correctness` read a settled run's answer alone, so an unsettled run contributes claims, observations, and its contradiction search but no answer. What a claim's evidence list does not say is whether an observation supported or contradicted it (the kernel's list is undirected) and what class a source is, so `source-quality` reads the observer's trust label and `contradiction-recall` reads that the search ran and produced output rather than that it found the contradictions the material held.
- **The mentor set sees only what the mentor recorded** — a misconception no detection named is absent from both the numerator and the denominator of every mentoring reading, and a case the mentor found nothing in counts as a miss. Every learner reading is one learner's, because neither store lists learners.
- **`explanation-quality` and `exercise-relevance` read how far a cycle got, not how well it taught** — the only recorded completion of the explain stage is a caller's `delivered` observation, and an exercise is judged relevant when it serves a belief the record counts as recurring, because nothing records whether its prompt matches the objective it states.
- **`repeated-mistake-reduction` reads the resolved state of a misconception** — a mistake entry counts occurrences and carries no status, so the resolved belief behind the repeat is what is read, and the record keeps a resolved entry forever.
- **The read-model surface is one layer, the records are not** — the three stores whose read models are presented here keep their own durable domains and writers, so a maintainer adding a metric must add it here and must not open `evolution_uncertainty` or `evolution_selfmodel` from this package. Presenting a read model and driving a control loop are different jobs, so `evolution-actuator` and `command-evolution` keep reading those stores directly.
- **`uncertainty-queue-depth` reads the store's cap, not every signal** — the queue the store returns is already limited by its own `queueLimit`, and a task leaves the queue when its signals are resolved, so the depth is what is still waiting rather than what was ever flagged.
- **`self-model-frontier-pass-rate` weights every capability equally** — a capability backed by two observations counts as much as one backed by twenty, and the recorded confidence beside each score is what says how much evidence it rests on. `self-model-weakest-pass-rate` is the same weakness read off the frontier's head, whose rank breaks ties on confidence and then on covering skills.
- **Some §18.3 names have no counter to read** — `context.compactions`, `context.omitted_bytes`, and `context.conflicts` belong to the context compiler's owner; `sandbox.denied` and `workflow.resume_success` have no kernel field; and `recovery.by_kind` is a distribution rather than a rate the fold keeps. The layer reports the families the kernel counters evidence and names no reading for the rest.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The window is built from `ctx.evolutionMeta.runs()`, whose records are stamped with `toISOString()`, so the `since` and `until` bounds compare as strings; the ordering is chronological because every recorded instant has the same format and zone. `runs()` returns newest first, so the window slices the newest `limit` rows and reverses them before splitting — the split is by position in time, not by count of passes.

Reasons and caveats are carried by the service rather than written by the command, matching the other evolution stores, whose records already carry a `reason` string. `/metrics` renders them, so the layer's honesty about a number travels with the number.

When the stores start recording what this layer cannot measure — a no-skill baseline arm, a recall-hit counter, a billed cost — the entry changes from `unavailable(...)` to `metric(...)` in one place, and the metric id stays stable for callers.

</details>
