---
description: "Benchmark growth from production failures: a durable evaluation-task store with content deduplication, contamination states, regression promotion, and the §15 evidence rule that reserves the protected holdout (ctx.evolutionBenchmark)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-benchmark

English | [中文](README.zh.md)

## Summary

`dsh-evolution-benchmark` grows durable, deduplicated evaluation tasks from production failures and executes them. A task enters as `fresh` and advances `fresh → search → validation → holdout` as it is used, or derails to `contaminated` or `retired`; a content address blocks re-admission while a twin is still learnable, and `ladderAdvance` reads recorded exposure to decide the §15 holdout. The §5.3 datasets ship as task-definition fixtures; the run pass boots each task through the scorer's replay seam and records one durable outcome — the verdict, the cost, and the §13.5 facts — that `/benchmark` and `ctx.evolutionMetrics` read.

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

Mount the plugin with the storage domain. Admit candidate tasks from any producer — the §5.3 datasets, the curriculum store's open proposals, or the actuator's mined failures — then walk each task along the learning ladder.

```ts
const { admitted, duplicates } = await ctx.evolutionBenchmark.admit([{
  capability: 'writer',
  task: 'Recover from the recurring failure: boom',
  gists: ['boom'],
  sourceSessions: ['s1'],
  profile: null,          // the producer did not classify the task
  family: 'loop-recovery',
  stepSpan: null,         // no stated horizon
  acceptance: null,       // no stated observable
}])
for (const task of admitted) {
  await ctx.evolutionBenchmark.transition(task.id, 'search')
}
```

`admit(inputs)` deduplicates against every still-learnable task and stages the rest as `fresh`, capped by `maxAdmit` per pass; it returns the admitted tasks and the duplicate texts. `tasks(state?)` lists every task, learnable states first in pipeline order then newest first. `transition(id, to)` advances one ladder step per call, derails any learnable state to `contaminated` or `retired`, and rejects unknown ids and illegal transitions loudly. The `/benchmark` command lists by state, admits the curriculum store's open proposals, and promotes or retires tasks.

Every task states the profile and the §5.3 scenario family it was authored for and the step horizon it should exercise (`stepSpan`, null when the producer bounded none). A producer states that classification rather than leaving it to the store: a task mined from recorded evidence spreads `MINED_TASK` — the loop/recovery family, no profile, no horizon, no acceptance observable — while a §5.3 dataset task carries the profile and horizon its fixture declares.

### Baseline datasets (§5.3, §13.5)

The package ships `datasets/`, one JSON file per §5.3 scenario family, named by that family. A file states `runRequirement: 'live-model'` and lists its task definitions; each definition carries `profile`, `stepSpan`, `capability`, `task`, and `acceptance`.

```ts
const datasets = await loadDatasets(new URL('../datasets/', import.meta.url).pathname)
const { admitted } = await ctx.evolutionBenchmark.admit(datasetInputs(datasets))
```

`loadDatasets(root)` enumerates the root in family-name order and validates every file, its family name, and every task definition; a file that fails any of those rejects loudly. `datasetInputs(datasets)` maps the definitions onto admission inputs, each carrying the family it was enumerated under and no failure gists or source sessions, because a dataset task is authored rather than mined. `horizonTier(stepSpan)` and `HORIZON_TIERS` name the §13.5 horizons: a task bounded at 100 steps or more is on the 100+ tier, and a span below 10 steps reaches no tier.

| Family file | Profile it holds | Horizon it reaches |
|---|---|---|
| `coding.json` | `coding` | up to 10 steps |
| `research.json` | `research` | up to 20 steps |
| `mentor-ict.json` | `mentor`, `ict` | up to 25 steps |
| `long-horizon.json` | every profile | 10, 20, 50, and 100+ steps |
| `loop-recovery.json` | `coding`, `research`, `mentor` | up to 12 steps |

A dataset task is a definition, not a run: it ships no expected output and no recorded session, so its outcome needs a run, and the caller supplies the workspace a coding task mutates and the case material a mentor/ICT task analyses. The `acceptance` statement names the observable that run is judged against.

### Executing a corpus (§13)

`run(request)` turns each task into its own run and records one durable outcome per task. The task text becomes the run's input script; the attempts are reduced by `evolution-scorer`'s own `scoreRun`, so the verdict, the billed tokens, and the wall time mean exactly what they mean everywhere else; and the §13.5 facts are folded from the sessions each attempt harvested.

```ts
const datasets = await loadDatasets(new URL('../datasets/', import.meta.url).pathname)
const { admitted } = await ctx.evolutionBenchmark.admit(datasetInputs(datasets))

const report = await ctx.evolutionBenchmark.run({
  tasks: admitted,
  options: { agent, mode: 'replay', fixtureFile, workspaceDir },  // RunOptions, @deepseek-ai/dsh-session-snapshot
  run: processScenarioRunner,                                     // the seam evolution-scorer scores through
  expected: task => captures.get(task.id),                        // the observable each task is judged against
  attempts: 1,
})

report.outcomes  // one outcome per executed task, in run order
report.scored    // outcomes that produced a verdict
report.passed    // executed tasks that passed
report.failed    // runs that failed before a verdict
report.deferred  // tasks the configured cap left unexecuted
```

