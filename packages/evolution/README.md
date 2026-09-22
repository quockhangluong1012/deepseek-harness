---
description: "The evolution group map: the self-learning harness family that learns from user behaviour, curates bounded memory, and improves skills during use."
kind: "package-group"
---

# packages/evolution

English | [中文](README.zh.md)

## Summary

The evolution family adds a closed learning loop on top of the harness without patching a privileged core: durable per-scope memory records with staged writes, background turn review, scheduled skill curation, and long-horizon safety rails. Every learned write is capped, logged, and rollback-capable; removing the rows restores byte-identical legacy behaviour. Choose this family when Sessions should get better the longer they are used. The behaviour contract lives in [the Evolutionary Harness specification](../../specs/evolutionary-harness.spec.md) until the dedicated subsystem reference lands.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`evolution-memory`](evolution-memory/README.md) | Provides the durable per-scope evolution memory record, lesson/profile writes, staged writes, and capacity accounting | `ctx.evolutionMemory` |
| [`evolution-reviewer`](evolution-reviewer/README.md) | Buffers turns, indexes produced files, extracts lessons on a gate, and rebuilds on demand | `ctx.evolutionReviewer` |
| [`evolution-curator`](evolution-curator/README.md) | Host-wide interval and idle maintenance: automatic skill lifecycle transitions, opt-in LLM consolidation under the full-package rule, backups, ledger, and rollback | `ctx.evolutionCurator` |
| [`evolution-heartbeat`](evolution-heartbeat/README.md) | Host-wide idle-triggered task registry: one timer running autonomous maintenance tasks on their own cadence, with durable per-task bookkeeping | `ctx.evolutionHeartbeat` |
| [`evolution-feedback`](evolution-feedback/README.md) | Per-session failure observations: failing tool results recorded, deduplicated, graded into decision signals, and aggregated into natural-language feedback for the learning loop | `ctx.evolutionFeedback` |
| [`evolution-graph`](evolution-graph/README.md) | Per-scope knowledge graph: entities and directed relations with bounded traversal, plus one deterministic extraction that turns text into triples | `ctx.evolutionGraph` |
| [`evolution-controller`](evolution-controller/README.md) | Host Remote face over the memory record: scoped read and write verbs, staged-write decisions, the journey timeline, and a scope-filtered change stream | `ctx.evolutionController` |
| [`evolution-trajectory`](evolution-trajectory/README.md) | ShareGPT trajectory export for one Session or every Session of a scope, written on the Host path | `ctx.evolutionTrajectory` |
| [`evolution-trace`](evolution-trace/README.md) | Immutable session trace projection: structured learning traces with ranked root-cause attribution and compressed summaries over the committed session log | `ctx.evolutionTrace` |
| [`evolution-curriculum`](evolution-curriculum/README.md) | Automatic curriculum: measures capability gaps from telemetry and the trace store and stages one grounded training task per gap | `ctx.evolutionCurriculum` |
| [`evolution-benchmark`](evolution-benchmark/README.md) | Benchmark growth from production failures: a durable evaluation-task store with content deduplication and contamination states | `ctx.evolutionBenchmark` |
| [`evolution-evaluator-health`](evolution-evaluator-health/README.md) | Evaluator ensemble health: recorded behavior-evaluation verdicts with agreement, approval drift, and false-positive tracking | `ctx.evolutionEvaluatorHealth` |
| [`evolution-population`](evolution-population/README.md) | Population-based evolution: every staged optimizer write as a per-skill candidate with generation numbering, parent lineage, and the stage → approve/reject lifecycle | `ctx.evolutionPopulation` |
| [`evolution-model-routes`](evolution-model-routes/README.md) | Adaptive model routing: per-role route assignments with measured evidence and recommendation over the evolutionary role topology | `ctx.evolutionModelRoutes` |
| [`evolution-canary`](evolution-canary/README.md) | Shadow/canary deployment tracking: rollout states of staged skill patches with measured shadow evidence | `ctx.evolutionCanary` |
| [`evolution-novelty-search`](evolution-novelty-search/README.md) | Novelty search: a durable per-skill behavior-descriptor archive whose Jaccard-based archive novelty rewards meaningfully different candidates | `ctx.evolutionNovelty` |
| [`evolution-stagnation`](evolution-stagnation/README.md) | Stagnation detection: counts evaluation runs without meaningful improvement and names the next diversity strategy when the frontier stalls | `ctx.evolutionStagnation` |
| [`evolution-islands`](evolution-islands/README.md) | Island evolution: per-skill evolution lanes with an objective each, migration records between islands, and schedule-based migration due checks | `ctx.evolutionIslands` |
| [`evolution-self-model`](evolution-self-model/README.md) | Controlled self-model: a durable per-skill capability record and the weakest-first capability frontier that says what to learn next | `ctx.evolutionSelfModel` |
| [`evolution-uncertainty`](evolution-uncertainty/README.md) | Uncertainty-driven learning: durable uncertainty signals aggregated into a prioritized queue of high-value evaluation tasks | `ctx.evolutionUncertainty` |
| [`evolution-adversary`](evolution-adversary/README.md) | Adversarial evolution: durable adversarial probes across eight weakness categories plus the evaluator-gaming defense checklist | `ctx.evolutionAdversary` |
| [`evolution-lineage`](evolution-lineage/README.md) | Dependency-aware evolution: dependency-versioned experiment envelopes with comparability checks and ablation attribution | `ctx.evolutionLineage` |
| [`evolution-sleeptime`](evolution-sleeptime/README.md) | Sleep-time compute: anticipated future tasks with precomputed reasoning artifacts under an offline-cost economic policy | `ctx.evolutionSleeptime` |
| [`evolution-scorer`](evolution-scorer/README.md) | Scores a recorded corpus run: workspace-diff pass, metered tokens, and median-of-N wall time | `ctx.evolutionScorer` |
| [`evolution-dreaming`](evolution-dreaming/README.md) | Three-phase dreaming consolidation over recorded failures: light observation, REM reflection, and deep durable narratives on the heartbeat's schedule | `ctx.evolutionDreaming` |
| [`evolution-optimizer`](evolution-optimizer/README.md) | Offline skill optimization: trigger-gated mutation over the host LLM, scorer evaluation under isolated overlays, Pareto pick, and staged skill patch | `ctx.evolutionOptimizer` |
| [`evolution-operators`](evolution-operators/README.md) | Mutation-operator evolution: attempts, acceptance, mean delta, and regression rate per operator and artifact class, with the exploration-adjusted ranking of which operator to try next | `ctx.evolutionOperators` |
| [`evolution-evaluator-strategy`](evolution-evaluator-strategy/README.md) | Evaluator-strategy evolution: trust per evaluator and task class, earned from verdicts later judged against an independent ground truth | `ctx.evolutionEvaluatorStrategy` |
| [`evolution-budget`](evolution-budget/README.md) | Evolution budget: per-batch allocations priced by candidate class, the spends settled against them with exact margins, and the successive-halving screening schedule | `ctx.evolutionBudget` |
| [`evolution-router`](evolution-router/README.md) | Routing self-optimization: route outcomes measured per task class and role, with derived effectiveness and the ranked route recommendation | `ctx.evolutionRouter` |
| [`evolution-meta`](evolution-meta/README.md) | Meta-evolution: engine runs under their configurations with derived pass rates, and the configuration recommended for a task class | `ctx.evolutionMeta` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Evolutionary Harness specification](../../specs/evolutionary-harness.spec.md) — the behaviour contract this family implements.
- [Evolutionary Harness subsystem](../../docs/subsystems/evolutionary-harness.md) — the reference vocabulary and generated API for this family.
- [Workspace subsystem](../../docs/subsystems/workspace.md) — the neighbouring per-directory memory design this family mirrors.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
