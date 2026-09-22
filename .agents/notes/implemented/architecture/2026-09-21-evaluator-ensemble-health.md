# Agent Note: Evaluator ensemble health

Status: implemented

English | [中文](2026-09-21-evaluator-ensemble-health.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "evaluator ensemble" as P1 #16, and §13/§46 require the evaluator itself to be versioned and benchmarked — agreement, false-positive rate, and drift — because a single judge becomes the new bottleneck and can be wrong, biased, or reward-hacked. The scorer already reduces its three gates to a disagreement verdict (`evaluatorDisagreement`), but that signal was computed and dropped: no durable record, no health aggregation.

## Decision

One new package, `dsh-evolution-evaluator-health`, plus a recording hook in the scorer:

1. **Every judgment is recorded.** The scorer's `evaluateBehavior` writes each gated and evaluated verdict into the optional store (`status`, `approved`, unanimity, approving/dissenting channels); skipped evaluations record nothing, and a failing store logs a warning instead of failing the evaluation.
2. **Health is pure and aggregated.** `summarizeHealth(runs, window)` computes overall and recent approval rates with drift (recent minus overall over the newest `window` verdicts), unanimous agreement, false positives (an approved verdict for which a NEWER same-skill verdict rejected, as a share of approvals), and per-channel approval rows.
3. **One durable domain, one command surface.** The `evolution_evaluator_health` domain (v1) holds one `runs` table keyed by verdict id. `/evaluators` prints the summary or the newest verdicts, optionally per skill. The package is mounted in the web-app profile; the scorer records only when the store is mounted, so deployments without it see zero behavior change.

## Alternatives considered

- Accumulate health inside the scorer — rejected: the scorer is the evaluation engine, not a durable ledger; a separate store keeps health queryable without touching replay logic.
- Compute health on the fly from the optimizer's experiment ledger — rejected: that ledger records optimization runs, not gate-level verdicts with per-channel disagreement; the health signal needs the channels.
- Treat "later rejected" regardless of order — rejected: verdicts are newest-first and a false positive requires a NEWER same-skill rejection, so an earlier rejection never incriminates a later approval.

## Consequences

- The evaluator is now observable: agreement, approval drift, and false positives are durable facts any operator can read via `/evaluators`.
- Every scorer evaluation feeds the store at the commit point of its verdict, so health never lags the judgments that produced it.
- A deployment without the health package keeps the scorer's exact behavior; the recorder is an optional seam, not a new dependency in the evaluation path.

## Deviations from the plan

None beyond routine. The pre-existing `disagreement.ts` fallback branches (unknown channels sorting after the canonical set) were uncovered at HEAD; two disagreement spec cases close them alongside this change.

## Fixes found on the way

None beyond the disagreement coverage above.

## Testing

Stats: zero-summary for no verdicts, rate/drift aggregation over a window, false-positive counting with order sensitivity (a same-skill rejection must be NEWER), no-approved zero rate, per-channel approval over participating verdicts with zero-participation rows. Store: verdict recording, newest-first listing with skill filter and detached copies, skipped-verdict rejection, summary over recorded verdicts, reads-before-start. Scorer hook: gated and evaluated verdicts recorded with the correct channels and approval, and a failing health store survives with a warning. `/evaluators`: unmounted, usage, summary rendering, verdict listing with skill filter and no-verdicts message, registration and disposal. 9 health tests, 147 command tests, and the scorer suite (with 100% statements/branches/functions/lines restored, including the close of the latent disagreement branches) pass.

## Left alone

False positives are an internal proxy compared against verdicts, not against human outcomes; correlating health with real-user results is the deferred calibration work (package Known Limitations). Verdicts are host-wide, not scope-keyed.