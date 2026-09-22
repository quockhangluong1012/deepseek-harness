# Agent Note: Adaptive model routing

Status: implemented

English | [中文](2026-09-21-adaptive-model-routing.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "adaptive model routing" as P1 #20, and §28 prescribes the topology: task execution, reflection, candidate generation, evaluation, and final promotion review each deserve a different model — the AlphaEvolve lesson is an ensemble of faster/broader and stronger/deeper models for different roles. The harness had a single configured route per optimizer (provider/model config) and a client model-selection directory, but no durable record of which route each evolutionary role used, how each route measured, or which route a role should prefer.

## Decision

One new package, `dsh-evolution-model-routes`, holding per-role routes with evidence:

1. **The role topology is the spec's.** `EvolutionRole` is the §28 list in order: task-execution, reflection, candidate-generation, evaluation, promotion-review. Each role carries its own assignment set and evidence.
2. **Evidence comes from real runs.** The optimizer records every candidate-generation route and its winner's triple through the optional store seam right after staging (the same optional-mount pattern as the population and evaluator-health recorders). A failing record logs a warning and never fails the optimization.
3. **Pins outrank evidence; evidence follows.** `pin` records the operator's explicit assignment; `observe` upserts a route as `observed` but never downgrades a pin. `recommend` returns the newest pinned assignment when one exists, otherwise the route with the highest pass rate and fewest mean tokens among measured routes, and nothing for a role with neither.
4. **One durable domain, one command surface.** The `evolution_model_routes` domain (v1) holds `routes` (keyed by role+route) and `evidence` (keyed by outcome id). `/routes` lists per-role assignments with their recommended routes, pins one, or reads the newest evidence. The package is mounted in the web-app profile (it writes only its own domain and reaches no model prompt).

## Alternatives considered

- Extend the optimizer's single provider/model config into a per-role map — rejected: the config would hardcode the route table the spec wants learned and stored, and the optimizer already owns governance hand-offs to stores rather than growing a routing policy.
- Reuse the client model-selection directory — rejected: it is a settings-backed default for agent entry points, not a durable evidence store keyed by evolutionary role.
- Let `recommend` change the optimizer's route — rejected: enforcement stays a manual operator pin (the recorded-not-enforced stance of §58.12); the optimizer keeps its configured route authoritative and merely reports the route it used.

## Consequences

- Route choice is now evidence-backed and inspectable: `/routes` shows which candidate-generation route measured best, and operators can pin a role to any provider/model.
- The §28 topology is durable vocabulary: consumers can observe the other roles (evaluation, reflection, promotion-review) into the same store as they land.
- The optimizer stays decoupled: recording is optional and failure-isolated.

## Deviations from the plan

None beyond routine. `RouteSummary` carries its `role` field so topology ordering and the recommendation filter stay per-role; the pure `bestRoute` deliberately drops a last-at tie-break because evidence rows always carry a newest instant, and `mergeEvidence` reports unmeasured routes at zero without a dead fallback branch.

## Testing

Route helpers: key separation, per-role evidence aggregation with pass rate/mean tokens/newest instant, other-role isolation, provider/model ordering, unmeasured-at-zero, recommendation by newest pin then best pass rate then fewer mean tokens, unmeasured and empty-role exclusions, topology order. Store: observe with evidence and auto-observed rows, pin preserved across later observes, pin create and flip, per-role summaries in topology order with detached copies, evidence listing with role/route filters and newest-first tie-breaks, recommend pinned-then-evidence-then-nothing, restart persistence through the zod spec, reads-before-start. Optimizer hook: route and outcome recorded into a mounted store, staging unchanged when unmounted, failing store logs a warning. `/routes`: unmounted, grammar usage across pin/evidence roles, assignment listing with recommendations, pin with store-error propagation, evidence listing with and without role filter, registration and disposal. 17 model-routes tests, 3 new optimizer tests, and 4 new command tests pass; the new package is at 100% statements/branches/functions/lines, and the optimizer stays at 100%.

## Left alone

Recommendation is advisory: only the optimizer's candidate-generation role records evidence today, and enforcing recommended routes for the other roles is the adaptation work ahead (documented in the package's Known Limitations). Routes are host-wide, not scope-keyed; per-scope keying is deferred. It does not touch the client model-selection directory, which keeps serving agent entry points.