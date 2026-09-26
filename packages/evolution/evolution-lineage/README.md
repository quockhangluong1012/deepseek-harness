---
description: "Dependency-aware evolution: dependency-versioned experiment envelopes with comparability checks and ablation attribution (ctx.evolutionLineage)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-lineage

English | [中文](README.zh.md)

## Summary

`dsh-evolution-lineage` keeps a log of dependency-versioned experiment envelopes (one per evaluated candidate) so metric comparisons are apples-to-apples. Each envelope records its measured triple, outcome, and dependency versions; `compare` reports whether two envelopes agree on the configured keys and what changed. `attributeImprovement` credits a gain to one change, both, or their interaction from ablation arms; every envelope carries its seeds, so any run replays. A second table keeps a linear revision chain per policy, so a policy version is diffable, reproducible, and reversible from recorded bodies. Comparisons are recorded facts, never gates; nothing calls a model.

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

Mount the plugin with the storage domain. Envelopes arrive from the optimizer's evaluated candidates whenever the store is mounted; operators read envelopes, compare dependency versions before trusting a metric delta, and replay a run from its seeds.

```ts
await ctx.evolutionLineage.record({
  experimentId: 'exp-0',
  skill: 'writer',
  candidate: 'c1',
  tasks: ['t1'],
  metrics: { pass: true, tokens: 3, wallTimeMs: 5 },
  outcome: 'improved',
  regressions: [],
  dependencies: { skill: 's1', evaluator: 'e1' },
  seeds: [7],
})
const verdict = ctx.evolutionLineage.compare('exp-0', 'exp-1')
if (verdict?.comparable) console.log('apples-to-apples')
```

`record(input)` stamps the envelope's recording instant and stores it under its experiment identity. `experiments(skill?)` lists envelopes newest first; `envelope(id)` reads one envelope detached, or undefined when unknown; `compare(idA, idB)` reports whether the two envelopes agree on the configured compared keys and names the changed keys, or undefined when either id is unknown; `replay(id)` returns the detached envelope whose seeds reproduce the run. `amendOutcome(id, outcome, rejectedReason?)` updates an existing envelope's outcome and rejection reason in place, leaving every other field untouched, and throws for an unknown id — `command-evolution`'s `/canary reject`/`/canary rollback` call it so a candidate's recorded `'improved'` verdict does not outlive the operator decision that reversed it.

Policies are versioned in the same store. `recordRevision({ policy, body, benchmark? })` appends one revision, and the store owns the arithmetic: it assigns the next version number for that policy, hashes the body (sha256-hex), and diffs it against the revision it replaces, so a caller cannot record a version, a digest, or a diff that disagrees with the body. Recording the bytes the chain's head already carries is a no-op; recording an older revision's bytes is a real revision, so a revert lands as a new version instead of rewriting history. `revisions(policy)` lists the chain oldest first with every revision's body, which is what makes a policy diffable and restorable without reading the file the body was written from.

```ts
await ctx.evolutionLineage.recordRevision({ policy: 'skill:writer', body: nextBody, benchmark: 'scorer-v1:…' })
const chain = ctx.evolutionLineage.revisions('skill:writer')
const last = chain.at(-1)
if (last !== undefined) console.log(`r${last.version} +${last.diff.addedLines} -${last.diff.removedLines}`)
```

The optimizer records a promotion here, so `skill:<name>` chains follow what actually landed; nothing records a candidate that was never promoted.

### Configuration

The store's deployed choices, with defaults suitable for an ordinary cadence; validated with defaults so an unconfigured mount still runs.

| Key | Default | Meaning |
|---|---|---|
| `comparedKeys` | `['skill', 'evaluator', 'retriever', 'model']` | Dependency keys two envelopes must agree on to compare. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Comparison is pure. `DEPENDENCY_KEYS` names every versioned dependency in canonical order — prompt, skill, retriever, evaluator, model, tool, env. `changedDependencies` reports the given keys whose versions differ in the given order, and an undefined version against a recorded one counts as changed, so an experiment measured under an unknown dependency never silently compares with one measured under a known version. `comparable` holds exactly when no compared key changed. `attributeImprovement` credits an ablation from its four arms: the joint arm must pass for any credit, both single arms passing credits both changes, one passing credits it, and neither passing alone credits the interaction — neither change reproduces the joint gain on its own, so no single arm earns it.

The store is a per-experiment domain: `evolution_lineage` version 2 with one `experiments` table keyed by experiment identity, holding the envelope with its hypothesis, candidate, operator, tasks, measured triple, outcome, regressions, rejected reason, lessons, dependency versions, seeds, and recording instant, and one `revisions` table keyed by policy identity and revision number, holding each revision's digest, parent digest, line diff, body, benchmark, and recording instant. Comparability derives from the two envelopes at read time, so configuration changes re-rank what compares without rewriting recorded envelopes.

`lineDiff` counts the lines a body change added and removed by longest common subsequence, so unchanged lines in place cost nothing and every other line counts once on its own side; a pure reorder counts as change, because order is content. It is the same arithmetic the optimizer's promotion diff and the curator's patch preview use, and it lives here because a revision chain needs it. `revisionKey(policy, version)` is the one place the stored key format is defined.

### Failure and recovery

Reads throw before the store starts. `compare` returns undefined when either experiment id is unknown, so an operator never mistakes a missing record for agreement. `replay` returns the detached envelope whose seeds reproduce the run. Invalid rows fail the domain open loudly: an envelope measured under an unknown lineage is not reinterpretable, and a dropped revision would silently break a policy's chain.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §34, §36, §48 — the dependency-aware evolution, artifact lineage and causal attribution, and reproducible experiments this package implements.
- [Evolution Engine specification](../../../specs/deepseek-harness-2.0-evolution-spec.md) §14.5 — policy versioning, which the revision chain implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the producer whose evaluated candidates become envelopes through the optional recorder seam.
- [`dsh-evolution-population`](../evolution-population/README.md) — the sibling store whose candidate parentage is the per-generation lineage this package's envelopes reference.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering envelope facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Records comparability, does not enforce it** — the store reports whether two envelopes compare (§58.12: trust is recorded, not enforced); refusing an incomparable promotion remains an operator's job.
- **Two-factor ablation only** — attribution credits A, B, both, or their interaction; three-way and factorial designs are not modeled.
- **No automatic re-measurement** — a retired comparison stays incomparable until an operator records a fresh envelope under the new versions.
- **A revision chain stores whole bodies** — every revision keeps the exact bytes it committed, which is what makes it diffable and restorable; nothing prunes old revisions, so a long-lived, frequently revised policy grows with its history.
- **A chain is linear per policy** — revisions are numbered in commit order and never branch, so two concurrent producers of the same policy do not create a merge point: the second one to commit becomes the next revision, whatever it based its body on.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the lineage package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. Comparability derives from stored envelopes at read time so configuration changes re-rank what compares without rewriting recorded envelopes.

</details>
