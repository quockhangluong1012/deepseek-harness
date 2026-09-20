# Agent Note: Evaluation contamination control

Status: implemented

English | [中文](2026-09-16-evaluation-contamination.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §35 forbids the evolutionary process from silently training on its own evaluation answers: a task used for mutation must not be treated as a clean test forever. The optimizer already kept search and holdout disjoint within one run (loud overlap refusal) and recorded which holdout scenarios each run checked — but nothing joined the two across runs. A host could search `s1` in run 1, reconfigure `holdoutScenarios` to include `s1`, and run 2 would "validate" its winner on the same task that selected its ancestors. The contamination was silent and one config edit away.

## Decision

**One pure helper plus one loud guard, no new state, no knob.**

- **`contaminatedHoldout` is pure** (`evolution-optimizer/src/contamination.ts`): given the skill's recorded runs, it names the holdout scenarios the ledger already records as *search*, in holdout order. Only recorded search lists count — scenarios a run merely checked as holdout never trained anything — and reusing a scenario for search is never flagged, because selection pressure on the same task twice is ordinary practice, not contamination.
- **`execute` throws before any model call**, beside the sibling overlap and repeat-name checks: a holdout name the skill already searched fails loud with the offending names, at the earliest resolvable point. Misconfiguration fails loud is the repo rule, and this is misconfiguration — a holdout that is not clean.
- **Matching is per skill, not per scope.** A scenario that selected skill A's body never shaped skill B's candidates: B's mutation input carries failure counts, never scenario answers. Scope-wide matching would false-positive on the routine split where `s1` searches one skill and holds out another.
- **No new state because the ledger already is the exposure record.** The row's `scenarios` list is benchmark provenance in this repo: every search exposure is a recorded row, and the guard reads it through the existing `experiments()` accessor. A separate benchmark-state store would duplicate the ledger and then need reconciliation with it.

## Alternatives considered

- **The six-state taxonomy (fresh/search/validation/holdout/contaminated/retired).** Rejected: the states conflate a per-run role (search, holdout, validation) with cross-run history (fresh, contaminated, retired), and the ledger already records both halves — role per row, history across rows. A state column would restate what the two lists already say, plus a transition machine nobody operates.
- **Recording corpus provenance per row.** Rejected: one host scores against one `corpusDir`, and ledgers never cross hosts, so the scenario name plus scorer version plus samples already identifies the measurement. A provenance field would stamp a constant.
- **Scope-wide matching.** Rejected while designing the helper: it blocks the legitimate multi-skill split and buys nothing, since exposure travels through a skill's own selection, not through the scope.
- **Warn-and-continue instead of throw.** Rejected: the sibling overlap check throws, and a contaminated holdout is the same class of error — a validation that cannot validate. A warning the run outlives is silent training with a log line.

## Consequences

The §35 loop closes for the exposure this harness can actually create: search-to-holdout promotion within a skill. What §35 names beyond it does not occur here by construction — mutation input carries telemetry counts, never scenario fixtures, so memory exposure of evaluation answers has no path; and the screen subset is a cost cut inside one run, not a second benchmark. Documented in the README's holdout bullet, the validation paragraph, and the privacy limit (which now says what it means: private by configuration, but not launderable through it).

## Verification

- 102 tests pass in `evolution-optimizer` (3 unit for the helper, 1 orchestration proving the throw plus the untouched repeat/overlap guards); per-file 100% statements, branches, functions, and lines.
- `tsc -b` clean; oxlint 0 warnings, 0 errors.
- New: holdout-after-search throws naming the scenario; holdout-only history stays clean; search reuse across runs still skips rather than throws (existing repeat tests).
