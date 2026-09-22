---
description: "Shadow/canary deployment tracking: durable rollout states of staged skill patches with measured shadow evidence (ctx.evolutionCanary)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-canary

English | [中文](README.zh.md)

## Summary

`dsh-evolution-canary` deploys a staged skill patch deliberately: every staged optimizer write enters this store in `shadow` through the optional recorder seam — recorded, never gated: nothing changes user-visible behavior (§58.12). Operators then roll a shadow patch to `canary` and `promoted` through `/canary`, or exit a still-staged rollout to `rejected` or `rolled-back`; terminal states never leave. The store holds each deployment's measured shadow triple beside its state, so cost/quality evidence accompanies the rollout decision. Nothing here calls a model.

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

Mount the plugin with the storage domain. Deployments arrive from the optimizer's staged writes whenever the store is mounted; operators advance or exit them.

```ts
await ctx.evolutionCanary.enter({
  id: 'staged-0',
  skill: 'writer',
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
})
await ctx.evolutionCanary.advance('staged-0', 'canary')
await ctx.evolutionCanary.advance('staged-0', 'promoted')
```

`enter(input)` records one deployment in `shadow`; each staged write starts exactly one deployment, so a duplicate id rejects loudly. `advance(id, to)` moves the deployment one ladder step per call (`shadow → canary → promoted`), lets each staged rollout exit to `rejected` or `rolled-back`, and rejects unknown ids and illegal transitions loudly. `deployments(state?, skill?)` lists records in ladder order newest first, and `summary(skill?)` counts per state with zeros never omitted. The `/canary` command reports the states, rolls a deployment forward, or exits one.

### Configuration

None — the store takes no deployment choices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The rollout is a small pure state machine: `nextStage` walks `shadow → canary → promoted` and stops at each terminal state, and `transitionAllowed` answers the ladder edges plus the two exits (`shadow → rejected`, `canary → rolled-back`), with terminal states that never leave. A same-state call resolves without writing.

The store is a per-record domain: `evolution_canary` version 1 with one `deployments` table keyed by staged write identity, holding `{ id, skill, state, triple, at, enteredAt, decidedAt }`. `decidedAt` is stamped only when a terminal decision lands, so a deployment mid-rollout always answers "still live".

### Failure and recovery

An unknown id or an illegal transition rejects loudly, so a deployment can never skip a stage or escape a terminal state; a duplicate id never silently re-enters shadow. Reads throw before the store starts. The optimizer records through the optional store so a deployment without this package sees zero behavior change, and the failing-store path logs a warning rather than failing an optimization.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §18 and §49 — the shadow → canary → gradual-promotion rollout and the medium-risk → canary human-in-the-loop rule this package implements, and §58.12 for the recorded-not-enforced boundary.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the producer whose staged writes enter shadow through the optional recorder seam.
- [`dsh-evolution-population`](../evolution-population/README.md) — the sibling store recording the same staged writes as candidates for competition.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A consumer rendering a deployment state into a prompt owns that request's prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Tracking, not enforcement** — entering shadow and rolling out change recorded state only; nothing gates a skill's visibility to the model (deliberately, per §58.12), so an untracked patch can still reach the model through other write paths.
- **Shadow measurements are the staging triple** — the store records the winner's measured triple, not a hidden-response comparison against a production baseline; that replay-based comparison is the deferred monitoring work (§18's compare step).
- **Host-wide, not scope-keyed** — deployments are global; a per-scope rollout policy needs a scope key on the domain.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the canary package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. The state machine lives in the pure `stages` module, so adding a state later only needs `TRANSITIONS` and `nextStage` to answer for it. `decidedAt` distinguishes a live rollout from a decided one without a second state dimension.

</details>