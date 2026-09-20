# Agent Note: Full operator portfolio, operator effectiveness, and structured reflection

Status: implemented

English | [中文](2026-09-20-evolution-p0-operators-and-reflection.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` left three P0-adjacent gaps after the §58 decision slice. First, §8 names a fourteen-operator portfolio while the optimizer carried four (`rewrite`, `compress`, `guard`, `exemplify`), so most repair shapes the specification lists had no instruction to draw. Second, the same section's `operator_stats` (`attempts`, `accepted`, `mean_delta`, `regression_rate`) existed only as a sketch: the ledger recorded tries and wins per row, but no reader reduced them to per-operator effectiveness. Third, §4.2 requires structured reflection — failure → explanation → corrective heuristic → later retrieval — while the feedback store kept only per-session entries and cross-session graded signals, with nowhere to put an analyst's root cause or corrected strategy and no schema distinguishing measured fact from missing analysis.

## Decision

Three mechanisms, each owned by the package that already owns its seam:

1. **Full operator portfolio** (`dsh-evolution-optimizer/src/mutate.ts`). Eight operators join the built-ins — `generalize`, `decompose`, `compose`, `reorder`, `remove-step`, `change-tool`, `change-retrieval`, `change-evaluator` — each contributing one instruction line, resolved through the existing `resolveOperators` chokepoint so the run path, budget split, and configuration validation change nowhere. Two specification members stay out deliberately: `merge-two-candidates` needs two input bodies while the frame carries one, and `adversarial-patch` belongs to the contamination review rather than repair mutation. The per-operator selection guide lives on `MUTATION_OPERATORS` because the optimizer README triple is another change's work in progress.
2. **Operator effectiveness** (`dsh-evolution-optimizer/src/surface.ts`). `operatorEffectiveness` reduces one scope's ledger rows under one failure signature to per-operator `attempts`, `accepted`, `meanDelta` (mean billed-token saving of the wins over their baselines, `null` when the operator never promoted there — a loss carries no measured triple), and `regressionRate` (share of its candidate-producing runs that ended `regressed`). It is a read model beside `operatorRecords`, not a second ordering: `orderPortfolio` is untouched, so the lineup every other reader depends on keeps its behavior.
3. **Structured reflection** (`dsh-evolution-feedback`). `reflect` returns the graded failures as `StructuredReflection`s: ledger-derived `failureId`, `symptom`, `violatedExpectation`, contributing reporting sessions, observed `whatFailed` counts, and `confidence` (0.25 when the failing call was never observed, otherwise 0.5 rising linearly to 1 at `triggerReviewSessions` distinct sessions), merged with the analyst-supplied `rootCause`, `correctedStrategy`, `reusableWhen`, `antiPattern`, and `candidateTest` — which stay null until stated, so missing analysis is never mistaken for measured fact. `recordReflection` upserts that analysis keyed by merge key with per-field merge (an empty call keeps everything), and a new `reflections` table carries it durably: domain version 2 with `compatibleVersions: [1]`, following the memory precedent, so vouched-for v1 documents open unchanged.

The regression/eval wiring this slice was asked to check already exists and was verified, not built: paired winner-vs-baseline confirmation and private holdout pools are committed in the optimizer run path (`PromotionConfidence`, `HoldoutCheck`, `holdoutScenarios`), and the scorer README documents the behavior gates. No change was needed.

## Alternatives considered

- **Framing two bodies for `merge-two-candidates`** — rejected: `frameMutationInput` carries one current body, and a two-body frame would need a second skill source the request does not have; the operator stays out until a caller can supply the pair.
- **Folding the effectiveness summary into `OperatorRecord`** — rejected: the record feeds `orderPortfolio`, whose spec file is another change's work in progress; a separate function adds the statistics with zero interference.
- **Auto-recording reflection skeletons at the trigger-review grade** — rejected: the store sees one session at a time and holds no session roster, so it cannot compute the cross-session grade locally; skeletons would be either wrong or written by a reader that already has the roster.
- **A separate reflections domain** — rejected: a reflection shares its failure identity with the feedback records, and splitting them would need cross-table atomicity the domain does not offer; the table rides the existing domain beside `records`.
- **Wiring curator or dreaming onto `reflect` now** — deferred, not rejected: both read `signals`/`summary` today, and switching their prompt material is a model-visible change needing snapshot coverage of its own; recorded as a limitation in the feedback README.

## Consequences

- A run can draw twelve repair angles through the same configuration, budget, and ledger path; the guide on `MUTATION_OPERATORS` tells the deployment which angle matches its evidence.
- Per-operator effectiveness is derivable from committed ledger rows without new durable state: attempts, acceptances, mean token saving, and regression share per failure signature.
- Every graded failure now has a structured form with an explicit null-vs-measured contract, and an analyst's reading has a durable home keyed by the same merge key the signals report — while the missing author (dreaming REM, reviewer extraction) is named in the README rather than silently absent.
- The `evolution_feedback` domain opens v1 documents unchanged; the reflections table arrives empty on first write.

## Deviations from the plan

- Eight operators, not the ten remaining specification members: `merge-two-candidates` and `adversarial-patch` are excluded for the reasons above, recorded in the guide comment so a future framer knows what would unblock them.
- Analytic reflection fields are nullable with no model author yet; the plan's schema assumed an author the loop does not have, so the store ships the derivation plus the durable write path and names the intended authors.
- No regression-suite code: the confidence pairs and holdout pools the gap analysis expected to be missing are committed and covered, so this slice verified rather than built.

## Testing

- `mutate.spec.ts` (11 tests): every one of the twelve portfolio ids resolves with a distinct instruction, plus the existing framing/parsing/call paths.
- `effectiveness.spec.ts` (3 tests): attempt/acceptance counting under one signature, delta averaging with shared regressed blame, and a win without a measured triple plus a winner outside the lineup.
- `reflection.spec.ts` (3 tests): derived halves with confidence 1 / 0.75 / 0.25 across attributed, single-session, and unattributed failures; ghost and repeated session ids; analysis merge over three partial writes plus a single-field first reading; stored analysis surfacing through `reflect`.
- 100% statements/branches/functions on the four touched `src/` files (`feedback/src/index.ts`, `feedback/src/spec.ts`, `optimizer/src/mutate.ts`, `optimizer/src/surface.ts`), confirmed from the JSON coverage report for the affected-package run (131 tests, 12 files, all passing).
- `typecheck` passes repo-wide. `lint`, `verify-export-jsdoc`, `verify-persistence-catalog`, and doc budgets stay red on pre-existing entries only (verified none from this change); `verify-translation-pairing` and `verify-package-readme-limitations` pass for the touched pairs.

## Left alone

- Curator and dreaming still read `signals`/`summary`; switching them to `reflect` needs model-visible snapshot coverage and is recorded in the feedback README.
- The optimizer README triple is another change's work in progress; operator guidance lives in `mutate.ts` JSDoc until that change lands.
- P1–P3 mechanism families (islands, curriculum, compositionality, adversarial, meta) remain future decisions; this slice is P0 failure memory plus the §8 portfolio remainder.
- `packages/skill/skill/tests/skill.spec.ts` scoped-layer cases fail when that file runs standalone; verified identical on the pristine tree (unrelated to this change).
