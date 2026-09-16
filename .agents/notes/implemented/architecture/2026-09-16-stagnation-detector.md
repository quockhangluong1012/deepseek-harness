# Agent Note: Stagnation detector

Status: implemented

English | [中文](2026-09-16-stagnation-detector.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §32 describes silent evolutionary death: generation after generation of runs that promote nothing, each one repeating the search that already failed, with nobody able to see it from the outside. The optimizer had every fact needed to notice — [the experiment ledger](2026-09-16-experiment-ledger-and-confidence.md) records each run's outcome and the operators that produced candidates — and no reader of it. A skill with a fixed `operators` lineup therefore re-ran the same operator on the same failure mode forever and reported `no-improvement` one run at a time, and the human reading `/curator optimize` could not tell a first attempt from a twentieth.

## Decision

**A skill whose recent evaluated runs promoted nothing is reported as stagnant, and the run switches which operators it draws from.**

- `mutationStrategy(request)` reads the skill's newest `stagnationWindow` ledger rows (default 5), keeps the ones that reached evaluation, and calls the skill stagnating when the window is full and no row in it has outcome `staged`. A run that never scored a baseline records no result, so it neither fills the window nor clears it.
- On a stagnating skill the run draws its candidates only from the configured operators that produced no candidate in that window — the lineup that has not yet failed on this failure mode. When every configured operator has already produced a candidate there, diversity inside the portfolio is exhausted and the configured lineup stands. The lineup is not widened beyond `operators`: an operator the deployment did not configure is not a diversity source this mechanism may invent.
- The lineup a run drew from is now a recorded fact (`portfolio` on each row), distinct from `operators`, which stays "the operators that produced candidates". A later run, and a human reader, can tell what the search planned from what it got.
- `OptimizeReport` gains `stagnant`, `/curator optimize` says so in its success line, and `/curator experiments` prints each row's operators — the ledger's readers now show the switch as well as cause it.

## Independence from the repeat guard

A stagnating run's lineup differs from the lineup of the run the ledger would have refused it for, so the experiment key differs and the new lineup runs. The two mechanisms read the same rows and act on different ones: the guard reads the hypothesis, the detector reads the outcomes.

## Alternatives considered

- **Detecting stagnation from the score triples** (no improvement in pass rate or tokens over N runs) instead of from outcomes. Rejected: the ledger's outcome already encodes the comparison the triples were put through, including the holdout refusal and the approval floor, and re-deriving it from raw triples would duplicate that judgment in a second place with its own tolerance to argue about.
- **A stagnation counter in its own durable record.** Rejected: the same ledger rows are the evidence, and a counter would have to be kept in step with retention, which drops rows as new ones land.
- **Reacting by widening the portfolio beyond configuration** (running every built-in operator once). Rejected: `operators` is the deployment's cost decision — each operator is its own model call — and a mechanism that overrides it would spend money the operator did not authorize.
- **Reacting by changing the model route** (the spec's later rungs: new tasks, new evaluators, new model). Deferred, not refused: the route is plugin configuration and the run cannot choose another one without a router seam that does not exist yet. This change performs the first rung the code can perform on its own — more diversity — and reports the state that would justify the rest.
- **Switching on a threshold of consecutive `no-improvement` runs only.** Rejected: `unconfirmed`, `holdout-rejected`, and `regressed` are just as much evidence that the current approach is not working, and counting only one outcome would report the state as healthy while nothing was being promoted.
- **Refusing to run at all while stagnant.** Rejected: the spec's response to stagnation is a strategy change, not a halt, and a halt would need a human to notice a report that nobody is reading.

## Consequences

Evolutionary death is now visible in the report and in the command line, and a stagnating skill searches somewhere else inside its configured portfolio instead of repeating itself. The costs are stated in the package README: the switch is not a cure — it changes which operators are drawn from, not the scenarios, the model, or the operator set — and it is invisible on a single-operator portfolio, where the window's only operator is also the only alternative.

Verification: 79 optimizer tests, including a stagnating run that draws from the operator that produced nothing while the healthy run used the full lineup, an exhausted portfolio keeping the configured lineup, and a run that never evaluated neither remembered by the repeat guard nor counted as stagnation. 100% statements, branches, functions, and lines on `packages/evolution/evolution-optimizer/src`; 111 command tests, including the stagnation suffix on an optimize report and the operator column in the experiment ledger.
