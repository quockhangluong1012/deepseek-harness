---
description: "Evolution actuation: the seven heartbeat tasks that read a recorded evolution verdict or recorded evidence and perform the step it asks for (rollout decisions through the risk model, scheduled island migration, stagnation recovery, uncertainty drain, curriculum admission, benchmark growth, adversarial-probe generation)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-actuator

English | [中文](README.zh.md)

## Summary

`dsh-evolution-actuator` performs, on idle, the step each recorded evolution record asks for, through the store that already accepts it. Sibling packages record and stop, leaving seven loops stalled: rollout decisions, island migration, stagnation recovery, uncertainty drain, curriculum admission, benchmark growth, and adversarial-probe generation. It registers one heartbeat task per loop, opens no domain, calls no model, and gates nothing: it moves recorded state only, so mounting it changes the engine's next move without changing what any session sees. Each step runs under the §37 budget recorded for its task class, so an exhausted allocation stops that class's work.

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

Mount the plugin wherever the stores it acts on are mounted. The heartbeat is an injected service, so the plugin applies once the scheduler exists; its context-owned registrations drain active tasks before teardown returns.

```ts
import * as evolutionActuator from '@deepseek-ai/dsh-evolution-actuator'

await ctx.plugin(evolutionHeartbeat)
await ctx.plugin(evolutionActuator)
```

Each loop reads its store when its pass runs, so a store left unmounted makes that one loop a no-op and leaves the other six working. A loop that has nothing to act on changes nothing. Address one loop's pass and its bookkeeping through the heartbeat:

```ts
await ctx.evolutionHeartbeat.runTask('evolution-rollout-monitor')
ctx.evolutionHeartbeat.state('evolution-rollout-monitor')
```

### Configuration

Every cadence and threshold is a validated `Config` field changeable from `cordis.yml`; the heartbeat rejects an interval below one hour, and so does this plugin.

```yaml
- name: '@deepseek-ai/dsh-evolution-actuator'
  config:
    loops: ['rollout', 'growth']
    rolloutCostFactor: 2
    growthIntervalHours: 12
```

| Field | Default | Meaning |
|---|---|---|
| `loops` | every loop | Which loops to drive: `rollout`, `migration`, `recovery`, `drain`, `admission`, `growth`, `adversary` |
| `rolloutIntervalHours` | `6` | Hours between two rollout-monitor passes |
| `rolloutCostFactor` | `1.5` | Cost multiple over the incumbent's triple that fails a rollout |
| `migrationIntervalHours` | `24` | Hours between two scheduled island-migration passes |
| `recoveryIntervalHours` | `24` | Hours between two stagnation-recovery passes |
| `drainIntervalHours` | `12` | Hours between two uncertainty-drain passes |
| `admissionIntervalHours` | `24` | Hours between two curriculum-admission passes |
| `growthIntervalHours` | `24` | Hours between two benchmark-growth passes |
| `adversaryIntervalHours` | `24` | Hours between two adversarial-generation passes |
| `maxPerPass` | `5` | Items one loop acts on per pass, strongest or newest first |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-actuator) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One loop is one recorded signal and one step:

| Loop | Reads | Performs |
|---|---|---|
| `rollout` | `evolutionCanary` deployments in `canary`, `evolutionBenchmark` holdout tasks, §49's risk model | `advance` to `promoted` or `rolled-back` |
| `migration` | `evolutionIslands` schedule rows with `due` | `migrate` the skill's elite to the next lane, reason `schedule` |
| `recovery` | `evolutionStagnation` status of every skill with runs, `evolutionOperators` recommendation for the skill's artifact class | rung `diversity`: migrate the elite to the novelty lane; rung `newOperators`: report the instruction the operators store recommends; rung `newTasks`: stage the tasks the measured gaps derive |
| `drain` | `evolutionUncertainty` queue | `benchmark.admit` the task, then `resolve` the signals behind it |
| `admission` | `evolutionCurriculum` open proposals | `benchmark.admit` them |
| `growth` | `evolutionCurator` open debt, `evolutionFeedback` graded signals, `evolutionPopulation` recorded candidates, `evolutionBenchmark` tasks | `benchmark.admit` the derived tasks, then `transition` a task one rung where its capability's recorded exposure earns it |
| `adversary` | `evolutionUncertainty` signals, `evolutionCurator` open debt, `evolutionBenchmark` task capabilities | `evolutionAdversary.probe` the generated probe, then `benchmark.admit` the ones that target a benchmark-shaped capability |

