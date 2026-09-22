# Agent Note: Evolution budget policy and mutation instructions

Status: implemented

English | [中文](2026-09-22-evolution-budget-and-mutation-instructions.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` describes an evolution engine that prices its own search and revises its own mutation strategy, and the repository had built only the shallow half of both.

- §37's budget controller lists five dimensions — `max_rollouts`, `max_tokens`, `max_cost`, `time_limit`, `parallelism` — and `evolution-budget` priced two of them. A batch could not carry a cost ceiling, a deadline, or a concurrency ceiling, and a settlement could not say anything about them.
- §37's allocation policy — high-potential candidates get more budget, low-potential candidates stop early, novel candidates get exploration budget — lived as four fixed multipliers keyed by a class the caller named. Nothing read a candidate's recorded evidence, so the class was an assertion rather than a decision.
- §38's successive halving was `halvingRounds` pure arithmetic with no caller. No store held the candidate pool a screening pass starts from, so the schedule could not be derived from anything.
- §27 names seven resource-aware objectives. None had a reading anywhere, and two of them — memory footprint and context usage — have no recorded source at all.
- §9's mutation-strategy evolution needs the instruction a mutation sends to be a recorded, revisable thing. `evolution-operators` ranked operators from outcomes, and the instructions themselves were hard-coded strings inside the disabled optimizer's operator catalog.

## Decision

1. **§37's dimensions joined the records the frozen functions already build.** `maxCost`, `timeLimitMs`, and `parallelism` are optional fields on an allocation, and `cost`, `parallelism`, and `backgroundTokens` are optional fields on a spend, priced by a new pure `dimensionCeilings`. `buildAllocation`, `withinAllocation`, `settle`, and `multiplierFor` keep the signatures the evolution actuator calls, and a caller written against the frozen four builds the allocation it always did.
2. **A margin is measured only when both sides are recorded.** Cost, deadline, and parallelism report null throughout when the allocation prices no ceiling or a spend omits the measurement, because a partial total would read as a whole-batch figure and a peak over part of a batch could sit below a ceiling the batch crossed. `withinAllocation` now reads the settlement, so a priced and recorded dimension it never used to see can fail.
3. **The allocation policy is one pure rule over a recorded pool.** `policyFor` reads a candidate's recorded runs, passes, and novelty against configured bars and returns the class, the §37 branch, and the numbers; the batch records the pool it screened and `allocateForCandidate` prices one pool candidate through that rule, so a policy-priced class always traces to recorded evidence and the recorded reason names the branch that produced it.
4. **`halvingRounds` got its caller and its pool.** `screeningSchedule` derives the rounds from the batch's recorded pool, naming what each round evaluates and keeps and what the last one leaves. Which candidate a round actually keeps stays the disabled optimizer's decision; this store derives the shape of the screen, not its verdicts.
5. **§27's objectives are read, never estimated.** `objectiveReadings` derives quality and reliability from the recorded pool, latency, cost, and background compute from the recorded spends, and reports memory footprint and context usage as null with the missing record named.
6. **Mutation instructions became records, and a bounded nudge.** `evolution-operators` holds one proposed instruction per operator and artifact class with the proposal's reason, the verdict tallies, and the last verdict's reason. The ranking adds `instructionWeight × (accepted − rejected) / verdicts` on top of the outcome score, so a proposal that held lifts its operator and one that failed sinks it, bounded by the configured weight.
7. **The README pair states the §26 map.** Both packages name the level whose recorded half they cover — 3 for the operators, 5 for the budget — and state what stays unreachable while the web profile mounts the optimizer with `disabled: true`.

## Alternatives considered

- **Required fields with zod defaults for the new dimensions.** Rejected: a default materializes a ceiling and a measurement nothing recorded, and `withinAllocation` would then judge a legacy record against numbers it never carried. Absent is not zero, and the row schema says so with `.optional()`.
- **Deriving survivors from recorded scores.** Rejected: the screen between rounds is the disabled optimizer's, so a survivor verdict belongs to the consumer that runs the screen. This store derives how many candidates each round evaluates and keeps, and stops there.
- **A stored `branch` field beside `candidateClass`.** Rejected as two names for one fact: the four classes are the four branches. The branch sentence rides in the recorded reason, which is what a reader renders.
- **A new domain for the candidate pool.** Rejected: the pool is the same batch's budget evidence and belongs in `evolution_budget` as a third table, where the schedule reads it without a cross-store join.
- **A metric layer inside the budget store.** Rejected: `evolution-metrics` owns the metric surface, and a second cost reading would have to be kept in step with its compute-overhead ratio. The budget store exposes the readings; the metric layer stays the only report.
- **A new pure module for the pool schedule.** Rejected: `halvingRounds` already owns the arithmetic, and a second screening module would have been a wrapper around it.
- **Rewriting the optimizer's instruction catalog from a verdict.** Rejected: the store records and recommends, the optimizer keeps the strings it ships, and applying a proposal is a deployment decision — the same record-not-enforced boundary the rest of the evolution group holds.
- **Replacing the outcome score with the instruction score.** Rejected: instruction verdicts are an inter-verdict proxy, so they nudge a bounded amount on top of the outcome evidence rather than overturning a proven leader.

## Consequences

- `evolution-budget` gains `recordPool`, `allocateForCandidate`, `pool`, `schedule`, and `objectives` beside its existing surface, three new pure exports (`dimensionCeilings`, `screeningSchedule`, `policyFor`) plus two reading helpers (`recordedTotal`, `objectiveReadings`), six configuration fields for the new ceilings and policy bars, and a third domain table.
- `evolution-operators` gains `recordInstruction`, `judgeInstruction`, `instruction`, `instructions`, and `recommendedInstruction`, an `instructions` domain table, and an `instructionWeight` configuration field. `rankOperators` takes an optional fourth argument, so every existing caller keeps working.
- Two domains gained one table each at version 1, because no committed row's shape changed: a record written before this work opens with the new fields absent and its unmeasured dimensions reported as null.
- The `evolution-actuator` loop Main wires for §32's new-operators rung reads `recommendedInstruction(artifactClass)` and reports the row it gets back.
- Both packages carry a per-file 100% coverage gate over their `src` trees, and their README pairs state the meta-evolution level each covers.
- **A priced deadline closes a gate as calendar time passes**, because the deadline measures the span from the allocation to the last recorded spend rather than work performed. A batch left open past its 24-hour default reads as spent, and the actuator's budget loop — which gates on `withinBudget` and delegates the rule to this package — then leaves that class alone until a newer allocation prices it. That is §37's time limit doing what a budget does rather than an accident; a deployment whose pass cadence is slower raises `baseTimeLimitMs`, and the README says so.

## Deviations from the plan

The ticket asked for the new dimensions as "optional fields with zod defaults"; they are optional without defaults, for the reason in the alternatives above. The ticket also asked for §27's objectives "beside the existing quality/reliability triple" — the engine's measured triple (`pass`, `tokens`, `wallTimeMs`) — which is what the reading uses, with quality and reliability derived from the recorded pool because spends carry no pass. The objectives stayed in `evolution-budget` rather than moving into the metric layer, on the parent's instruction, so this batch touches no package another task owns.

## Fixes found on the way

Four expectations in the two packages' committed tests contradicted the code they ran against, and each was replaced with the real contract rather than re-pinned to new wording:

- `evolution-budget`'s cumulative-settlement test expected an exceeded wall time its own spend records could not produce against the ceiling the same test asserted one line earlier; the second spend now crosses both ceilings, which is what the test's name describes.
- `evolution-budget`'s within-budget test expected a 30000-token spend to breach a 40000-token ceiling; it now checks the inside-to-outside transition a cumulative spend actually has.
- `evolution-operators`' two listing tests expected `['add-step', 'change-tool', 'rewrite']` from a sort that orders by `MUTATION_OPERATORS`, where `rewrite` is first; both now expect the canonical order and one of them also exercises the artifact-class tie-break.

## Testing

`node node_modules/vitest/vitest.mjs run packages/evolution/evolution-budget packages/evolution/evolution-operators` passes 7 files and 92 tests, and each package's `src` tree reports 100% statements, branches, functions, and lines under v8 coverage.

The behavioural evidence: an allocation carries the priced cost, deadline, and parallelism ceilings and a spend settles against each with its margin, including the exceeded side and the unmeasured side; `withinBudget` fails on a priced dimension the batch crossed and ignores one nothing recorded; the policy returns the more-budget, early-stop, exploration-budget, and standard branches for candidates whose recorded evidence reaches each bar, and the batch records that branch in the allocation's reason; the screening schedule names what each round evaluates and keeps from a recorded pool of ten and how many finalists it leaves; the objectives read quality, reliability, latency, cost, and background compute from the pool and spends and report memory footprint and context usage as null with the missing record named; a proposed instruction is recorded with its verdict and the operator's ranking moves by the bounded adjustment, with the rejected proposal sinking below the untried priors and the accepted one leading.

Both README pairs pass `scripts/verify-translation-pairing.ts`.

## Left alone

Nothing here blocks a run: a batch that overspends is reported, and the caller that reads `withinBudget` is the one acting on it (§58.12), while the early-stop branch prices a smaller batch rather than stopping a run. The deadline is the one dimension whose gate can close as calendar time passes, and the README's limitations state that rather than leaving it implicit. The screen between halving rounds stays the optimizer's, so no survivor verdict is recorded. No store rewrites an optimizer's instruction, and the actuator's use of a recommended instruction is the parent's wiring rather than this work's. The multipliers and the policy bars are configured rather than learned, which is what §26's level 5 needs settled outcomes to change.
