---
description: "Adversarial evolution: durable adversarial probes across eight weakness categories plus the evaluator-gaming defense checklist (ctx.evolutionAdversary)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-adversary

English | [中文](README.zh.md)

## Summary

`dsh-evolution-adversary` keeps a durable per-skill log of adversarial probes — one prompt or scenario per weakness family — across the eight §45 weakness categories, from edge cases and prompt injection to evaluator gaming. Each probe records whether it exposed a real weakness and whether the weakness was repaired. The challenge names the next category to probe so no family goes untested, rotating the least-probed once all are covered. Alongside sits the §46 evaluator-gaming defense checklist: six automatable defenses whose gaps show what still stands open. Nothing here calls a model.

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

Mount the plugin with the storage domain. Operators record adversarial probes as they run them, repair the weaknesses the probes expose, and read the challenge for the next category to probe; the checklist shows which evaluator-gaming defenses still stand open.

```ts
await ctx.evolutionAdversary.probe({
  probeId: 'writer-injection-1',
  skill: 'writer',
  category: 'prompt-injection',
  probe: 'Attempt to override the task instruction.',
  foundWeakness: false,
})
const challenge = ctx.evolutionAdversary.challenge('writer')
await ctx.evolutionAdversary.setDefense('hidden-holdout', true)
```

`probe(input)` records one probe as unrepaired; `setRepaired(probeId, repaired?)` marks it repaired once the weakness is fixed, defaulting to repaired. `probes(skill?)` lists probes newest first; `challenge(skill)` names the next category to probe under the configured minimum. `setDefense(defense, satisfied)` sets one checklist defense; `defenses()` renders the full checklist in canonical order; `defenseGaps()` names the defenses still open.

### Configuration

The store's deployed choices, with defaults suitable for ordinary probing; the minimum is validated with a default so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `minProbesPerCategory` | `1` | Probes per category and skill before the category counts as covered. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Coverage is pure. `categoryCoverage` counts one skill's probes per category, zero-filled so an unprobed category reads 0. `uncoveredCategories` names the categories still below the minimum in canonical order. `nextChallenge` takes the first uncovered category, or — when every category is covered — the least-probed category so probing rotates instead of stopping, with canonical order breaking ties. `weaknessRate` shares found weaknesses over the skill total, null without probes. `defenseGaps` names every canonical defense whose checklist row is missing or unsatisfied.

The store is a two-table domain: `evolution_adversary` version 1 with a `probes` table keyed by probe identity, holding `{ probeId, skill, category, probe, foundWeakness, repaired, at }`, and a `defenses` table keyed by defense, holding `{ defense, satisfied, at }`. The challenge derives from the full probe history at read time, so configuration changes re-rank the next category without rewriting recorded probes; a defense never set reads unsatisfied with a null instant, so the checklist renders before anything is set.

### Failure and recovery

Reads throw before the store starts. Repair is a separate explicit step, so a recorded weakness is never silently marked fixed; `setRepaired` on a missing probe id throws loudly. Defense rows are keyed by defense, so setting one defense never disturbs another.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check them against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §45 — the adversarial evolution this package implements, and §46 — the evaluator-gaming defense checklist it keeps.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-scorer`](../evolution-scorer/README.md) — `evaluatorDisagreement` is the dissent source worth probing: persistent disagreement across revisions marks the candidates adversarial probes should target first.
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.md) — the sibling store whose verdict agreement, approval drift, and false-positive tracking the defense checklist guards.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering probe facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Records probes, does not run them** — the store logs adversarial prompts and their repair state (§58.12: trust is recorded, not enforced); executing probes against a skill and judging weakness remains an operator's job.
- **One minimum for all categories** — `minProbesPerCategory` applies to every weakness family; per-category minimums need configuration on the store.
- **Checklist covers the automatable defenses** — human spot checks stay operator-side by design; the store tracks only the six defenses it can observe.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The store is record-only: nothing here calls a model, and probing, repair, and defense satisfaction are operator judgments recorded as facts. The challenge derives from history at read time so minimum changes re-rank the next category without rewriting probes, and unset defenses synthesize open rows so the checklist is safe to render from an empty store.

</details>
