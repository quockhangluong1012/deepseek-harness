# Agent Note: Curator regression debt

Status: implemented

English | [中文](2026-09-21-regression-debt.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §53 upgrades Metrics to "learning velocity + regression debt + capability frontier". The curator staged failing skills onto an append-only ledger, but kept no per-failure memory across passes: a decisive `trigger_review` failure surviving five consecutive passes looked identical to a first sighting, and consolidation had no backlog naming what the loop has not answered.

## Decision

One open debt per decisive failure per skill, in the `debt` table of the `evolution_curator` domain (version 2, alongside the existing tables). `RegressionDebt` (`packages/evolution/evolution-curator/src/types.ts`) carries name, merge key, newest message, first/last sighting instants, consecutive-pass count, reporting sessions, and the skill revision that opened it. Each pass, per skill: a new merge key opens a debt at one pass; a repeated sighting deepens it (newest message, most sessions, passes plus one); a revision closes the old debt and opens a fresh one, because the new body has not answered the old failure; a failure gone silent closes its debt even while another persists. `debt()` lists every open debt synchronously — most passes, then most sessions, then name and merge key — and `CuratorReport` carries the same list. Dry runs write nothing. Keys join name and merge key with a NUL separator (`debtKeyOf`) so the per-skill prefix scan stays unambiguous. Debt names failures, not verdicts: consolidation and future benchmark growth read what to aim at rather than what was decided.

## Alternatives considered

- **A counter on the staging ledger** — rejected: the ledger is append-only evidence of what was staged, not a current-state store; per-failure open/close/deepen semantics do not belong in it.
- **Auto-staging debt into optimization** — rejected: debt is the regression backlog, and promotion stays with consolidation and the optimizer trigger; conflating them would turn every lingering failure into an optimization run.
- **Closing debt on any pass without a sighting, globally** — narrowed per skill: signals are attributable per skill, so silence is only meaningful against the skill that went quiet.

## Consequences

- Pass reports now carry the unanswered-failure backlog in the same shape `debt()` serves to status surfaces.
- Revision-scoped debts make `patch`/`consolidate` verdicts falsifiable: the old failure closes only when the new body stops reproducing it; a reproducing new body reopens at one pass rather than inheriting history it did not cause.
- The domain stays the only copy of this state, so no invariant companion is published — the README records why, per package rule.

## Deviations from the plan

- None: the slice is the §53 regression-debt row scoped to one package, one table, and one report field.

## Testing

- Curator suite green (81 tests): debt lifecycle (open, deepen, silent close, revision reset), total ordering, dry-run writing nothing, feedback-store failure not blocking the pass.
- `reads fail before the curator starts` extended with the sync `debt()` guard.
- Curator README documents the table in both languages.

## Left alone

- Learning velocity and capability-frontier metrics from the same §53 row remain future slices.
- No automatic consumption of debt by the optimizer or consolidation: readers opt in.
