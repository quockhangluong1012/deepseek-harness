# `/journey export`: bundled timeline + session-log zip

## What

`/journey export [range] [--out <path>]` bundles `timeline.json` (the
scope's evolution activity over the given range) and the invoking session's
log as `session-log.jsonl` into a single ZIP archive.

## Why

Operators want a portable artifact for a scope's evolution state plus the
conversation that produced it — bug reports, archiving, or external review.

## Implementation

- Added to `command-evolution/src/index.ts` alongside the existing
  `/journey` render command.
- `executeJourneyExport()`:
  1. Parses `[range]` (defaults `7d`) and `--out <path>` (defaults
     `$DSH_HOME/exports/journey-<scope>-<range>.zip`).
  2. Calls `scopeTimeline()` exactly as the render path does.
  3. Reads the session's event log via `snapshotEvents()` (deprecated but
     the only one-shot access) and serializes with
     `serializeSessionLog` from `@deepseek-ai/dsh-session-log-export`.
  4. Produces a synchronous ZIP via `fflate`'s `zipSync`.
  5. Writes to the output path with `mkdir -p` on the parent directory.
- `parseJourneyExportArgs()` mirrors `parseTrajectoryArgs()` grammar.
- `JourneyExportArgs.range` is typed `UsageRange` after validation through
  `isUsageRange`.
- Dependencies added: `fflate` (production), `@deepseek-ai/dsh-session-log-export`
  (peer).
- TypeScript project reference to `session-log-export/tsconfig.host.json`
  added.

## Test

`'exports journey timeline and session log to a zip file'` in
`command-evolution.spec.ts` verifies:
- Success result with the expected output path.
- ZIP contains exactly `timeline.json` and `session-log.jsonl`.
- `timeline.json` parses and has the expected top-level keys (`days`,
  `cumulative`, `pends`).
- `session-log.jsonl` starts with the session header record whose `id`
  matches.