Each decision lives in a pure module — `rolloutDecision`, `rolloutRisk`, `routeAllows`, `migrationTarget`, `recoveryStep`, `benchmarkInput`, `signalProbe`, `debtProbe`, `probeTask`, `governingAllocation`, `failureInputs`, `debtInputs`, `exposureOf`, and §15's `ladderAdvance` — so the rule is readable and testable without a host, and the loop only performs the call the rule names.

The rollout monitor ends a rollout that already runs live and never starts one: §49 routes the medium-risk step (a patch reaching a live fraction) to an operator. It consults §49's risk model before it decides anything. A measured regression always leaves the ladder, because rolling back restores the incumbent rather than installing the patch; a promotion needs the `auto-promote` route, so a patch whose capability no protected holdout covers — §15 forbids resting a promotion on the dataset that generated the candidate — stays live for the operator step its route names. A patch that failed its corpus never promotes; a passing patch that costs more than the incumbent on the engine's own elite order — more billed tokens, or equal tokens and more wall time — rolls back instead.

### What the growth loop mines (§14, §15)

The loop needs no model and no disabled store. Its four sources, and the exact task each derives:

| Source | Derivation |
|---|---|
| `evolutionFeedback.signals(sessions, maxPerPass)` | One task per signal the store graded `trigger_review`, which is a failure reported across `triggerReviewSessions` distinct sessions. The capability is the failing tool and the task text is `Recover from the recurring failure: '<message>' — <tool> was in play.` A signal that only ranks or observes produces nothing, and neither does one whose tool call was never observed, because without the tool there is no capability to attribute the task to. The session list reading the signals comes from `evolutionSkillTelemetry.entries()`'s `usage.sessionIds`, the same seam the curriculum measures its gaps from. |
| `evolutionCurator.debt()` | One task per open debt, with the debt's skill as the capability and the same task text built from its failure message. |
| `evolutionPopulation.candidates(capability)` | Exposure for the ladder rule, not a task: the candidate evaluations that measured a triple, and how many of those passed. An unmeasured candidate counts in neither number. |
| `evolutionBenchmark.tasks()` | The learnable tasks the ladder rule advances, and — for the rollout loop — the capabilities a `holdout` task protects. |

`ladderAdvance(state, exposure)` is the §15 decision rule, and each rung asks for its own recorded evidence: a `fresh` task joins the search set once the capability has one recorded candidate evaluation, a `search` task becomes validation once a candidate passed (so it carries a known baseline and can discriminate rather than only fail), and a `validation` task is reserved as `holdout` once the capability has `HOLDOUT_AFTER_RUNS` evaluations, at which point the corpus has moved past it and protecting it costs the search nothing. Exposure is capability-scoped because no store binds a candidate evaluation to a benchmark task identity — see the limitation below.

Every loop is idempotent by construction, which is what makes a heartbeat cadence safe. A decided rollout leaves `canary`, so the next pass cannot decide it again. A recorded migration resets its lane's due flag. The curriculum store skips a gap whose task is already open, and the benchmark store deduplicates by task content — which is what stops the growth loop re-admitting a failure the feedback store keeps grading `trigger_review` on every pass, because the derived task text carries no observation count and so re-hashes to the task already admitted. The uncertainty drain drops the signals it acted on, so the queue empties rather than re-admitting. The ladder rule is monotonic and `transition` writes only when the state changes, so a task that cannot advance is written to not at all. The adversary loop leaves a probe whose exact text the store already holds, which is what keeps a repaired probe repaired and a re-read weakness from becoming a second probe beside it.

