# Agent Note: Shadow/canary deployment

Status: implemented

English | [中文](2026-09-21-shadow-canary-deployment.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "shadow/canary deployment" as P1 #19, and §18 prescribes the rollout: before canarying a candidate, run it in shadow (a hidden response beside the production baseline), compare quality/cost/latency without changing user-visible behavior, then follow shadow → canary → gradual promotion. §49 adds the human-in-the-loop rule (medium-risk → canary). The harness staged skill patches with approval governance, but nothing tracked a patch's rollout state — which staged writes were still shadow, which were canary, which were promoted, and which were rejected or rolled back.

## Decision

One new package, `dsh-evolution-canary`, holding rollout states with shadow evidence:

1. **Recorded, never gated (§58.12).** The optimizer records every staged write as a `shadow` deployment through the optional store seam right after staging; nothing changes user-visible behavior and a failing record logs a warning instead of failing the optimization. Enforcement stays a deliberate operator action through /canary.
2. **The rollout is a small pure state machine.** `nextStage` walks `shadow → canary → promoted`; `transitionAllowed` answers the ladder edges plus the two staged exits (`shadow → rejected`, `canary → rolled-back`); terminal states never leave and a same-state call resolves without writing.
3. **One durable domain, one command surface.** The `evolution_canary` domain (v1) holds one `deployments` table keyed by staged write identity, with the measured shadow triple and a `decidedAt` stamped only at a terminal decision. `/canary` reports states (optionally per skill), rolls a deployment forward (`rollout`, `promote`), or exits one (`reject`, `rollback`). The package is mounted in the web-app profile (it writes only its own domain and reaches no model prompt).

## Alternatives considered

- Extend the population store with deployment states — rejected: the population records candidates for competition (lineage, elite ranking); the canary records rollout intent with its own exit lifecycle, and one package one lifecycle keeps each state machine small.
- Reuse the benchmark's contamination ladder — rejected: that ladder governs evaluations (fresh → search → validation → holdout); the deployment ladder governs rollout and its exits are reject/rollback, not contamination.
- Make rollout automatic — rejected: §58.12 records trust and surfaces it rather than gating visibility; automatic promotion would be enforcement, not tracking.

## Consequences

- Rollout state is durable and inspectable: `/canary` shows which staged writes are shadow, canary, or promoted, with each one's measured triple.
- A staged patch can never silently skip a stage or escape a terminal state: unknown ids and illegal transitions reject loudly, and a duplicate staged write id never re-enters shadow.
- The optimizer stays decoupled: recording is optional and failure-isolated, sharing the pattern with the population and model-routes recorders.

## Deviations from the plan

None beyond routine. The command names the ladder verbs explicitly (`rollout`/`promote`/`reject`/`rollback`) rather than a bare state argument, so an operator cannot typo a state name past the grammar.

## Testing

States: ladder walk and terminal stops, allowed ladder and exit transitions, forbidden skips, terminal and cross exits, topology order. Store: shadow entry with measured triple, duplicate rejection, unmeasured triple, ladder advance with `decidedAt` stamping, staged exits, terminal immobility, unknown ids, same-state no-op, listing in ladder order with state/skill filters and detached copies, per-state summary with zeros never omitted, restart persistence through the zod spec, reads-before-start. Optimizer hook: staged write entered as shadow into a mounted store, staging unchanged when unmounted, failing store logs a warning. `/canary`: unmounted, grammar usage across all verbs, state listing with next-stage hints and skill filtering, advance verbs with store-error propagation, registration and disposal. 11 canary tests, 3 new optimizer tests, and 3 new command tests pass; the new package is at 100% statements/branches/functions/lines, and the optimizer stays at 100%.

## Left alone

Tracking is not enforcement: nothing gates a skill's visibility to the model, and shadow measurements are the winner's staging triple rather than a hidden-response comparison against a production baseline — that replay-based comparison is the deferred monitoring work (§18's compare step, documented in the package's Known Limitations). Deployments are host-wide, not scope-keyed; per-scope keying is deferred. It does not touch the memory-store approval governance, which keeps approving staged writes.