Every outcome carries the task identity, the profile, family, and horizon tier, the verdict, the metric triple, the divergence paths a failure named, and the §13.5 facts: steps, verifications and passing verifications, tasks closed and completed, failures and answered failures, the peak context occupancy against the reported window, and the harvested session ids. `outcomes()` lists them newest first, which is what `ctx.evolutionMetrics.longHorizon()` aggregates per horizon tier and what `benchmark-robustness` divides.

A run that fails — a runner that cannot boot, a fixture that is missing — is recorded as an outcome with `status: 'failed'` and its reason, and the pass continues with the next task, so one unrunnable task cannot hide the outcomes of the tasks around it. A failed outcome carries no verdict and no measured triple; only the facts its harvested sessions recorded are filled in.

The runner is the caller's: pass `processScenarioRunner` (or any `ScenarioRunner`) for the keyless replay tier, whose fixture the wiring names, or a runner that boots the composition in `record` mode against a live model. Nothing in this package calls a model itself, and the verdict is always the scorer's workspace comparison against the expectation the caller resolves for that task.

### Advancing the ladder from recorded evidence (§15)

`transition` moves a task wherever the caller says, which leaves the holdout partition a manual decision. `ladderAdvance(state, exposure)` is the pure rule that answers the same question from what the engine recorded, and it returns `undefined` when the evidence earns no rung.

```ts
// Exposure is the capability's recorded candidate evaluations.
const next = ladderAdvance('search', { runs: 4, passes: 1 })
// next === 'validation'
await ctx.evolutionBenchmark.transition(task.id, next)
```

| Task state | Rung earned when | Why that evidence |
|---|---|---|
| `fresh` → `search` | `runs > 0` | Anything was evaluated, so the task can join the set the search generates against |
| `search` → `validation` | `passes > 0` | A candidate passed, so the task carries a known baseline and can discriminate rather than only fail |
| `validation` → `holdout` | `runs >= HOLDOUT_AFTER_RUNS` (3) | The corpus has moved past the task, so protecting it costs the search nothing |
| `holdout`, `contaminated`, `retired` | never | The partition ends at the protected state, and terminal states never leave |

Exposure is capability-scoped rather than task-scoped, because no store binds a candidate evaluation to a benchmark task identity: a caller reads the exposure recorded for a task's capability and applies it to that capability's learnable tasks. `HOLDOUT_AFTER_RUNS` is exported so a deployment can state the threshold it relies on rather than rediscover it.

### Configuration

The admission bound is a validated `Config` member changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-benchmark'
  config:
    maxAdmit: 20
