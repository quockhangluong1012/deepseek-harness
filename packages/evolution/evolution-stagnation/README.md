---
description: "Stagnation detection: counts a skill's evaluation runs without meaningful improvement and names the next diversity strategy when the frontier stalls (ctx.evolutionStagnation)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-stagnation

English | [中文](README.zh.md)

## Summary

`dsh-evolution-stagnation` keeps a cross-run per-skill log of evaluation runs — one per staged optimizer write — and detects when a skill stops improving. Each run carries its measured triple and an improvement flag: it beat the skill's best, where token and wall-time gains must clear the floor first. Once a skill has stalled past the configured threshold, the detector names the next strategy and climbs §32's ladder — diversity, new operators, new tasks, evaluators, finally a new model. The optimizer records staged writes through the optional store seam, and `command-evolution` reads the status through `/stagnation`. Nothing here calls a model.

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

Mount the plugin with the storage domain. Runs arrive from the optimizer's staged writes whenever the store is mounted; operators read the status and reset a skill whose task regime changed.

```ts
await ctx.evolutionStagnation.recordRun({
  runId: 'staged-0',
  skill: 'writer',
  score: { pass: true, tokens: 3, wallTimeMs: 5 },
})
const status = ctx.evolutionStagnation.status('writer')
if (status.stagnant) console.log(status.strategy)
```

`recordRun(input)` numbers the run's generation tick one past the skill's run count and flags whether it meaningfully improved the skill's best. `runs(skill?)` lists runs newest first; `status(skill)` reports the best score, the runs since the last improvement, the stagnant flag against the configured threshold, and the strategy to follow now; `reset(skill)` drops a skill's history when a task regime changes. The `/stagnation` command renders the status, lists runs, and resets a skill.

### Configuration

The detector's deployed choices, with defaults suitable for an ordinary cadence; both are validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `threshold` | `5` | Runs without meaningful improvement before a skill is stagnant. |
| `relativeImprovement` | `0.05` | Minimum relative token or wall-time gain that counts as meaningful. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Detection is pure. `betterThan` compares one score to the best: the first score of a skill always improves the empty best, a pass gain dominates, and with pass unchanged a token reduction of at least `relativeImprovement` (or, with tokens unchanged, a wall-time reduction of that size) counts; anything below the floor is jitter. `bestOf` tracks the elite top — pass first, then fewer tokens, then faster wall time — with no floor. `generationsSince` counts runs after the last improved run, resetting at each improvement. `strategyFor` keeps normal exploitation below the threshold and climbs one ladder rung per full threshold span — `diversity`, `newOperators`, `newTasks`, `newEvaluators` — capped at `newModel`.

The store is a per-run domain: `evolution_stagnation` version 1 with one `runs` table keyed by run identity, holding `{ runId, skill, generation, score, improved, at }`. Status derives from the full run history at read time, so the improvement flag stays a recorded fact while the strategy always reflects the current configuration.

### Failure and recovery

Reads throw before the store starts. Run ids are the optimizer's staged write ids, so a `/stagnation` id always names a real staged write. `reset` removes only the named skill's runs, so one task regime change never erases another skill's history.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §32 — the stagnation detector this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the producer whose staged writes become runs through the optional recorder seam.
- [`dsh-evolution-novelty-search`](../evolution-novelty-search/README.md) — the sibling store whose archive novelty is the diversity lever §32's ladder names first.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering stagnation facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Records strategy, does not execute it** — the detector names the next strategy (§58.12: trust is recorded, not enforced); switching mutation operators, tasks, evaluators, or models remains an operator's job.
- **One triple per run** — a run is one measured triple; paired-run and multi-seed comparisons are not tracked.
- **Reset is a blunt instrument** — `reset` drops the whole skill history; a windowed or decayed history needs retention logic on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the stagnation package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. Status derives from history at read time so configuration changes re-rank the strategy without rewriting recorded runs.

</details>
