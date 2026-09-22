# Agent Note: Judge independence, calibration, and observed gaming defenses

Status: implemented

English | [中文](2026-09-22-judge-independence-and-defenses.zh.md)

## Problem

Four mechanism families in `specs/evolutionary-harness-v11-deep-research.md` had recording halves and no reading worth acting on:

- **§44 (model disagreement as a search signal)** had no producer at all. Nothing compared two routes or two independent reasoning paths. The only "disagreement" in the repository was `evolution-scorer`'s three behavior gates reduced to one `unanimous` flag — three gates inside one scorer, that scorer shipping `disabled: true`, and the flag compared channels of one evaluation rather than two routes or models.
- **§28 (judge independence)** recorded which route served each role and which route judged a candidate, but never compared them. `evolution-evaluator-strategy` accepted an `independent: true` flag from its caller and could not check the one thing the package itself could check: whether the judge was the model that produced the candidate. §28's topology also ends at "final promotion review → strongest verifier", and nothing named that route in any recommendation.
- **§13 (judge calibration)** listed false-positive rate, false-negative rate, and correlation with human outcomes. The store had the first and called the other two deferred: `falsePositiveRate` was an internal verdict-to-verdict proxy, with no negative half and no recorded ground truth.
- **§46 (evaluator-gaming defenses)** listed six automatable defenses and recorded a hand-set boolean per defense, in `evolution-adversary`. Nothing derived a defense from what the engine had actually done, so the checklist answered an operator's assertion and never the evidence.

## Decision

1. **A route disagreement is derived from the outcomes the router already holds, and no model is called.** `routeDisagreement` (`evolution-router/src/disagreement.ts`) compares the highest and lowest pass rates among the routes of one task class and role measured at least `disagreementMinimumRuns` times, and reports them once the gap reaches `disagreementThreshold`. `observe` runs that check on the task class and role it just measured and writes a `disagreement` uncertainty signal through the existing `ctx.evolutionUncertainty` seam. The signal identity is derived from the task class, role, and the two routes, so a drain that empties the queue and a later pass that re-records the same disagreement converge instead of growing without bound.
2. **What that mechanism cannot detect is written down, not implied.** It compares recorded outcomes across routes, so it finds cross-route outcome divergence: two routes passing the same *share* of a task class raise nothing even when they pass different tasks within it, and a task class only one route has run has nothing to compare. A genuine per-sample two-model comparison needs a second model call, which §44 does not require and this change does not make.
3. **§28's independence rule lives where both model identities are known.** `judgeIndependence(judgeModel, candidateModel)` in `evolution-evaluator-strategy` calls a judge that produced the candidate `same-model`; `updatedStrategy` counts such a pair toward `samples` and a new `selfJudgedSamples`, never toward `independentSamples` or `corroborations`. An empty `candidateModel` cannot be shown to be the judge's, so it reads independent — recorded as a limitation, because silently treating "unknown" as "self-judged" would invert the meaning of a caller's record.
4. **The strongest configured verifier is named, and naming it routes nothing.** `ranking` and `recommend` in `evolution-evaluator-strategy` attach `ctx.evolutionModelRoutes.recommend('promotion-review')` to every entry as `promotionReview`, or `null` while nothing is assigned. No run starts from a recommendation, so §58.12's record-not-enforced boundary is intact.
5. **Calibration gets both error directions and a real ground-truth field.** `judgeCalibration` in `evolution-evaluator-health` mirrors the false-positive reading into a false-negative rate (a rejection later contradicted by a newer same-skill approval) and counts the verdicts a later *independent* ground truth judged, with their agreement rate. `judge(runId, judgment)` attaches that judgment to a recorded verdict and rejects an unknown id loudly.
6. **The §46 checklist gains an observer beside the assertion.** `observeDefenses` in `evolution-adversary` (`src/defenses.ts`) derives each of the six defenses from the stores that actually recorded it — evaluator-strategy for `multiple-evaluators`, benchmark holdout partitions for `hidden-holdout`, the adversary's own probes for `behavioral-metrics` and `adversarial-tests`, router effectiveness for `evaluator-rotation` — and reports each as `observed-satisfied`, `observed-open`, or `unobserved`. `randomized-tests` is always `unobserved` with the reason named, because nothing records which tests were randomized; human spot checks are not a row at all. An unmounted store makes its defense `unobserved` with the missing store named, never open. `defenses()` keeps reporting the operator's rows unchanged.
7. **Every new threshold is a validated `Config` field.** `disagreementMinimumRuns` (3) and `disagreementThreshold` (0.5) join `minimumSamples` in `evolution-router`; the adversary observer reuses the existing `minProbesPerCategory`.

