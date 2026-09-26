---
description: "Model routing: the durable history of which provider/model each evolutionary role ran on, with measured evidence, the per-task-class effectiveness and ranking, the §44 disagreement signal, and the per-run separation-of-duties check (ctx.evolutionModelRoutes)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-model-routes

English | [中文](README.zh.md)

## Summary

`dsh-evolution-model-routes` is the single owner of runtime model routing. It records which provider/model each evolutionary role — task execution, reflection, candidate generation, evaluation, promotion review — used, how each route measured per task class, and which identity filled each role of a run. Optimizer outcomes arrive through the optional store seam and operators pin routes with `/routes`; `recommend` answers which route a role should use, `effectiveness` and `/router` expose the per-task-class numbers behind it, and `conflicts` names routes that both produce and judge work. The same store answers §44's route disagreement as an uncertainty signal and §53's separation of duties: a promotion or verdict signed by the candidate's own generator is refused, with both roles named. Nothing here calls a model.

This package absorbed `dsh-evolution-router` (retired). Its per-task-class route outcomes, its effectiveness derivation, its ranking, and its §44 disagreement now live here; the recorded `evolution_router` domain is imported on startup so that history is not lost.

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

Mount the plugin with the storage domain. Outcomes arrive from the optimizer's staged writes whenever the store is mounted; operators read assignments, pin routes, and read the measured evidence. A caller that takes a promotion or a verdict records who filled each role of the run and reads the separation-of-duties check before it decides.

```ts
await ctx.evolutionModelRoutes.observe({
  taskClass: 'writer',
  role: 'evaluation',
  route: { provider: 'deepseek', model: 'deepseek-chat' },
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
})
await ctx.evolutionModelRoutes.pin('evaluation', 'deepseek', 'deepseek-reasoner')
const ranked = ctx.evolutionModelRoutes.recommend('evaluation')
const scoped = ctx.evolutionModelRoutes.recommend('evaluation', 'writer')
const effective = ctx.evolutionModelRoutes.effectiveness('writer', 'evaluation')
const conflicts = ctx.evolutionModelRoutes.conflicts()
const disagreeing = ctx.evolutionModelRoutes.disagreements('writer', 'evaluation')

await ctx.evolutionModelRoutes.recordDuty({ runId: stagedId, role: 'candidate-generation', identity: 'session-42' })
await ctx.evolutionModelRoutes.recordDuty({ runId: stagedId, role: 'promotion-review', identity: 'operator' })
const separation = ctx.evolutionModelRoutes.checkDuties(stagedId, 'promotion')
// { allowed: true }, or a refusal whose reason names both roles.
```

`observe(input)` records one measured outcome, upserts the route as `observed` (a pinned route keeps its pin), and — for a task-class-scoped outcome — re-checks §44's disagreement. Omitting `taskClass` records an outcome measured for the role as a whole. `pin(role, provider, model)` pins one route for one role; pinned assignments outrank every measured route in `recommend`. `routes(role?)` lists per-role assignments merged with their evidence as summaries pooled over the role's task classes, and `evidence(role?, route?)` lists the raw outcomes newest first. `conflicts()` names every route assigned to both a producing role — task execution, reflection, candidate generation — and a judging role — evaluation, promotion review — with `pinned` recording whether an operator chose it. `/routes` prints the assignments with their recommended routes, pins one, or reads the evidence; `/router` prints the per-task-class effectiveness and the recommendation.

`recommend(role, taskClass?)` is the one recommendation: the role's pinned assignment when one exists, otherwise the best-ranked route with at least `minimumRuns` recorded runs. Without a `taskClass` it ranks the role's runs pooled across its task classes; with one it ranks only that class's routes. The returned entry carries the numbers behind the rank, so a caller says why it chose the route. The default `minimumRuns` of 1 is the union of what the two merged stores did: the route store named a role off one observed run, and the retired router store withheld a name until three. Neither side loses a recommendation here — a deployment that wants the wider margin sets `minimumRuns: 3`. `effectiveness(taskClass?, role?)` derives those numbers per task class, role, and route, and `disagreements(taskClass?, role?)` reports the §44 pairs whose pass rates diverge by more than `disagreementThreshold`.

