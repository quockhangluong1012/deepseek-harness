---
description: "Population-based evolution: every staged optimizer write becomes a durable per-skill candidate with generation numbering, parent lineage, and the stage → approve/reject lifecycle (ctx.evolutionPopulation)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-population

English | [中文](README.zh.md)

## Summary

`dsh-evolution-population` keeps the optimizer's staged writes as a cross-run per-skill population: each candidate records its generation, its parent candidate, the mutation operator that produced it, its novelty, and its measured triple, and carries one standing — `staged`, then `approved` or `rejected`. The elite ranking (pass, then fewer tokens, then faster wall time) decides what a skill keeps. The optimizer records every staged write through the optional store seam, and the host command `command-evolution` inspects the population through `/population`. Nothing here calls a model.

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

Mount the plugin with the storage domain. Candidates arrive from the optimizer's staged writes whenever the store is mounted; operators read the population and decide standings.

```ts
await ctx.evolutionPopulation.record({
  skill: 'writer',
  candidateId: 'staged-0',
  operator: 'rewrite',
  novelty: 0.5,
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
  status: 'staged',
})
const elite = ctx.evolutionPopulation.elite('writer')
```

`record(input)` auto-wires lineage: the previous head of the same skill becomes the parent, and the generation is one past the skill's current highest. `candidates(skill?)` lists candidates newest first; `generation(skill)` reports the skill's current generation; `lineage(skill, candidateId)` walks one candidate's ancestors oldest first; `elite(skill)` ranks the approved candidates by pass, then fewer tokens, then faster wall time. `updateStatus(candidateId, status)` moves a staged candidate to `approved` or `rejected`; approved and rejected are terminal. The `/population` command lists a skill's population, walks one lineage, and approves or rejects staged candidates.

### Configuration

None — the store takes no deployment choices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Lineage and ranking are pure. `nextGeneration` is one past the highest generation present for a skill (1 when none), computed over complete rows only. `lineageChain` walks `parentCandidateId` from the oldest ancestor to the candidate, tolerating dangling parents and cycles. `rankElite` orders approved candidates by pass, then tokens, then wall time, with unmeasured candidates ranked below every measured one. The head is `headOf`: the highest generation, newest `at` tie first — so equal-generation rows resolve deterministically by `at`.

The store is a per-candidate domain: `evolution_population` version 1 with one `candidates` table keyed by candidate identity, holding `{ candidateId, skill, parentCandidateId, operator, generation, novelty, triple, status, at }`. Status transitions are a small fixed map: `staged` → `approved` | `rejected`, terminal statuses never leave, and a same-status call resolves without writing.

### Failure and recovery

An unknown candidate id or an illegal transition rejects loudly; reads throw before the store starts. Candidate ids are the optimizer's staged write ids, so a `/population` id always names a real staged write.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §51 — the population-based evolution mechanism family this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the producer whose staged writes become candidates through the optional recorder seam.
- [`dsh-evolution-evaluator-health`](../evolution-evaluator-health/README.md) — the sibling store whose verdict recorder seam follows the same optional-mount pattern.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering candidate facts into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Competition is a ranking, not a pipeline** — the elite is a sorted view of approved candidates; nothing yet runs the elite's bodies through evaluation loop after loop to breed the next generation.
- **Generation advances only through `record`** — a candidate is always one past the skill's highest generation, so direct domain writes could create equal generations whose head resolves by `at` instead.
- **Host-wide, not scope-keyed** — candidates are global; a per-scope population needs a scope key on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the population package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. Lineage helpers tolerate malformed chains by construction, so a corrupt parent link degrades to a shorter lineage instead of an infinite walk.

</details>