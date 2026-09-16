# Agent Note: Capability frontier

Status: implemented

English | [中文](2026-09-16-capability-frontier.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §33 asks for a map of capability → current score → confidence → known failures → skill coverage, so the system can answer "what should I learn next?" instead of waiting for another task. Every input already existed in-repo — optimizer ledger rows with winner triples and promotion tallies, telemetry records with loads and failures, feedback signals, the skill catalog — but nothing joined them: `/suggestions` lists schedulable blueprints (a different axis), `/curator experiments` lists runs newest-first without ranking skills. The frontier was the missing join.

## Decision

**A pure ranking plus one read-only command, no new package, domain, write, or knob.**

- **A capability is one skill.** The telemetry record is the only per-skill identity every seam joins on: optimizer rows carry `skill`, feedback correlates through the record's `sessionIds`, the catalog is keyed by name. Anything broader (task areas, domains) would have needed a taxonomy the repo does not own.
- **`rankFrontier` is pure** (`command-evolution/src/frontier.ts`): weakest first in three groups — failing without a passing winner, then unmeasured, then passing. Failing sorts by failures desc then name; unmeasured by name; passing by unconfirmed-first, then demonstrated wins, then win rate, then cost (costlier pass = weaker, the optimizer's own dominance). No weights, no thresholds; the groups are the ranking. Archived skills never rank — leaving the learning pool is the curator's call.
- **`/frontier` reads the seams directly**, the command package's established pattern: optimizer experiments per skill (each skill's own ledger page, so no truncation), telemetry entries, top feedback signal per skill session list, catalog descriptions. Optimizer and telemetry missing fail loudly; catalog and feedback missing degrade to less text. Outside a workspace scope fails like every other scoped command.
- **One row per skill, self-documenting output**: score (`pass/fail at N tokens` or `unmeasured`), tally (`wins/runs`, omitted when unconfirmed), failures with the top "while in play" message, loads and sessions, description — closed by the ranking rule in-output. The "while in play" qualifier is deliberate: feedback correlates by session, not causation, and the row must not claim otherwise.

## Alternatives considered

- **Folding the frontier into `/suggestions`.** Rejected during design review: suggestions ranks schedulability (blueprints), frontier ranks measured weakness — one output sorted by two axes serves neither reader.
- **A new package with its own service and domain.** Rejected: the frontier derives state others own and writes nothing; a service would have added registration, lifecycle, and catalog surface for a join.
- **Confidence as wins-only or rate-only.** Rejected while covering comparators: wins-only ranks a solid 4/5 below a thin 1/1; rate-only ranks it above. Wins, then rate, then cost puts thin evidence before measured-good and struggling before solid — the order "learn next" actually wants.
- **String-compare scores for ordering.** Rejected in favor of sorting inputs before rendering: `pass at 10000 tokens` sorts after `pass at 900` lexicographically. The module comment states the rule.
- **Surfacing archived skills as "known failures".** Rejected: un-archiving is a curator decision; the command skips their reads too, not just their rows.

## Consequences

A human (or a future scheduler) sees weakest-first capabilities with the evidence behind each line, closing the §33 loop with the seams built for other batches. Costs, all documented: telemetry is host-wide while experiments are per-scope, so a skill's coverage may reflect other scopes; a skill alternating weekly between recovered and failing will move on the frontier each pass; and per-skill ledger queries make the command O(skills), fine for a chat command, wrong for a hot loop.

Verification: 11 unit tests for grouping, ordering (both comparator directions — two-element sorts call once, so both input orders are asserted), archived exclusion, and row rendering; 4 command tests (usage/seams/scope guards, empty state, full four-seam render with exact text, degradation without feedback or catalog); plus the registration listing. 100% statements, branches, functions, and lines on `frontier.ts`.
