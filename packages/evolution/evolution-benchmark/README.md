---
description: "Benchmark growth from production failures: a durable evaluation-task store with content deduplication, contamination states, regression promotion, and the §15 evidence rule that reserves the protected holdout (ctx.evolutionBenchmark)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-benchmark

English | [中文](README.zh.md)

## Summary

`dsh-evolution-benchmark` grows durable, deduplicated evaluation tasks from production failures. A task enters as `fresh`, advances `fresh → search → validation → holdout` as it is used, and a learnable task can be derailed to `contaminated` or `retired`. A content address (sha256 of the normalized task text) blocks re-admission while a twin is still learnable; contaminated or retired tasks do not, so a repaired task re-enters the pipeline. `ladderAdvance` reads a task's capability exposure and names the rung that evidence earns, so the §15 holdout partition is decided, not manual. Nothing here calls a model; `command-evolution` reads it through `/benchmark`.

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

Mount the plugin with the storage domain. Admit candidate tasks from any producer (the curriculum store's open proposals are the shipped consumer), then walk each task along the learning ladder.

```ts
const { admitted, duplicates } = await ctx.evolutionBenchmark.admit([{
  capability: 'writer',
  task: 'Recover from the recurring failure: boom',
  gists: ['boom'],
  sourceSessions: ['s1'],
}])
for (const task of admitted) {
  await ctx.evolutionBenchmark.transition(task.id, 'search')
}
```

`admit(inputs)` deduplicates against every still-learnable task and stages the rest as `fresh`, capped by `maxAdmit` per pass; it returns the admitted tasks and the duplicate texts. `tasks(state?)` lists every task, learnable states first in pipeline order then newest first. `transition(id, to)` advances one ladder step per call, derails any learnable state to `contaminated` or `retired`, and rejects unknown ids and illegal transitions loudly. The `/benchmark` command lists by state, admits the curriculum store's open proposals, and promotes or retires tasks.

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

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-benchmark) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Deduplication is pure and content-addressed: `benchmarkHash` is the sha256-hex of the whitespace-collapsed task text, so two inputs differing only in whitespace are the same task. `dedupe` splits candidates into admitted and duplicates against the already-learnable hashes, and the store builds that blocking set by asking `blocksDuplicate` per existing state — so `contaminated` and `retired` tasks never block re-admission.

The store is a per-task domain: `evolution_benchmark` version 1 with one `tasks` table keyed by task identity, holding `{ id, hash, capability, task, gists, sourceSessions, at, state }`. `transitionState` is the one state machine: learnability advances one step per call, any learnable state may derail to `contaminated` or `retired`, terminal states never leave, and a same-state call resolves without writing.

`ladderAdvance` layers the evidence rule on top of that machine rather than replacing it: it reads `nextLadder` for the state's one legal forward step and then decides whether the evidence earns it, so a caller can always `transition` to what the rule returned without the store rejecting it. The rule reads exposure as data (`runs`, `passes`) rather than reading the population store itself, which is what keeps the benchmark package free of a dependency on the engine's population layer.

### Failure and recovery

An unknown id or an illegal transition rejects loudly, so a task can never skip a ladder step or escape a terminal state. Reads throw before the store starts.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §14, §15, and §35 — the benchmark-growth, protected-holdout, and contamination-control mechanism families this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-curriculum`](../evolution-curriculum/README.md) — the producer whose open proposals `/benchmark admit` promotes into fresh tasks.
- [`dsh-evolution-actuator`](../evolution-actuator/README.md) — the growth loop that mines recorded failures into tasks and advances them on recorded exposure.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-benchmark) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering a task into an evaluation run owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **No executor or judge** — the store holds tasks and states; nothing runs a task or scores a candidate yet (the optimizer and scorer evaluate their own recorded corpora, and wiring them to the benchmark states is the evaluation work ahead).
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

</details>