# Agent Note: Benchmark growth from production failures

Status: implemented

English | [中文](2026-09-21-benchmark-growth.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "benchmark generator" as P1 #17 (§14, §35): production failures should automatically grow the evaluation benchmark, deduplicated and contamination-controlled, instead of a fixed corpus going stale. The harness had recorded corpora (scorer scenarios) and regression debt (curator), but nothing durable held the benchmark states — fresh/search/validation/holdout/contaminated/retired — that would stop a task used for mutation from being treated as a clean test forever.

## Decision

One new package, `dsh-evolution-benchmark`, holding evaluation tasks with a lifecycle:

1. **Deduplication is content-addressed.** `benchmarkHash` is the sha256-hex of the whitespace-collapsed task text; `dedupe` splits candidates into admitted and duplicates against the still-learnable hashes. Contaminated and retired tasks never block re-admission, so a repaired task can re-enter the pipeline.
2. **The state machine is the contamination control.** Tasks enter as `fresh` and advance `fresh → search → validation → holdout` one step per call; any learnable state can derail to `contaminated` or `retired`, and terminal states never leave. Illegal transitions and unknown ids reject loudly.
3. **One durable domain, one command surface.** The `evolution_benchmark` domain (v1) holds one `tasks` table keyed by task id. `/benchmark` lists by state, `admit` promotes the curriculum store's open proposals into fresh tasks (the shipped producer → benchmark pipeline), and `promote`/`retire` walk the ladder. The package is mounted in the web-app profile (it writes only its own domain and reaches no model prompt).

## Alternatives considered

- Reuse the scorer's recorded scenario fixtures as the benchmark — rejected: fixtures are read-only files, not stateful tasks; the benchmark needs the contamination lifecycle §35 prescribes (a task used for search must not stay `fresh`).
- Extend the curriculum package with states — rejected: curriculum proposes tasks from gaps; benchmark curates evaluation tasks with a lifecycle; one package one lifecycle keeps each state machine small and testable.
- Deduplicate by capability + task text pair — rejected: a content address over the task text alone blocks identical tasks regardless of capability, which is the duplicate definition the spec asks for.

## Consequences

- Production failures can grow the benchmark automatically: `/benchmark admit` turns the curriculum's failure-grounded proposals into `fresh` evaluation tasks.
- Contamination is explicit: a task only advances when promoted, and its current state always answers "has this been used for search yet?".
- Re-admission works: a contaminated or retired duplicate does not block its repaired twin from re-entering.

## Deviations from the plan

None beyond routine. The `promote` command auto-picks the next ladder step when no state is named (`nextLadder`), so an operator need not remember the ladder order.

## Fixes found on the way

The command spec's benchmark stub initially reported duplicates as a count; the command reads `duplicates.length` (the real store returns texts), so the stub now returns texts.

## Testing

Dedupe: content-address normalization, admitted/duplicate splitting with in-pass dedup, blocking-state classification, ladder transitions and derailment, `nextLadder`. Store: admission with hashes and duplicate reports, re-admission after contamination/retirement, `maxAdmit` cap, listing order and filter with detached copies, legal/illegal/same-state/terminal transitions, unknown ids, reads-before-start. `/benchmark`: unmounted, usage, state listing, admit from open curriculum proposals (and the missing-store error), auto and explicit promotion, no-promotion-from-holdout, unknown id, retire, transition-failure mapping, registration and disposal. 11 benchmark tests and 144 command tests pass; the package is at 100% statements/branches/functions/lines.

## Left alone

The store holds states but nothing runs the tasks or scores candidates against them — wiring the optimizer/scorer to the benchmark states is the evaluation work ahead (documented in the package's Known Limitations). Benchmarks are host-wide, not scope-keyed; per-scope keying is deferred.