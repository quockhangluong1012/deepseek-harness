# Agent Note: Evaluator disagreement substrate

Status: implemented

English | [中文](2026-09-21-evaluator-disagreement.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` P1 item 16 calls for an evaluator ensemble, and §58 step 4 puts evidence inside decisions. The scorer's behavior gates measure different things — a committable body, correct routing, no replay regression — but `evaluateBehavior` produced only a single approval bit. A split verdict (routing passes, replay regresses) was indistinguishable from unanimous rejection downstream: no signal named which evaluators disagreed, so neither the curator nor a future ensemble could treat a split as uncertainty rather than failure.

## Decision

A pure channel-verdict reduction owned by the scorer. `evaluatorDisagreement(channels)` (`packages/evolution/evolution-scorer/src/disagreement.ts`) reduces one verdict per channel to approving and dissenting lists in canonical cheapest-first order (`contract`, `routing`, `replay`), with `unanimous` true when the channels speak with one voice. `BehaviorEvaluation` carries `disagreement` on both the `evaluated` path (three channels) and the `gated` path (two channels — replay never ran, so it says nothing). Unanimity covers agreement to reject as well as agreement to approve; only a split is the uncertainty signal. Zero channels throws, because that is a caller bug rather than a verdict. The types (`DisagreementChannel`, `ChannelVerdict`, `EvaluatorDisagreement`) live in `src/types.ts`, where `types.ts` holds no runtime code by package rule.

## Alternatives considered

- **A single boolean dissent flag** — rejected: it records that channels split without naming which one dissented, which is the part a curator or ensemble needs to act on.
- **Full ensemble judges now** — rejected: independent judges need a benchmark corpus to judge against (P1 item 17), which does not exist yet; the reduction is the substrate the judges will feed, not the judges.
- **Threshold-gating the routing channel into unanimity** — rejected: the routing verdict is already a hard gate, and softening it to manufacture agreement would be invented precision.

## Consequences

- Consolidation and future judges can read a split verdict as "worth investigating" instead of conflating it with rejection.
- The reduction is pure, so specs drive it without spawning processes; the scorer stays stateless and publishes no invariant companion.
- The `gated` path's two-channel reduction is honest about replay's absence: a lone passing gate beside a failing one reads as a split, never as approval.

## Deviations from the plan

- None: the slice is the P1-16 substrate only — reduction plus wiring, no judges.

## Testing

- `tests/disagreement.spec.ts`: canonical ordering regardless of input order, unanimity in both directions, empty input throwing, and the two-channel gated shape.
- `tests/behavior.spec.ts` asserts the carried disagreement on evaluated and gated paths.
- Scorer suite green (47 tests); 100% statements/branches/functions on `src/disagreement.ts` from the JSON coverage report.
- Scorer README documents the field in both languages.

## Left alone

- Ensemble judges (P1-16 remainder) still need the benchmark corpus (P1-17) first.
- P1-19 shadow/canary, P1-20 adaptive routing, and the P2/P3 families remain future slices.