`recordDuty({ runId, role, identity })` records which identity filled one evolutionary role of one run, replacing a role re-recorded in the same run, and `duties(runId)` lists one run's fills in role-topology order. `checkDuties(runId, decision)` answers §53's separation of duties for `promotion` — candidate generation against promotion review — or `verdict` — candidate generation against evaluation: `{ allowed: true }` when the two recorded identities differ, and otherwise a refusal that names both roles and the identity that filled them (`same-identity`), or names the role with no recorded identity (`unknown-identity`), because an unrecorded role is never assumed distinct. `dsh-command-evolution` is the shipped caller for the promotion half: `/curator opti…

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `minimumRuns` | `1` | Recorded runs a measured route needs before `recommend` will name it. The default of 1 keeps a thin-history role answerable; raise it to demand a wider margin. A pin is exempt. |
| `disagreementMinimumRuns` | `3` | Recorded runs a route needs before §44's comparison measures it. |
| `disagreementThreshold` | `0.5` | Pass-rate gap at which two routes count as disagreeing strongly. |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Aggregation and ranking are pure and shared. `mergeEvidence` folds one role's evidence rows into per-route summaries pooled over its task classes — runs, passes, pass rate, mean tokens, mean wall time, and the newest instant — with unmeasured routes reported at zero. `effectivenessRows` groups the class-scoped outcomes by task class, role, and route into `RouteEffectiveness` rows. Both carry the same `RouteMeasurement` numbers, so one `rankRoutes` scores them identically: a beta-prior-smoothed pass rate scaled by how close the run count is to `minimumRuns`, so a barely-measured route cannot outrank a well-measured one. `recommend` then applies the only policy on top — a pin wins, otherwise the first ranked route past the gate. §53's rule is pure too: `separationOfDuties` reads the role pair a decision separates and compares the two recorded identities.

The store is a per-record domain: `evolution_model_routes` **version 2** with a `routes` table keyed by role+route, an `evidence` table keyed by evidence identity, and a `duties` table keyed by run+role, holding `{ role, provider, model, origin, at }`, `{ id, role, provider, model, pass, tokens, wallTimeMs, at, taskClass? }`, and `{ runId, role, identity, at }`. The role vocabulary is the §28 topology in order. A duty key joins run and role with a separator no role carries, which keeps it injective per run and role and path-safe for the per-record layout.

### Recorded history across the merge (version 1 → 2)

Two histories had to survive into this one package, and they arrive by different routes because they were two domains.

- **This domain's own version 1** is read directly: the spec declares `compatibleVersions: [1]`, and version 2 only *adds* the optional `taskClass` to an outcome. A version-1 row has no task class and reads as an outcome measured for the role as a whole — it counts in `routes` and reaches no per-class ranking. Nothing is rewritten on disk.
- **The retired `evolution_router` domain** is a different unit, so no version stamp can bridge it. `importRouterOutcomes` opens that domain read-only at init, copies each outcome into `evidence` under its original record key, and creates the route assignment the observation implies — but only when the route has none, so an operator's later pin is never reverted. Re-running the import converges on the same rows, and the retired unit is left untouched.

### Topology conflicts (§28)

`roleConflicts` groups the assignment set by route and reports every route that appears on both sides of §28's topology — a producing role and a judging role — in topology order, with `pinned` recording whether an operator set it explicitly. A route on both sides means the judge and the judged run on the same model, so the verdict is the candidate's own output; the reading is recorded, never enforced, and `recommend` still answers from the assignments exactly as recorded.

### Separation of duties (§53)

A promotion is a decision about a candidate, and §53 requires the identity that reviews it to differ from the identity that generated it; a verdict is the same question asked of an evaluation. `SEPARATED_DUTIES` names the pair each decision separates — `promotion` pairs candidate generation with promotion review, `verdict` pairs candidate generation with evaluation — and `separationOfDuties` returns `allowed` when the run recorded two identities, or a refusal: `same-identity` naming both roles and the identity that filled them, `unknown-identity` naming the role with no recorded identity. A missing row and an empty identity both read as unrecorded, so the check fails closed rather than reading an absent record as a distinct identity; the identities are whate…

### Route disagreement (§44)

Two routes measured on the same task class and role whose pass rates diverge by more than `disagreementThreshold` disagree. `routeDisagreement` names the pair; `routeDisagreements` reports every such pair, strongest gap first. The store records the strongest one as a `disagreement` uncertainty signal through the optional `ctx.evolutionUncertainty` seam, keyed by task class, role, and the two routes so re-recording updates one signal instead of piling up copies. A signal the seam rejects is logged and the observation still stands.

### Failure and recovery

Reads throw before the store starts; a role with no assignment and no evidence recommends nothing rather than a made-up route. The optimizer records through the optional store so a deployment without this package sees zero behavior change, and the failing-store path logs a warning rather than failing an optimization.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §28 — the adaptive model-routing topology this package implements, sourced from AlphaEvolve's ensemble of faster/broader and stronger/deeper models — §44's route disagreement as a search signal, and §53, whose Multi-Agent upgrade is the separation of duties the `duties` table records.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-optimizer`](../evolution-optimizer/README.md) — the producer whose candidate-generation and evaluation routes and outcomes become evidence through the optional recorder seam.
- [`dsh-evolution-uncertainty`](../evolution-uncertainty/README.md) — the §44 seam that receives a strong route disagreement.
- [`dsh-evolution-adversary`](../evolution-adversary/README.md) — the observer whose `evaluator-rotation` defense reads this store's `evaluation` effectiveness.
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

