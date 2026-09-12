# Agent Note: Evolution Curator — Idle Auto-Transitions and Dry-Run Previews

Status: implemented

English | [中文](2026-09-11-evolution-curator.zh.md)

## Problem

Skill telemetry accumulated lifecycle states nobody moved: `active`, `stale`, and `archived` were written but no pass ever transitioned them, so curation evidence rotted and the specification's inactivity trigger (`intervalHours`, `minIdleHours`) had no owner. The full curator (consolidation, backups, ledger, rollback, purge) is a multi-round build, but the model-free half — idle auto-transitions with previews — is independently shippable and directly asserted by the verification contract's dry-run row.

## Decision

Ship `@deepseek-ai/dsh-evolution-curator` in the `evolution/` group with the automatic half only. `EvolutionCurator` (`ctx.evolutionCurator`) opens the `evolution_curator` domain (version `1`, table `meta`, single `state` row holding `lastRunAt`) and applies `active → stale → archived` over skill telemetry: idle age counts from the last load, or from seeding when never loaded, so never-used skills age under the same grace instead of archiving on sight. `maybeRun` gates on the master switch, the elapsed interval, and observed idleness; the first call only seeds the bookkeeping and defers one interval. `run` returns a `CuratorReport` with every movement, its reason, and skip counts for pins, protected names, and excluded sources; `dryRun: true` previews without writing. Telemetry stays optional through `ctx.get`: without the store a pass only advances the bookkeeping. `surveyCandidates` lists agent-created skills with verdict evidence (routing, state, idle age, use counters, sorted by name) without writing; the keep/patch/consolidate verdict arrives separately. Schedule references enter as explicit `protectedNames` until a schedule-to-skill seam exists; consolidation verdict, backups, ledger, rollback, purge, adoption, and on-disk archiving stay deferred with README entries.

## Alternatives considered

- **Reading the clock and idleness from host services.** Rejected: both arrive as call arguments (`now`, `idleMs`), so passes stay deterministic under test with no test hook and no hidden dependency.
- **Seeding `lastRunAt` at plugin load.** Rejected: the specification defers the first pass one interval from the trigger point, and load time is not a trigger. Only `maybeRun` stamps, so mounting without idleness costs nothing.
- **Deriving protection from the schedule package.** Rejected: no schedule-to-skill seam exists to read. An explicit name list is honest, coverable, and rewirable later; the README records the seam as deferred work.
- **An archive threshold independent of the stale threshold.** Rejected during testing: a lower archive would retire stale skills on sight. `resolveConfig` fails the inverted pair loudly.
- **Covering every host I/O fault in the pass.** Unnecessary: the pass performs no filesystem I/O — transitions go through telemetry and bookkeeping through the domain, both covered for real.

## Consequences

Idle curation now runs between sessions with a previewable report: hosts call `maybeRun` at start or idle, status surfaces read `lastRunAt`, and `dryRun` shows the exact movements before anything lands. Pinned, protected, and shared skills never move; off-catalog skills record under `custom` rather than escaping. Later slices added snapshots, ledger, rollback, adoption, purge, and the consolidation survey on top of this pass without changing it; the remaining contract is the keep/patch/consolidate verdict and on-disk archiving.

## Testing

Ten specs pin config defaults and the inverted-threshold rejection, pre-start failures, first-run seeding with interval deferral, disabled and fresh and recently-active idleness, the full `active → stale → archived` journey with reason text and terminal stability, never-used aging from seeding, pin/protection/exclusion skips including an off-catalog skill, dry-run purity with stamped bookkeeping, telemetry-absent bookkeeping, and the consolidation survey with name sorting, off-catalog evidence, and store-absent emptiness. Per-file 100% holds on statements, branches, functions, and lines.
