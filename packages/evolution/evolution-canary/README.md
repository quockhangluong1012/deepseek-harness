---
description: "Shadow/canary deployment tracking: durable rollout states of staged skill patches with measured shadow evidence, plus the §49 risk model that decides which step a change's risk class licenses (ctx.evolutionCanary)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-canary

English | [中文](README.zh.md)

## Summary

`dsh-evolution-canary` deploys staged skill patches deliberately: every staged optimizer write enters as `shadow` through the optional recorder seam, recorded, never gated, so nothing changes user-visible behavior (§58.12). Operators roll it to `canary` and `promoted` through `/canary`, or exit staged rollouts to `rejected` or `rolled-back`; terminal states never leave. Each deployment keeps its measured shadow triple: cost/quality evidence accompanies the rollout. §49's risk model rides along: `assessRisk` graduates a proposed change (artifact kind, evidence strength, reversibility, holdout coverage) into a risk class and the step it licenses, which the actuator's rollout monitor consults before promoting. Nothing here calls a model.

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

### Risk routing (§49)

`assessRisk(input)` answers §49's two questions in one call: how risky a proposed change is, and which step that risk licenses. It reads four facts about the change and returns a `RiskClass` with its `RiskRoute`.

```ts
const { risk, route } = assessRisk({
  // What the change mutates: a skill body, or a scope-wide memory entry.
  artifact: 'skill',
  // How strong the recorded evidence is: 'strong' | 'partial' | 'none'.
  evidence: 'strong',
  // Whether a wrong bet can still be undone.
  reversible: true,
  // Whether §15's protected holdout covers the artifact's capability.
  holdout: true,
})
// risk: 'low', route: 'auto-promote'
```

| Risk class | Route | Reached when |
|---|---|---|
| `low` | `auto-promote` | Strong evidence, a reversible change, and a covered holdout — no aggravation at all |
| `medium` | `canary` | Exactly one of the three aggravations |
| `high` | `human-approval` | Two or more aggravations, or a change that cannot be undone |
| `uncertain` | `human-review` | Nothing was measured |

The three aggravations are a scope-wide `memory` artifact — which every later session in the scope retrieves, unlike a skill body a session reads only when it selects that skill — `partial` evidence, which proves a result without proving an improvement, and an uncovered holdout, because §15 forbids resting a promotion on the dataset that generated the candidate. They stack: any two make the change high-risk, and reversibility is a floor rather than a counterweight, so a reversible change with three aggravations still needs approval. No measurement short-circuits the rest — a change nothing measured is `uncertain` whether or not it can be undone, because there is no evidence to reason about at all. Nothing here performs a route: `auto-promote` is permission for a caller that already has the evidence, and `human-approval` and `human-review` name the operator step the existing staged-write approval already provides.

### Configuration

None — the store takes no deployment choices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The rollout is a small pure state machine: `nextStage` walks `shadow → canary → promoted` and stops at each terminal state, and `transitionAllowed` answers the ladder edges plus the two exits (`shadow → rejected`, `canary → rolled-back`), with terminal states that never leave. A same-state call resolves without writing.

`risk.ts` is the second pure module: `assessRisk` is one function over a structural `RiskInput`, so §49's table is a unit test rather than a host fixture. It counts aggravations rather than ranking them, which is what makes "two or more" a single rule instead of a combinatorial table, and it treats no measurement as its own class — `uncertain`, not `high` — because a missing measurement is not a strong signal of danger; it is the absence of any signal, and §49 routes that to review rather than to approval.

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
- **The risk model grades what it is told** — `assessRisk` assigns no risk class itself: `reversible` and `holdout` are the caller's claims, `evidence` is the caller's grade, and the function only applies §49's table to them. A caller that reports `reversible: true` for a change it cannot undo gets a lower class than it should, which is why the actuator derives all four fields from recorded state (`rolloutRisk`) rather than restating them by hand.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the canary package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. The state machine lives in the pure `stages` module, so adding a state later only needs `TRANSITIONS` and `nextStage` to answer for it; `decidedAt` distinguishes a live rollout from a decided one without a second state dimension. §49's risk model lives here rather than in the actuator because the rollout ladder is what gives a change its reversibility — a `canary` deployment can still exit to `rolled-back` — so the class and the ladder are two readings of the same staged-write lifecycle, and the actuator stays a performer of rules other packages own.

</details>