# Agent Note: Benchmark growth, risk routing, and the holdout rule

Status: implemented

English | [中文](2026-09-22-evolution-benchmark-growth.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` describes several mechanism families whose recording halves exist and whose acting halves do not, and one contract family that has no code at all.

- §49 routes decisions by risk — "low-risk + strong evidence → auto promote, medium-risk → canary, high-risk → human approval, uncertain → human review" — and §54's Phase 0 lists "risk model" among the contracts the architecture is supposed to start from. No package in the repository had a risk model: neither `evolution-canary`, which owns the rollout ladder, nor the actuator's rollout monitor, which decided every live rollout from the measured triple alone.
- §14 asks for a "Regression Promoter" and states that "new failures should automatically become hard examples unless they are duplicates or contaminated". The benchmark store admitted tasks only from `/benchmark admit` and from the actuator's `admission` loop, which reads open curriculum proposals. Curriculum proposals themselves come from `evolutionCurriculum.propose`, whose only automatic caller is the actuator's `recovery` loop, gated on `evolutionStagnation.status().stagnant`. In the shipped profile the only writer of a stagnation run is the optimizer, and `packages/bundle/web-app/cordis.patch.yml` ships that row `disabled: true`. So in the shipped profile no proposal was ever staged and no benchmark task was ever admitted automatically: the store's contents were fixed by hand.
- §15 requires TRAIN/SEARCH, VALIDATION, and PRIVATE HOLDOUT partitions and states that "candidate promotion should never depend only on the dataset used to generate the candidate". The benchmark store has had the four ladder states since it was written, but every advance was a human `/benchmark promote`. No rule connected recorded evidence to a rung, and nothing anywhere read holdout coverage when deciding a promotion.

## Decision

1. **§49's risk model lives in `evolution-canary`, as a pure module** (`src/risk.ts`, `assessRisk`). It reads four facts about a change — artifact kind (`skill` or scope-wide `memory`), evidence strength (`strong`/`partial`/`none`), reversibility, and holdout coverage — and returns a `RiskClass` with the `RiskRoute` that class licenses. It counts three aggravations (a scope-wide artifact, partial evidence, an uncovered holdout) and treats none-measured as its own `uncertain` class rather than as high risk: a missing measurement is the absence of a signal, and §49 routes that to review rather than approval. One aggravation is `medium`, two or more or an irreversible change is `high`, none at all is `low`.
2. **It sits beside the rollout ladder, not in the actuator**, because the ladder is what makes a change reversible: a `canary` deployment can still exit to `rolled-back`. Risk class and rollout stage are two readings of the same staged-write lifecycle, and the actuator stays a performer of rules other packages own.
3. **The rollout monitor consults it** (`rolloutRisk`, `routeAllows`). `rolloutRisk` derives the input from recorded state rather than restating it — measured triple or nothing, always reversible because the monitor only decides a live rollout, holdout coverage read from the benchmark store's `holdout` tasks for that capability. `routeAllows` then permits a promotion only on the `auto-promote` route, and permits a rollback on any route, because rolling back restores the incumbent rather than installing the patch.
4. **A `growth` loop mines evidence that is live in the shipped profile** — session failures the feedback store graded `trigger_review`, and the curator's open regression debt — into benchmark tasks through the existing `admit` path, and advances the ladder on exposure the population store recorded. It reads no disabled store and no stagnation flag.
5. **Every derived task text carries no observation count**, so a failure the store keeps grading decisive re-hashes to the task already admitted for it. Content addressing, not the store's memory, is what makes the loop idempotent; the same property makes two different failures of one capability two tasks.
6. **Benchmark growth owns the `growth` loop in the actuator, and reads `evolutionStagnation` nowhere.** Gating benchmark growth on stagnation is what made the shipped profile inert; the new loop's sources are all written by enabled packages.
7. **The ladder rule is `ladderAdvance(state, exposure)` in `evolution-benchmark`**, layered on top of the existing `nextLadder` rather than replacing it. Each rung asks for its own evidence: `runs > 0` joins the search set, `passes > 0` establishes a baseline and moves to validation, and `HOLDOUT_AFTER_RUNS` (3) reserves the task as protected holdout once the corpus has moved past it.
8. **The rule reads exposure as data, not from the population store.** `ExposureEvidence` is `{ runs, passes }`, so `evolution-benchmark` keeps no dependency on the engine's population layer and the rule is unit-testable without a context.

## Alternatives considered

- **A new `evolution-risk` package.** Rejected: the model is one pure function over four fields, and the store that owns the lifecycle those fields describe already exists. A package would have added a profile row, a README triple, and a catalog entry for a function the rollout loop is the only consumer of.
- **Putting `assessRisk` in `evolution-actuator`.** Rejected: the actuator performs rules other packages own — that is its stated contract — and reversibility is a fact about the canary ladder, so the model would have been the one rule in the package with no owning store.
- **Grading evidence by whether a baseline exists.** Considered and rejected: `rolloutDecision` already compares the candidate's triple against the incumbent's, so making a missing baseline an aggravation would have counted the same fact twice and left a first rollout for any skill permanently unable to auto-promote.
- **Treating no measurement as high risk.** Rejected: §49 names `uncertain` as a class whose route is review. Collapsing it into `high` would have sent an unmeasured patch to approval, which is a heavier gate than review and the wrong one — approval says "this is dangerous", review says "we cannot tell".
- **Making the monitor roll back on the `canary` route too.** Rejected: a rollback restores the incumbent, so it is the safe direction; gating it would have left a failed patch live on a host without a holdout, which is strictly worse than ending it.
- **Reading `evolutionFeedback.signals()` with a session list the loop invents.** Rejected: the store's reads are session-keyed and nothing enumerates its sessions. The loop reads the session ids from `evolutionSkillTelemetry.entries()`'s `usage.sessionIds`, the same seam `evolutionCurriculum.gaps()` measures from, so the two aggregated-failure readers agree on what "the sessions" means.
- **Deriving the task text from the count, the session count, or the timestamp.** Rejected: those change as a failure recurs, so the content address would move and the store would admit a second copy of the same failure on the next pass.
- **Binding the ladder rule to task-level exposure.** Rejected as unimplementable: nothing in the harness records which benchmark task a candidate evaluation used, so a task-scoped rule would have had to invent that record. The rule reads capability exposure and the README states the ceiling that follows.
- **Skipping the empty-signals guard in the drain loop.** Chosen: the uncertainty queue derives every task from the same signals the list reads, so a queued task always has at least one, and `benchmarkInput`'s loud refusal is a better guard than a branch nothing can reach.
- **Folding the ladder rule into `nextLadder`.** Rejected: `/benchmark promote` and `transition` enforce the ladder's shape, and a human promoting by hand must not be gated on the engine's own exposure. `ladderAdvance` answers a different question — what the recorded evidence earns — and returns `undefined` rather than a rung it cannot justify.

## Consequences

- `assessRisk` publishes §49's table as one function; the actuator's rollout monitor now follows the route it returns, which means a measured, passing, cheaper patch whose capability no `holdout` task covers stays live for an operator instead of promoting. That is §15's rule reaching production behaviour for the first time, and it is visible in `/canary`.
- A sixth heartbeat task appears, `evolution-benchmark-growth`, and `Config.loops` accepts `growth`.
- `ladderAdvance`, `HOLDOUT_AFTER_RUNS`, and `ExposureEvidence` join `evolution-benchmark`'s public surface; `failureInputs`, `debtInputs`, `exposureOf`, `rolloutRisk`, and `routeAllows` join the actuator's.
- The actuator gains peer dependencies on `evolution-curator`, `evolution-feedback`, and `evolution-skill-telemetry`.
- A task now reaches `holdout` without a human: the growth loop advances it as the capability's recorded exposure clears each rung.
- All three package README triples state the new surface, and the configuration catalog gate that reads the actuator's `Config` gains `growthIntervalHours`.
- The catalog gates carry no new package row: this change adds one module to each of three existing packages and one loop to an existing plugin.

## Deviations from the plan

§15's partition could not be derived from task-level evidence, because no store binds a candidate evaluation to a benchmark task identity — `evolutionPopulation` records candidates per skill, `evolutionOptimizer`'s ledger records runs per skill, and `evolutionLineage`'s experiment envelopes carry `tasks: string[]` that nothing populates (the optimizer records them empty). The honest rule therefore reads the exposure recorded for a task's *capability* and applies it to that capability's learnable tasks. The consequence, stated in both READMEs, is that a task admitted into a well-evaluated capability reaches `holdout` without the search ever having used it, and two tasks of one capability advance together. Deriving task-level exposure needs a record the harness does not have: the shape would be a task identity on the population candidate or on the lineage envelope, written by whatever runs the task — and nothing runs a benchmark task yet, so the record would have no writer even if the field existed.

§15's second half — "production-replay, adversarial, never-seen holdout" for long-lived agents — is not derivable either: `evolution-trace` projects committed sessions into learning traces but records no replay corpus, and the benchmark store's states have no second axis for dataset provenance. Both remain open.

## Testing

`packages/evolution/evolution-canary/tests/risk.spec.ts` walks §49's table as ten named rows — each combination of artifact, evidence, reversibility, and holdout that the rule distinguishes — and asserts the class and the route for each. `packages/evolution/evolution-benchmark/tests/dedupe.spec.ts` adds the ladder rule: every rung below its evidence, every rung at it, and the three states that never advance.

`packages/evolution/evolution-actuator/tests/actuator.spec.ts` covers the pure mappings without a context (decisive-signal selection with the text-stability check, debt mapping, exposure counting that ignores unmeasured candidates, the risk input for a measured and an unmeasured deployment, and route licensing) and then boots the real stores over an in-memory backend. The benchmark, canary, population, stagnation, curriculum, and uncertainty stores are the real ones; the feedback, curator, and telemetry seams are stubs returning fixed recorded values, so these tests prove the loop and the deduplication it relies on rather than the grading those three packages do in their own suites.

- a decisive failure is admitted once and stays one task when the store keeps grading it decisive, a signal that only ranks produces nothing, and a second distinct failure is admitted beside it;
- the curator's open debt is admitted as a regression case;
- a task walks `fresh → search → validation → holdout` exactly as the exposure clears each rung, and stays put when the evidence does not;
- a rollout promotes only when a `holdout` task covers its capability, and rolls back on a regression or a cost overrun either way, with a second test covering the host that mounts the canary store alone;
- every store-missing and no-work guard in each of the six loops, using a boot helper that can mount any subset of the stores.

## Left alone

The loops still act only on recorded state and gate nothing: an admitted benchmark task does not run, and a `human-approval` route names the operator step the existing staged-write approval already provides rather than adding a queue. §58.12's recorded-not-enforced boundary therefore holds after this change. The three `unactionable` §32 rungs stay unactionable. The two §15 gaps above are documented as ceilings rather than approximated: a task-level exposure rule would have needed a record with no writer, and inventing one would have made the benchmark store's promotion evidence unaccountable.