### What the adversary loop generates (§45, §14)

The loop turns recorded evidence into adversarial probes, one per recorded weakness, so a probe is never invented text. The family comes from the store's closed §45 vocabulary and the observation is the recorded text verbatim:

| Recorded evidence | Family | Why that family |
|---|---|---|
| an `evolutionUncertainty` signal of kind `disagreement` | `evaluator-gaming` | The disagreement came from an evaluator, so what the probe exercises is the evaluator's own judgment (§46). |
| `low-confidence` | `ambiguous-instruction` | A confidently wrong answer is what an under-specified instruction produces. |
| `instability` | `edge-case` | Instability is a result that moves on the same input, which is what a case boundary exposes. |
| `retrieval-ambiguity` | `retrieval-trap` | §43 records that retrieval could not discriminate; the probe exercises that trap. |
| `conflicting-evidence` | `contradictory-evidence` | Two records disagree about the same fact. |
| an `evolutionCurator` open regression debt | `tool-failure` | The debt's merge key is a tool and a message: the recorded failure *is* a failing tool call. |

A probe's text is `Probe <skill> for the recorded <family> weakness: '<observation>'.` and its identity is the sha256 of the skill, the family, and the text, so a recorded weakness is one probe however often a pass reaches it and a repaired probe is never re-opened by the pass that keeps seeing it. The pass records the probe and never runs it: executing a probe against a candidate needs a runner and a corpus the shipped profile has no store for, so `foundWeakness` stays `false` rather than reporting a run that never happened — the recorded evidence is what exposed the weakness, and the probe is the recorded challenge for whoever runs it. That half of §45 stays operator-side.

A probe that targets a benchmark-shaped capability is also admitted as a §14 adversarial example, through the same `benchmark.admit` path every other loop uses and deduplicated by the same content hash, so adversarial examples enter the evaluation set rather than dying in a probe log. "Benchmark-shaped" means the benchmark store already holds a task naming that capability: a first-time failure in a brand-new capability produces a probe but no task, because there is no evaluation set for the example to join yet — the curriculum proposal that creates that capability's first task is what brings it into scope, and the next pass admits the example.

### What the budget gate does (§37, §38)

These loops are the only enabled runners, so they are where a recorded allocation can actually stop work. Before a step, the pass reads the allocations the budget store recorded for that skill or capability and takes the newest; it then asks `evolution-budget`'s own `withinAllocation` over the batch's recorded spends. A class whose batch is spent is left alone and the skip is logged — nothing happened, so nothing is written to a domain — and a class that ran settles against the same batch, recording the wall time the work took. That is what closes the loop: the ceiling a batch records is read before the next pass of the same class.

- **A mounted budget store bounds the work; an unmounted one does not.** With no `evolutionBudget` mounted every loop runs exactly as it did before, unmeasured. A class no batch priced also runs unmeasured: an unpriced class has no ceiling rather than a zero one.
- **`withinAllocation` is the enforcement, so the gate covers every §37 dimension `evolution-budget` prices** — tokens, wall time, cost, deadline, and parallelism — including the dimensions a record written before them leaves absent, where absent bounds nothing.
- **The loops spend wall time and no tokens.** They call no model, so a pass reports `tokens: 0` with the wall time it took, and the token, cost, and rollout ceilings are moved by the optimizer's own recorded spends rather than by this gate.

### Failure and recovery

A store that is not mounted ends its loop silently; the other loops keep running. A store that rejects an action — an illegal transition because a person advanced the same rollout first, for instance — fails that task's attempt, which the heartbeat records in `lastError` and retries on the interval, leaving the rest of the pass untouched. Registrations are in memory and durable bookkeeping is the heartbeat's, so a restart resumes on the stored schedule.