## Alternatives considered

- **A second model call inside the router.** Rejected: §44 is usable from recorded evidence, the repo's posture is zero new model calls, and a live comparison would need a task harness the router does not own. The recorded version's exact detection limit is stated in the README and the package doc.
- **Comparing the two routes' outcome rows task-by-task rather than by pass rate.** Rejected: `RouteOutcome` carries no task identity within a task class, so the finer comparison has no data to read. Pass-rate divergence is what the store holds.
- **Treating an empty `candidateModel` as same-model.** Rejected: it would turn a caller's omission into an accusation, and would count a pair as self-judged that the evidence does not show.
- **Making `conflicts()` refuse a route that produces and judges.** Rejected: an operator's pin outranks the topology by design, and a store that silently rejected a documented operator action would be worse than one that makes the collision visible. `conflicts` records with `pinned` saying who chose it.
- **Bumping the two domains without `compatibleVersions`.** Rejected: version 1 rows are readable as-is (an absent `judgment` reads unjudged, an absent `selfJudgedSamples` reads zero), so discarding them would throw away evaluator evidence for a shape change.
- **Reusing `evaluatorRun.unanimous` as the §44 disagreement source.** Rejected: that flag compares the channels of one evaluation, the scorer ships disabled, and it does not involve two routes. §44 asks for two models or two reasoning paths; routes are the recorded pair the harness actually has.

## Consequences

- `evolution-router` writes to `ctx.evolutionUncertainty` when mounted. The signal is recorded even when nothing drains it: the actuator's `drain` loop is the consumer, and until it is mounted the signals accumulate in the queue. The README says so explicitly.
- Two domains move to version 2 with `compatibleVersions: [1]`: `evolution_evaluator_strategy` (adds `selfJudgedSamples`) and `evolution_evaluator_health` (adds the optional `judgment`).
- Three evolution→evolution dependency edges appear, following the `evolution-metrics`/`evolution-scorer` peer+dev pattern: router → uncertainty, evaluator-strategy → model-routes, adversary → {benchmark, evaluator-strategy, router}. The lockfile refresh is the parent's step.
- `observedDefenses` reads sibling stores only: it appends nothing to the benchmark, routes no run, and starts no evaluation. No second admission path exists.

## Testing

- `evolution-router/tests/disagreement.spec.ts` pins the comparison table (highest vs lowest pass rate, below-minimum routes excluded, one measured route yielding nothing, gaps inside the threshold) and the grouping and ordering. `tests/store.spec.ts` drives the real seam: agreement records no signal, divergence records one with its exact id, score, and detail, re-recording keeps one identity, and a rejecting uncertainty store logs a warning while the outcome still lands.
- `evolution-evaluator-strategy/tests/strategy.spec.ts` pins `judgeIndependence` (including both empty-model directions) and the counting rule; `tests/store.spec.ts` records a same-model verdict as non-independent — weight zero, no recommendation, `selfJudgedSamples` one — and reads the promotion-review route from a stubbed model-routes store, plus `null` when unmounted.
- `evolution-evaluator-health/tests/stats.spec.ts` pins the false-negative rate where the false-positive counter does not fire, the same-skill and ordering guards, and the independent-only agreement rate; `tests/health.spec.ts` attaches judgments through the store and rejects an unknown id.
- `evolution-adversary/tests/defenses.spec.ts` pins each observer's satisfied and open branches plus the always-unobserved `randomized-tests`; `tests/store.spec.ts` runs the observer through the real store with three stubbed siblings and verifies all six states, and with none mounted verifies the three `unobserved` readings.

## Left alone

Nothing here gates a skill, changes what a session sees, or reaches a model prompt. The disagreement signal is recorded and waits for the drain loop; the promotion-review route is named and applied by nobody automatically; the defense observation is read-only over the sibling stores. §58.12 holds.
