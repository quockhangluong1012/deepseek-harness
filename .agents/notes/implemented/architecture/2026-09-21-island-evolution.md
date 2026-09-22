# Agent Note: Island evolution

Status: implemented

English | [中文](2026-09-21-island-evolution.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "island evolution" as P2 #21 and §7 defines the island model: multiple logical islands — conservative, performance-heavy, cost-heavy, novelty-heavy, adversarial — with periodic migration of strong candidates between them, because without diversity preservation the harness converges on the first "pretty good" skill and stops discovering alternatives. The harness had no notion of parallel evolution lanes for one skill, no record of candidates moving between lanes, and no schedule deciding when a migration is due.

## Decision

One new package, `dsh-evolution-islands`, holding durable per-skill evolution lanes and their migration records:

1. **Lanes are registered, ticks are advanced.** An operator registers islands with one of §7's five objectives (`ISLAND_OBJECTIVES`); a duplicate island id rejects loudly. The optimizer advances the skill's head island — the newest registered — one generation tick through the optional store seam right after `stageWrite`; a skill with no island yet is a silent no-op, and a failing record logs a warning without failing the optimization.
2. **Migrations are recorded, not executed.** `migrate` validates both islands exist and serve the same skill, then records the move with a reason (`schedule` | `elite` | `diversity`) under a fresh migration id, so a candidate may migrate repeatedly and every move stays on record. §58.12 keeps trust recorded-not-enforced: nothing here moves a candidate by itself.
3. **The schedule is pure and configured.** `migrationDue` anchors an unmigrated island at its registration instant and a migrated island at its last migration, then compares against the cadence. The cadence is a validated `Config` field with a one-day default; `schedule(skill?)` renders each island with its last migration and due flag.
4. **One durable domain, one command surface.** The `evolution_islands` domain (v1) holds `islands` and `migrations` tables. `/islands` lists the schedule, registers a lane, records a migration (default reason `schedule`), and reads the migration log. The package is mounted in the web-app profile (it writes only its own domains and reaches no model prompt).

## Alternatives considered

- Fold islands into the population store — rejected: population tracks one lineage per skill; islands are parallel lanes with independent objectives and their own migration history, a different shape that would overload the candidate record.
- Migrate automatically on the schedule — rejected: §58.12 keeps trust recorded-not-enforced; the schedule flags due migrations, and a human (or a future automation) performs the move.
- Per-objective policies on mutation operators or evaluators — rejected: §7's objectives are recorded vocabulary for now; steering each lane's operators, seeds, or evaluators differently needs an owner and is documented as deferred.

## Consequences

- Diversity preservation is now visible: `/islands list writer` shows the skill's lanes with generations and which migrations are due, so operators can keep several candidate strategies alive instead of one winner.
- Migration history is durable and auditable: every move records from/to, candidate, skill, reason, and instant, and a candidate's repeated migrations never collide in the table.
- The optimizer stays decoupled: recording is optional and failure-isolated.

## Deviations from the plan

None beyond routine. Head selection was extracted into the pure `headIsland` helper (newest registration; equal instants keep input order, mirroring the population store's `headOf`). Private table fields are named `islandTable`/`migrationTable` because a private field named `islands` shadows the public `islands()` method on the instance.

## Fixes found on the way

A private field named `islands` collided with the public `islands()` method, breaking every `store.islands(...)` call with "is not a function"; the fields were renamed. A first draft ordered same-millisecond registrations by island id, which made head selection timing-dependent in tests; the tie-break was removed to mirror `headOf`, and the store test inserts a millisecond gap to keep the head deterministic. The schedule test initially expected the destination island's last-migration to stay null, but a migration touches both ends; the assertion now expects the migration on both, with a third untouched island covering the null branch.

## Testing

Island helpers: migration due anchored at registration vs. last migration, exact-cadence boundary, head selection by newest registration with input-order ties. Store: registration with zero generation and duplicate rejection, head advancement with and without an island, migration recording with unknown-island and cross-skill rejections and repeated moves, listing order/filter/detached copies, schedule rendering with last migration and due flags, configured cadence, restart persistence through the zod spec, reads-before-start. Optimizer hook: the skill head island advances in a mounted store, staging is unchanged when unmounted, and a failing store logs a warning. `/islands`: unmounted, grammar usage, registration with error propagation, migration with default and explicit reasons and error propagation, schedule listing, migration log, empty schedule. 13 islands tests, 3 new optimizer tests, and 4 new command tests pass; the new package is at 100% statements/branches/functions/lines, and the optimizer stays at 100%.

## Left alone

Migrations are recorded, not executed: the schedule flags due migrations per §58.12, and moving a candidate remains an operator's job (documented in the package's Known Limitations). One generation tick lands on the head island only; parallel ticks across all of a skill's lanes are not tracked. The five objectives are labels, not policies: no lane yet steers mutation operators, seeds, or evaluators differently.
