---
description: "Adaptive model routing: durable per-role route assignments with measured evidence, the recommendation over the evolutionary role topology, and the per-run separation-of-duties check (ctx.evolutionModelRoutes)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-model-routes

English | [中文](README.zh.md)

## Summary

`dsh-evolution-model-routes` records which provider/model each evolutionary role — task execution, reflection, candidate generation, evaluation, promotion review — used and how each route measured, keeping §28's adaptive routing honest. Optimizer outcomes arrive through the optional store seam, operators pin routes with `/routes`, `recommend` returns the pinned assignment or the strongest evidence, and `conflicts` names routes that both produce and judge work. It also records who filled each role of a run and answers §53 separation of duties: a promotion or verdict signed by the candidate's own generator is refused, with both roles named. Nothing here calls a model.

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

Mount the plugin with the storage domain. Evidence arrives from the optimizer's candidate-generation runs whenever the store is mounted; operators read assignments, pin routes, and read the measured evidence. A caller that takes a promotion or a verdict records who filled each role of the run and reads the separation-of-duties check before it decides.

```ts
await ctx.evolutionModelRoutes.observe({
  role: 'candidate-generation',
  route: { provider: 'deepseek', model: 'deepseek-chat' },
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
})
await ctx.evolutionModelRoutes.pin('evaluation', 'deepseek', 'deepseek-reasoner')
const recommended = ctx.evolutionModelRoutes.recommend('candidate-generation')
const conflicts = ctx.evolutionModelRoutes.conflicts()

await ctx.evolutionModelRoutes.recordDuty({ runId: stagedId, role: 'candidate-generation', identity: 'session-42' })
await ctx.evolutionModelRoutes.recordDuty({ runId: stagedId, role: 'promotion-review', identity: 'operator' })
const separation = ctx.evolutionModelRoutes.checkDuties(stagedId, 'promotion')
// { allowed: true }, or a refusal whose reason names both roles.
```

`observe(input)` records one measured outcome and upserts the route as `observed` (a pinned route keeps its pin). `pin(role, provider, model)` pins one route for one role; pinned assignments outrank every observed route in `recommend`. `routes(role?)` lists per-role route assignments merged with their evidence as summaries, and `evidence(role?, route?)` lists the raw outcomes newest first. `conflicts()` names every route assigned to both a producing role — task execution, reflection, candidate generation — and a judging role — evaluation, promotion review — with `pinned` recording whether an operator chose it. The `/routes` command prints the assignments with their recommended routes, pins one, or reads the evidence.

`recordDuty({ runId, role, identity })` records which identity filled one evolutionary role of one run, replacing a role re-recorded in the same run, and `duties(runId)` lists one run's fills in role-topology order. `checkDuties(runId, decision)` answers §53's separation of duties for `promotion` — candidate generation against promotion review — or `verdict` — candidate generation against evaluation: `{ allowed: true }` when the two recorded identities differ, and otherwise a refusal that names both roles and the identity that filled them (`same-identity`), or names the role with no recorded identity (`unknown-identity`), because an unrecorded role is never assumed distinct. `dsh-command-evolution` is the shipped caller for the promotion half: `/curator optimize <skill> <scenario...>` records the session that staged the candidate as `candidate-generation`, and `/canary promote <id>` records the promoting session as `promotion-review` and reports its refusal instead of moving the deployment.

### Configuration

None — the store takes no deployment choices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Aggregation and recommendation are pure. `mergeEvidence` folds one role's evidence rows into per-route summaries — run counts, pass rate, mean tokens, and the newest instant — with unmeasured routes reported at zero. `bestRoute` recommends the newest pinned assignment first, then the route with the highest pass rate and fewest mean tokens among routes with at least one recorded run, and only when the role has no pin. §53's rule is pure too: `separationOfDuties` reads the role pair a decision separates and compares the two recorded identities.

