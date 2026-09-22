# Agent Note: Population-based evolution

Status: implemented

English | [中文](2026-09-21-population-based-evolution.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "population-based evolution" as P1 #11: staged optimizer writes should accumulate into a cross-run, per-skill population so that generations, lineages, and an approved elite can guide what a skill keeps, instead of each optimization run being an island where the previous winner carries no history. The optimizer staged skill patches but nothing durable remembered which operator produced which body, at which generation, with which parent, and how it measured.

## Decision

One new package, `dsh-evolution-population`, holding candidates with lineage and standings:

1. **Every staged write is a candidate.** The optimizer records each staged write through the optional store seam right after `stageWrite`: the candidate id is the staged write id, with the operator, novelty, the measured triple, and status `staged`. A failing record logs a warning and never fails the optimization (the same optional-mount pattern as the evaluator-health recorder in evolution-scorer).
2. **Lineage is automatic and pure.** `record` wires the previous head of the same skill as the parent, and the generation is one past the skill's highest (`nextGeneration`). `lineageChain` walks `parentCandidateId` oldest first, tolerating dangling parents and cycles; `headOf` picks the highest generation with the newest `at` tie-break, so equal-generation rows resolve deterministically.
3. **Competition is the elite ranking.** `rankElite` orders the approved candidates by pass, then fewer tokens, then faster wall time; unmeasured candidates rank below every measured one. `updateStatus` moves `staged` → `approved` | `rejected` with terminal statuses that never leave.
4. **One durable domain, one command surface.** The `evolution_population` domain (v1) holds one `candidates` table keyed by candidate id. `/population` lists a skill's population, walks one lineage, and approves or rejects staged candidates. The package is mounted in the web-app profile (it writes only its own domain and reaches no model prompt).

## Alternatives considered

- Store the population inside the optimizer's experiment ledger — rejected: the ledger records per-run outcomes; the population is per-candidate lineage across runs, and the optimizer package already owns its staged-write governance to other stores.
- Keep candidates in memory — rejected: lineages and the elite must survive restarts; a per-candidate domain is the durable home.
- Let the optimizer be the required writer — rejected: the optional seam keeps a deployment without the population package behavior-identical, and the failing-store path cannot break an optimization.

## Consequences

- Optimization history is now visible: `/population writer` shows generations, standings, and the elite, and `lineage` shows how a winner descends — so an operator can tell a first-generation rewrite from a tenth-generation compress.
- The approved elite is queryable: future breeding loops can read `elite(skill)` and stage the next generation from it (documented as deferred in the package's Known Limitations).
- The optimizer stays decoupled: recording is optional and failure-isolated.

## Deviations from the plan

None beyond routine. Head selection was extracted into the pure `headOf` helper so equal-generation rows are testable at the unit level; the service's `record` auto-generations make equal generations unreachable through its public API.

## Fixes found on the way

The command initially passed the verb (`approve`/`reject`) to `updateStatus` as the status; the command now maps the verb to the store's status vocabulary (`approved`/`rejected`). A first draft stored a `this.currentSkill` on the optimizer that does not exist; the skill is now passed into the recorder explicitly.

## Testing

Population helpers: generation numbering across skills and stale rows, lineage walking with dangling parents and cycles, head selection by generation then `at`, elite ranking by pass/tokens/wall time with unmeasured-below-measured. Store: auto parent and generation, head tie-breaks, null triple, listing order/filter/detached copies, generation queries, lineage within a skill, elite, legal/illegal/same-status/terminal transitions, unknown ids, restart persistence through the zod spec, reads-before-start. Optimizer hook: staged winner recorded into a mounted store, staging unchanged when unmounted, failing store logs a warning. `/population`: unmounted, grammar usage, population listing, lineage (present and absent), approve/reject with store-error propagation, registration and disposal. 20 population tests, 3 new optimizer tests, and 4 new command tests pass; the new package is at 100% statements/branches/functions/lines, and the optimizer stays at 100%.

## Left alone

Competition is a ranking, not a pipeline: nothing yet breeds the next generation from the elite — that is the population-driven improvement loop ahead (documented in the package's Known Limitations). Candidates are host-wide, not scope-keyed; per-scope keying is deferred. The command-evolution source retains pre-existing uncovered branches in untouched commands (journey-export default path, curator default/error paths) that predate this work.