```

| Field | Default | Meaning |
|---|---|---|
| `maxAdmit` | `20` | Learnable tasks one admission pass may stage |
| `maxTasks` | `20` | Tasks one run pass executes; the rest are reported as deferred |
| `attempts` | `1` | Fresh-process attempts per task; one keeps a corpus pass affordable, and a caller raising it medians a cold start away |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-benchmark) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Deduplication is pure and content-addressed: `benchmarkHash` is the sha256-hex of the whitespace-collapsed task text, so two inputs differing only in whitespace are the same task. `dedupe` splits candidates into admitted and duplicates against the already-learnable hashes, and the store builds that blocking set by asking `blocksDuplicate` per existing state — so `contaminated` and `retired` tasks never block re-admission.

The store is a per-task domain: `evolution_benchmark` version 2 with one `tasks` table keyed by task identity, holding `{ id, hash, capability, task, gists, sourceSessions, profile, family, stepSpan, acceptance, at, state }`. Version 1 stored no profile, family, or horizon; those rows open as `loop-recovery` with a null profile, because every producer of that generation derived its task from a recorded failure. `transitionState` is the one state machine: learnability advances one step per call, any learnable state may derail to `contaminated` or `retired`, terminal states never leave, and a same-state call resolves without writing.

`dataset.ts` is the corpus half: the file schema, the family vocabulary read from each file name, `horizonTier` over `HORIZON_TIERS`, and the mapping onto admission inputs. Reading the family from the file name rather than repeating it inside the file leaves one declaration per dataset, so a fixture cannot disagree with itself; a stray file, an unknown family name, or an incomplete task definition rejects at that boundary rather than admitting a partial corpus.

`ladderAdvance` layers the evidence rule on top of that machine rather than replacing it: it reads `nextLadder` for the state's one legal forward step and then decides whether the evidence earns it, so a caller can always `transition` to what the rule returned without the store rejecting it. The rule reads exposure as data (`runs`, `passes`) rather than reading the population store itself, which is what keeps the benchmark package free of a dependency on the engine's population layer.

The run pass is the second half of the same store: `evolution_benchmark` holds the tasks and `evolution_benchmark_runs` holds one row per executed task, so an outcome is durable evidence rather than a number one command printed. A row records the scorer's verdict and triple beside the facts folded from the run's own harvested sessions — the kernel's own counters for steps, verification, closure, failures, and recoveries, and the token meter's own context-pressure projection for occupancy — so no later reader has to re-open a session log to answer what a run cost or how close it came to the context ceiling. The pass borrows the evaluation machinery rather than reimplementing it: the input script is the only thing this package adds, and the attempts are reduced by the scorer's exported `scoreRun`.

### Failure and recovery

An unknown id or an illegal transition rejects loudly, so a task can never skip a ladder step or escape a terminal state. Reads throw before the store starts.

A run whose runner throws is the one failure that does not propagate: it is recorded as a failed outcome with its reason, because the pass's other outcomes are the evidence a report needs and aborting would trade them for one error message. The row keeps a failed run's own bad news visible in two places at once — the reason string on the row, and the window's `failed` count in the §13.5 report — so a task that never ran is never read as a task that did not pass.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §14, §15, and §35 — the benchmark-growth, protected-holdout, and contamination-control mechanism families this package implements.
- [DeepSeek Harness 2.0 specification](../../../specs/deepseek-harness-2.0-evolution-spec.md) §5.3 and §13.5 — the baseline datasets and the step horizons `datasets/` and `HORIZON_TIERS` cover.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-curriculum`](../evolution-curriculum/README.md) — the producer whose open proposals `/benchmark admit` promotes into fresh tasks.
- [`dsh-evolution-actuator`](../evolution-actuator/README.md) — the growth loop that mines recorded failures into tasks and advances them on recorded exposure.
- [`dsh-evolution-scorer`](../evolution-scorer/README.md) — the fresh-process runner seam and the `scoreRun` reduction the run pass boots every task through.
- [`dsh-evolution-metrics`](../evolution-metrics/README.md) — `benchmark-robustness` and the §13.5 long-horizon report, which read the outcomes a run pass records.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-benchmark) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing: no task, outcome, or ladder state enters a prompt, a tool result, or a session event.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. The run pass renders a task into the prompt of the process it boots, and that prompt is the run's own request: its prefix reuse belongs to the composition the caller booted, not to this store.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **The verdict is a workspace comparison, not the acceptance statement** — a task's `acceptance` is prose, and the run pass judges a run by comparing the workspace against the expectation the caller resolves for that task. A task whose observable is not a workspace state (a mentor explanation, a research answer) needs a caller-supplied expectation or a judge outside this package.
- **Nothing records a dataset fixture's expected workspace** — the §5.3 datasets ship definitions and no expectation, so a corpus pass is only as reproducible as the deployment's own captures. With none supplied, each task is scored against its own initial workspace and only a run that changed nothing passes; `/benchmark` reads and admits the corpus, and executing it is the deployment's call.
- **A run's sessions are not copied into the host session store** — the §13.5 facts are folded when the outcome is recorded, from the logs that attempt harvested. `ctx.evolutionMetrics.coding()` reads the host's own recorded sessions, so a benchmark run does not appear in that window and the two readings cover different populations.
- **`stepSpan` is a floor, not a measurement** — it declares the minimum steps a task should exercise; whether a run stayed within its horizon is read from that run's own trace, never from this store. The recorded `steps` count is what a run actually took, which is why the two sit on the same outcome row.
- **Host-wide, not scope-keyed** — tasks are global; a per-scope benchmark needs a scope key on the domain.
- **Contamination is manual** — a task only leaves the learnable ladder when something transitions it; no sweep marks tasks contaminated from search exposure automatically.
- **The holdout rule reads capability exposure, not task exposure** — no store binds a candidate evaluation to a benchmark task identity, so `ladderAdvance` cannot see whether *this* task was searched. It can only see how much the capability was evaluated, which means a task admitted into a well-evaluated capability reaches `holdout` without the search ever having used it. Binding evaluations to task identities needs a record the harness does not have.
- **The rule answers, it does not act** — `ladderAdvance` returns a state and nothing calls `transition` on its behalf here; the actuator's growth loop is the shipped caller.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The blocking set for deduplication is built from per-state checks rather than a hardcoded list, so adding a state later only needs `blocksDuplicate` to answer for it. The state order in `tasks()` listing mirrors the ladder; contaminated and retired sort after holdout.

`ladderAdvance` exists beside `nextLadder` rather than replacing it, because the two answer different questions: `nextLadder` is the ladder's shape, which `/benchmark promote` and `transition` already enforce, while `ladderAdvance` is the evidence gate on top of it. A caller that only wants the next rung still gets it. `HOLDOUT_AFTER_RUNS` is a named constant rather than a literal in the comparison so the README, the tests, and any deployment reasoning about the threshold cite one number.

An outcome folds its §13.5 facts from the first attempt's logs alone, so one row never mixes a sum over three runs with the median of one; the row's own field documentation says which attempt each fact describes. The facts are folded once, when the run is recorded, because the harvested logs are the only copy of that evidence — the run booted a process whose sessions the host's own store never saw.

</details>