The store is a per-record domain: `evolution_model_routes` version 1 with a `routes` table keyed by role+route, an `evidence` table keyed by evidence identity, and a `duties` table keyed by run+role, holding `{ role, provider, model, origin, at }`, `{ id, role, provider, model, pass, tokens, wallTimeMs, at }`, and `{ runId, role, identity, at }`. The role vocabulary is the §28 topology in order. A duty key joins run and role with a separator no role carries, which keeps it injective per run and role and path-safe for the per-record layout.

### Topology conflicts (§28)

`roleConflicts` groups the assignment set by route and reports every route that appears on both sides of §28's topology — a producing role and a judging role — in topology order, with `pinned` recording whether an operator set it explicitly. A route on both sides means the judge and the judged run on the same model, so the verdict is the candidate's own output; the reading is recorded, never enforced, and `recommend` still answers from the assignments exactly as recorded.

### Separation of duties (§53)

A promotion is a decision about a candidate, and §53 requires the identity that reviews it to differ from the identity that generated it; a verdict is the same question asked of an evaluation. `SEPARATED_DUTIES` names the pair each decision separates — `promotion` pairs candidate generation with promotion review, `verdict` pairs candidate generation with evaluation — and `separationOfDuties` returns `allowed` when the run recorded two identities, or a refusal: `same-identity` naming both roles and the identity that filled them, `unknown-identity` naming the role with no recorded identity. A missing row and an empty identity both read as unrecorded, so the check fails closed rather than reading an absent record as a distinct identity; the identities are whatever the caller recorded, because nothing in this package observes a session or an operator.

### Failure and recovery

Reads throw before the store starts; a role with no assignment and no evidence recommends nothing rather than a made-up route. The optimizer records through the optional store so a deployment without this package sees zero behavior change, and the failing-store path logs a warning rather than failing an optimization.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §28 — the adaptive model-routing topology this package implements, sourced from AlphaEvolve's ensemble of faster/broader and stronger/deeper models — and §53, whose Multi-Agent upgrade is the separation of duties the `duties` table records.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the producer whose candidate-generation routes and outcomes become evidence through the optional recorder seam.
- [`dsh-evolution-population`](../evolution-population/README.md) — the sibling store whose recorder seam follows the same optional-mount pattern.

-----

<a id="model-experience"></a>
## Model Experience

None, as this store registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. The optimizer's own mutation requests carry the route this store recommends; that request's prefix is the optimizer's.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Recommendation is advisory, not enforced** — `recommend` answers which route a role should use, but only the optimizer's candidate-generation role records evidence today, and the optimizer keeps its configured route authoritative; wiring the other roles' consumers and enforcing recommended routes is the adaptation work ahead.
- **Evidence comes from the optimizer only** — evaluation, reflection, and promotion-review routes have no recorded runs until their consumers observe them.
- **Host-wide, not scope-keyed** — routes are global; a per-scope routing policy needs a scope key on the domain.
- **A conflict is a warning, not a block** — `conflicts` names a route that produces and judges, and nothing refuses the assignment: an operator's pin outranks the topology by design, so the reading exists to make the collision visible rather than to override it.
- **The refusal is enforced on the operator promotion, not on the monitor's** — `checkDuties` is consulted by `/canary promote <id>` in `dsh-command-evolution`: that command records its session as the reviewing identity and refuses the promotion when the run's recorded proposer is that same identity, the deployment staying where it is. The actuator's rollout monitor promotes on §49's `auto-promote` route, which the heartbeat decides with no session identity at all, so that automatic path records and checks no duty; the `verdict` half of the decision vocabulary has no consumer, because nothing records an `evaluation` identity.
- **Duties are recorded, never derived** — the store holds the identity a caller names and refuses when a role has none; it does not observe sessions, agents, or operators, so a deployment that never calls `recordDuty` gets `unknown-identity` for every run rather than a guessed verdict.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the model-routes package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. `RouteSummary` carries its role so topology ordering and the recommendation filter stay per-role, and the grader never guesses a route for a role with no pinned or measured route. `separationOfDuties` takes the recorded duties as an argument so §53's rule is a unit test rather than a host fixture, and the store's `checkDuties` is that same rule over its own rows.

</details>