No invariant companion is published: the plugin owns no state of its own, and every value it acts on belongs to the store that recorded it.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) — §7 (island migration on a schedule), §10 (curriculum), §14 (benchmark growth, the regression promoter, and the adversarial example generator), §15 (the protected holdout and the ladder evidence that reserves it), §18 and §49 (shadow → canary → promotion, §49's risk table, and the human-in-the-loop rule), §32 (the strategy ladder), §35 (contamination control), §37 and §38 (the budget controller and successive halving), §43 (uncertainty-driven learning), §45 and §46 (adversarial evolution and evaluator-gaming defense), §53 (the proposal → benchmark → canary → promotion chain), and §58.12 for the recorded-not-enforced boundary this package stays inside.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-adversary`](../evolution-adversary/README.md) — the probe store the adversary loop writes through, its eight §45 families, and the §46 defense checklist.
- [`dsh-evolution-budget`](../evolution-budget/README.md) — the allocations and settlements the budget gate reads, and §37's candidate-class pricing.
- [`dsh-evolution-canary`](../evolution-canary/README.md) — the rollout ladder and the §49 risk model `rolloutRisk` feeds.
- [`dsh-evolution-benchmark`](../evolution-benchmark/README.md) — the store the drain, admission, and growth loops admit into, and the ladder rule they advance.
- [`dsh-evolution-heartbeat`](../evolution-heartbeat/README.md) — the scheduler that owns the cadence, the idle gate, and the bookkeeping.
- [`dsh-evolution-metrics`](../evolution-metrics/README.md) — the read side of the same stores: the metric layer reports what these loops moved.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the write side: the producer whose staged writes enter the stores these loops act on.

-----

<a id="model-experience"></a>
## Model Experience

None, as this plugin registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A task that a loop performs may change a later request's content — a promoted skill, an admitted benchmark task — and that request's owner accounts for its prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the package is a poor fit. They are current package constraints.

- **Two ladder rungs have no writable target** — §32 climbs from diversity over new mutation operators, new tasks, and new evaluators to switching the model. Three rungs act here. `newOperators` acts as a *read*: `evolution-operators` owns the operator portfolio and proposes the instruction to try next, so the loop reports the instruction the store recommends for the skill's artifact class — and with the store unmounted, or holding no proposal for that class, the pass records the rung `unactionable` naming which of the two it is. Nothing here writes the portfolio, because the optimizer is the consumer of that same recommendation. The other two each name the store that would have to accept the switch: `newEvaluators` needs `evolution-evaluator-strategy` to take a proposed evaluator set (it records verdict/ground-truth pairs only), and `newModel` needs `evolution-model-routes` to take a pinned role switch — a configured route is not a model switch, so it is not approximated with one. Until those two stores accept a switch, `recoveryStep` reports the rung `unactionable` rather than have this plugin invent a policy, and the package that owns the portfolio or the route table decides it.
- **A generated probe is recorded, never run** — §45's other half is execution: running the probe against a candidate and judging whether it exposed a weakness. That needs a runner and a corpus the shipped profile has no store for, so every probe this loop records carries `foundWeakness: false` and the judgment stays with an operator, who records it by re-recording the probe through `/adversary probe` and marking it repaired.
- **An adversarial example needs its capability to be benchmark-shaped first** — the `adversary` loop admits a probe as a §14 evaluation task only when the benchmark store already holds a task naming that capability. A first-time failure in a brand-new capability therefore produces a probe and no task, until a curriculum proposal creates that capability's first benchmark task.
- **Six of the eight weakness families have a recorded source; two do not** — the mapping covers every §43 uncertainty kind (`evaluator-gaming`, `ambiguous-instruction`, `edge-case`, `retrieval-trap`, `contradictory-evidence`) and the curator's regression debt (`tool-failure`). `prompt-injection` is classified on the session ledger by the agent kernel and reaches no store this loop reads — the feedback store aggregates failing *tool results*, so an injection that reached a tool reads here as a tool failure. `stale-memory` has writers (the memory store sweeps decayed artifacts, the graph retires superseded claims) but neither is readable host-wide: both are per-scope records and no store exposes scope iteration. Neither is defaulted into another family: a weakness no readable record grounds produces no probe, and those two families stay recorded by an operator through `/adversary probe`.
- **The uncertainty task text is the signal note** — no store holds a generated task for an uncertainty signal, so an admitted benchmark task carries the observed note rather than a synthesized prompt.
- **Rollout evidence is the staging triple** — the monitor compares each patch's recorded pass/tokens/wall-time triple against the incumbent's, not a hidden-response replay against a production baseline.
- **A rollout still starts by hand** — `shadow → canary` stays an operator decision, so a store full of shadows produces no automatic promotion.
- **Promotion now needs a protected holdout** — the risk model grades an uncovered capability `medium` at best, so on a host whose benchmark holds no `holdout` task for a skill the monitor rolls regressions back and leaves promotions live for an operator. That is §15's rule rather than an accident: the benchmark store is where a holdout is recorded, so a host without it has no protected dataset to promote on.
- **The ladder's exposure is capability-scoped, not task-scoped** — no store binds a candidate evaluation to a benchmark task identity, so `ladderAdvance` reads the exposure recorded for the task's capability and applies it to every learnable task of that capability. Two tasks of one capability advance together, and a capability with rich evaluation history promotes its newest task to `holdout` without that task ever having been searched.
- **Passes run sequentially** — the heartbeat awaits each task in registration order, so a slow store delays the loops after it in that pass.
- **Host-wide, not scope-keyed** — every loop acts on the whole host; a per-scope rollout or migration policy needs a scope key on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The seven loops share one package because they share one contract — read a recorded verdict, perform the step it licenses, through the store that accepts it — and because a host enables them together: seven packages would have meant seven entries in a profile that already carries thirty evolution rows. The metric layer reads the same stores through the same optional-seam pattern, so the group now has one package that reads, one that writes, and this one that acts.

The decision rules are pure modules rather than inline branches so a rule change is a unit test rather than a host fixture. `rolloutDecision` follows the engine's elite order — pass, then billed tokens, then wall time — which is the same precedence `evolution-stagnation`'s `betterThan` uses, so a rollout and a stagnation run judge a patch the same way. `rolloutRisk` derives §49's input from recorded state rather than restating it by hand, which is why the risk class is a reading of the same triple the decision uses plus the benchmark store's holdout coverage.

`growth` is the one loop that starts from evidence rather than from a verdict a store is waiting to act on, which is why it is the only loop with two phases: admit what the recorded failures derive, then advance what the recorded exposure earns. Its sources are all live in the shipped profile — session failures, curator debt, candidate evaluations — unlike the three stores the meta-evolution rows read, which stay empty until the disabled optimizer runs. Nothing in it reads `evolutionStagnation`, which is what `admission` is gated on.

`adversary` is built the same way as `growth` and shares its shape deliberately: one pure mapping per recorded source (`signalProbe`, `debtProbe`), one mapping onto the store's own write (`probeTask`), and the store's vocabulary, not this package's, deciding which family a weakness belongs to. Its two limits are the two halves of §45 that need something this repository does not ship — an execution runner, and a benchmark corpus in an old capability — so the recorded half is what runs and the README names the rest rather than inventing it.

The budget gate (`underBudget`) sits between a rule deciding to act and the store call the rule names, so every loop enforces §37 with one implementation. It keys on the task class the allocator already uses — a skill or a capability — and asks `evolution-budget`'s own `withinAllocation` rather than re-deriving the arithmetic, which is what keeps the gate correct when that package adds a §37 dimension. It is a gate on the loops alone: the optimizer's own screening keeps its in-run budget check, and nothing here changes what an unmounted-budget host runs.

`inject = ['evolutionHeartbeat']` is what makes mount order irrelevant: the plugin waits for the scheduler instead of reading `ctx.get('evolutionHeartbeat')` once at apply time and never rechecking it. The stores stay optional seams, so a host can mount this package before or after them.
</details>
