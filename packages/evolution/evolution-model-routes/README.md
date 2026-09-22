---
description: "Adaptive model routing: durable per-role route assignments with measured evidence and recommendation over the evolutionary role topology (ctx.evolutionModelRoutes)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-model-routes

English | [中文](README.zh.md)

## Summary

`dsh-evolution-model-routes` keeps the §28 adaptive-routing topology honest: each evolutionary role — task execution, reflection, candidate generation, evaluation, and final promotion review — may run on a different model, and this store durably records which provider/model each role used and how each route measured. The optimizer records every candidate-generation route and outcome through the optional store seam, operators pin assignments through `/routes`, and `recommend` answers which route a role should use: the pinned assignment when one exists, otherwise the route with the strongest recorded evidence. Nothing here calls a model.

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

Mount the plugin with the storage domain. Evidence arrives from the optimizer's candidate-generation runs whenever the store is mounted; operators read assignments, pin routes, and read the measured evidence.

```ts
await ctx.evolutionModelRoutes.observe({
  role: 'candidate-generation',
  route: { provider: 'deepseek', model: 'deepseek-chat' },
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
})
await ctx.evolutionModelRoutes.pin('evaluation', 'deepseek', 'deepseek-reasoner')
const recommended = ctx.evolutionModelRoutes.recommend('candidate-generation')
```

`observe(input)` records one measured outcome and upserts the route as `observed` (a pinned route keeps its pin). `pin(role, provider, model)` pins one route for one role; pinned assignments outrank every observed route in `recommend`. `routes(role?)` lists per-role route assignments merged with their evidence as summaries, and `evidence(role?, route?)` lists the raw outcomes newest first. The `/routes` command prints the assignments with their recommended routes, pins one, or reads the evidence.

### Configuration

None — the store takes no deployment choices.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Aggregation and recommendation are pure. `mergeEvidence` folds one role's evidence rows into per-route summaries — run counts, pass rate, mean tokens, and the newest instant — with unmeasured routes reported at zero. `bestRoute` recommends the newest pinned assignment first, then the route with the highest pass rate and fewest mean tokens among routes with at least one recorded run, and only when the role has no pin.

The store is a per-record domain: `evolution_model_routes` version 1 with one `routes` table keyed by role+route and one `evidence` table keyed by evidence identity, holding `{ role, provider, model, origin, at }` and `{ id, role, provider, model, pass, tokens, wallTimeMs, at }`. The role vocabulary is the §28 topology in order.

### Failure and recovery

Reads throw before the store starts; a role with no assignment and no evidence recommends nothing rather than a made-up route. The optimizer records through the optional store so a deployment without this package sees zero behavior change, and the failing-store path logs a warning rather than failing an optimization.

No invariant companion is published because the domain tables are the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-v11-deep-research.md) §28 — the adaptive model-routing topology this package implements, sourced from AlphaEvolve's ensemble of faster/broader and stronger/deeper models.
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

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The optimizer records through the optional store so a deployment without the model-routes package sees zero behavior change; the failing-store path logs a warning rather than failing an optimization. `RouteSummary` carries its role so topology ordering and the recommendation filter stay per-role, and the grader never guesses a route for a role with no pinned or measured route.

</details>