- **Recommendation is advisory, not enforced** — `recommend` answers which route a role should use, but the optimizer keeps its configured route authoritative; wiring the roles' consumers to follow the recommendation is the adaptation work ahead.
- **Evidence comes from the optimizer only** — reflection and promotion-review routes have no recorded runs until their consumers observe them.
- **Role-wide outcomes rank for no class** — an outcome recorded without a task class counts in `routes` and in a role-wide `recommend`, but never in `effectiveness` or a class-scoped ranking, because per-class effectiveness is defined per class.
- **The retired-domain import runs at every startup** — it re-reads the `evolution_router` unit each time the store mounts. It converges and costs one empty-directory scan once the history is imported; retire it with the version-1 compatibility window.
- **Host-wide, not scope-keyed** — routes are global; a per-scope routing policy needs a scope key on the domain.
- **A conflict is a warning, not a block** — `conflicts` names a route that produces and judges, and nothing refuses the assignment: an operator's pin outranks the topology by design, so the reading exists to make the collision visible rather than to override it.
- **The refusal is enforced on the operator promotion, not on the monitor's** — `checkDuties` is consulted by `/canary promote <id>` in `dsh-command-evolution`: that command records its session as the reviewing identity and refuses the promotion when the run's recorded proposer is that same identity, the deployment staying where it is. The actuator's rollout monitor promotes on §49's `auto-promote` route, which the heartbeat decides with no session identity at all, so that automatic path records and checks no duty; the `verdict` half of the decision vocabulary has no consumer, because nothing records an `evaluation` identity.
- **Duties are recorded, never derived** — the store holds the identity a caller names and refuses when a role has none; it does not observe sessions, agents, or operators, so a deployment that never calls `recordDuty` gets `unknown-identity` for every run rather than a guessed verdict.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the model-routes package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. `RouteSummary` and `RouteEffectiveness` both extend `RouteMeasurement` on purpose: one ranking, one score, one `reason` sentence, so a role-wide and a class-scoped recommendation are comparable. `routeKey` is the single route identity, and `assignmentKey` and `effectivenessKey` compose it rather than re-spelling it. `separationOfDuties` takes the recorded duties as an argument so §53's rule is a unit test rather than a host fixture, and the store's `checkDuties` is that same rule over its own rows. When the version-1 window closes, delete `legacyRouterDomainSpec`, `importRouterOutcomes`, and `compatibleVersions`.

</details>
