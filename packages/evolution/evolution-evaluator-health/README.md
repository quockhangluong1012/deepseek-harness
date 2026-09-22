---
description: "Evaluator ensemble health: judge agreement, approval-rate drift, and false-positive tracking over recorded behavior-evaluation verdicts (ctx.evolutionEvaluatorHealth)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-evaluator-health

English | [中文](README.zh.md)

## Summary

`dsh-evolution-evaluator-health` keeps the evaluator itself honest: it durably records every behavior-evaluation verdict the scorer produces and aggregates the health facts that tell whether the judging is drifting or being gamed — judge agreement (unanimity), approval-rate drift against the newest window, false positives (an approval later contradicted by a same-skill rejection), and per-channel approval. Nothing here calls a model. The scorer's behavior evaluation records into it, and the host command `command-evolution` reports it through `/evaluators`.

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

Mount the plugin with the storage domain; verdicts arrive from the scorer's `evaluateBehavior` whenever the store is mounted.

```ts
await ctx.evolutionEvaluatorHealth.observe({
  skill: 'polish',
  unanimous: false,
  status: 'evaluated',
  approved: false,
  approving: ['contract', 'routing'],
  dissenting: ['replay'],
})
const health = ctx.evolutionEvaluatorHealth.summary()
console.log(`${health.approvalRate * 100}% approved, drift ${health.drift * 100} points, false positives ${health.falsePositiveRate * 100}%`)
```

`observe(input)` records one verdict, rejecting skipped evaluations (a skipped run has no judgment). `runs(skill?)` lists recorded verdicts newest first, optionally filtered by skill. `summary()` aggregates: overall and recent approval rates with drift, unanimous agreement, false positives as a share of approvals, and one row per channel. The `/evaluators` command prints the summary or the newest verdicts.

### Configuration

The drift window is a validated `Config` member changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-evaluator-health'
  config:
    driftWindow: 20
```

| Field | Default | Meaning |
|---|---|---|
| `driftWindow` | `20` | Verdicts the recent-drift window covers |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-evaluator-health) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Verdicts are durable per-record rows in the `evolution_evaluator_health` domain (v1, one `runs` table keyed by verdict id): `{ id, skill, unanimous, status, approved, approving, dissenting, at }`. The aggregation is pure: `summarizeHealth(runs, window)` consumes verdicts newest first, takes the newest `window` as the recent slice, and computes approval, unanimity, and drift (recent minus overall). A false positive is an approved verdict for which a NEWER same-skill verdict rejected — counted against the approvals, so the rate asks "of the times we approved, how often did the same skill later get rejected?"

### Failure and recovery

A skipped evaluation records nothing and rejects loudly if offered. Unknown skills never filter anything: an absent skill reads as an empty list. Reads throw before the store starts.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §13 and §46 — the evaluator-ensemble and evaluator-gaming-defense mechanism families this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-scorer`](../evolution-scorer/README.md) — the producer whose behavior evaluation records each verdict into this store.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-evaluator-health) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering health facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Health tracks behavior evaluations only** — verdicts from the scorer's `evaluateBehavior` are the whole source; optimization runs and replay scores outside that path are not recorded.
- **False positives are an internal proxy** — the store compares verdicts against each other, not against human outcomes; correlation with real-user results is the deferred calibration work.
- **Host-wide, not scope-keyed** — verdicts are global; a per-scope view needs a scope key on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The scorer records through the optional store so a deployment without the health package sees zero behavior change; the failing-store path logs a warning rather than failing an evaluation. Drift is recent-minus-overall approval share, so a positive value means approvals are rising.

</details>