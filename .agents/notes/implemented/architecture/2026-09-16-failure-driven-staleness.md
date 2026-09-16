# Agent Note: Failure-driven skill staleness

Status: implemented

English | [中文](2026-09-16-failure-driven-staleness.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §22 asks an evolutionary system to detect that an old skill is no longer valid — via time decay, recent failure spikes, distribution shift, tool/version changes, low retrieval utility, and conflicting newer evidence — moving skills `active → suspect → stale → archived` instead of trusting them forever. The curator moved skills on one signal only: idle days since the last load. A skill loaded every day but failing every time stayed `active` indefinitely, while the evidence that it was rotten sat one seam away on its own telemetry record (`trustFailures`, `lastTrustFailure`, load `failureCount`). And movement was one-way down with no path back, so any failure-driven rule added without a revival path would have been a ratchet on noisy signals.

## Decision

**Idle still moves skills down; unattended failure evidence now does too; a fresh success answers both.**

- **`decideTransition` takes the evidence the pass already holds.** No new reads: the pass loop has the full `SkillUsageRecord`, and the pure function gains an evidence struct (`trustFailures`, failure-unanswered flag, loads, failure count, last outcome, used-after-failure flag) plus floors (`staleTrustFailureFloor`, `stageMinUses`, `stageFailureRate`).
- **`active → stale` on two new rules.** Attributed trust failures at the floor (new `staleTrustFailureFloor`, default 3 — the same number as memory's `refutationFloor`) with no newer load answering them, or a load failure rate past `stageFailureRate` over at least `stageMinUses` loads ending in a failed load. The rate rule reuses the staging pair (20 loads, 0.3) rather than adding a parallel knob, and mirrors the staging reason format (`failures 3/4 exceed 50%`), so staging stays the evidence and movement follows the same verdict. Reasons name the cause, as before.
- **Both failure rules fire only while unattended.** A later successful load quiets them instead of oscillating against the revival below: the trust rule needs the attributed failure newer than the last load, the rate rule needs the latest load failed. This is what makes the one-way ratchet safe to extend — the rules and the revival are complementary by construction, not by tuning.
- **`stale → active` on an answering success.** The most recent load succeeded, still inside the stale window (`idleMs <= staleMs`), and newer than the last attributed failure. Past `archiveAfterDays` the skill archives instead — the horizon always wins, so no successful load resurrects the long dead. `stale → archived` is unchanged (idle only), and `pinned` still skips every movement.
- **One knob, not three.** `staleTrustFailureFloor` is the only new config; the rate rule borrows the staging thresholds it already agrees with.

## Alternatives considered

- **Failure evidence without the unanswered guard.** Rejected during implementation: `trustFailures` is monotonic (successes never clear it), so a floor-only rule would re-stale a revived skill on the very next pass forever — a flapping ratchet. The guard was found by tracing `markUsed`/`markFailed`/`recordTrustObservation` timestamp semantics, not by review.
- **A separate floor pair for movement versus staging.** Rejected: two knobs measuring the same rate would drift apart in meaning; staging-as-evidence and movement-on-the-same-verdict is one rule with two readers.
- **Revival on any successful load, however old.** Rejected: without the stale-window bound, a stale-by-idle skill would revive on an ancient `ok` (its `lastOutcome` persists), defeating the idle rule the revival was meant to complement. The window bound keeps idle-staleness sticky and failure-staleness forgiving.
- **A `staledAt` stamp to order revival exactly.** Rejected for now: it would change the telemetry record schema for one comparison the relative ordering (`lastUsedAt` versus `lastTrustFailure.at`) already answers, with one documented approximation — an `ok` recorded before a hand-set stale label still revives, since the label's own instant is unknown. Pinning remains the way to hold a skill out of automatic movement.
- **Cross-seam signals (lesson refutations, tool/version changes, retrieval utility).** Deferred, not rejected: lesson refutations live in `evolution-memory`, retrieval utility (§23/24) does not exist yet. Both need seams this batch deliberately did not open; the README names them as the remaining §22 gap.

## Consequences

A skill that keeps failing while being used now goes `stale` instead of staying trusted, and a skill that recovers comes back — the lifecycle reflects evidence, not just the calendar. The costs: after recovery the cumulative `trustFailures` count stands, so one unattended attributed failure re-stales (documented in the README); a skill alternating weekly between recovered and failing will flap `stale ↔ active` once per pass, truthfully but noisily; and revival answers any stale label however reached, so operators should pin rather than hand-mark stale.

Verification: 7 new pass-level tests (trust-floor transition with reason, answered failures staying put, never-loaded failure transition, rate transition ending failed with reason, bad rate ending ok staying put, revival with reason, horizon beating revival), plus the reordered idle fixture proving a fresh `ok` behind a pre-staged stale label revives. 100% statements, branches, functions, and lines on `packages/evolution/evolution-curator/src`.
