# Agent Note: `/journey export` — bundled timeline and session-log zip

Status: implemented

English | [中文](2026-09-12-journey-export-zip.zh.md)

## Problem

Operators want a portable artifact for a scope's evolution state plus the conversation that produced it — bug reports, archiving, or external review — and the `/journey` render command only prints the timeline as text.

## Decision

`/journey export [range] [--out <path>]` bundles `timeline.json` (the scope's evolution activity over the given range) and the invoking session's log as `session-log.jsonl` into a single ZIP archive. It is added to `command-evolution/src/index.ts` alongside the existing `/journey` render command.

`executeJourneyExport()`:

1. Parses `[range]` (defaults `7d`) and `--out <path>` (defaults `$DSH_HOME/exports/journey-<scope>-<range>.zip`).
2. Calls `scopeTimeline()` exactly as the render path does.
3. Reads the session's event log via `snapshotEvents()` (deprecated but the only one-shot access) and serializes with `serializeSessionLog` from `@deepseek-ai/dsh-session-log-export`.
4. Produces a synchronous ZIP via `fflate`'s `zipSync`.
5. Writes to the output path with `mkdir -p` on the parent directory.

`parseJourneyExportArgs()` mirrors the `parseTrajectoryArgs()` grammar, `JourneyExportArgs.range` is typed `UsageRange` after validation through `isUsageRange`, and the change adds `fflate` (production) and `@deepseek-ai/dsh-session-log-export` (peer) as dependencies plus a TypeScript project reference to `session-log-export/tsconfig.host.json`.

## Alternatives considered

**Read the session log from persistence instead of `snapshotEvents()`.** The deprecated accessor is the only one-shot access to the invoking session's events, so the export keeps it and carries the follow-up inline: the serializer is inlined when `snapshotEvents` is dropped.

**Reuse the streaming zip writer `@deepseek-ai/dsh-session-log-export` already carries.** The bundle is two small in-memory buffers, so the synchronous `zipSync` call in the command suffices and the streaming `Zip` API stays with the session-log export that needs it.

**Call `parseTrajectoryArgs()` for the argument grammar.** The export takes a `[range]` positional that the trajectory grammar has no place for, so `parseJourneyExportArgs()` mirrors its shape instead of delegating to it.

## Consequences

A scope's timeline and the conversation that produced it travel as one file, and the default output path lands under `$DSH_HOME/exports/` rather than anywhere the scope names. The costs are the dependency pair and project reference above, and the deprecated `snapshotEvents()` accessor the bundle still reads through.

## Testing

`'exports journey timeline and session log to a zip file'` in `command-evolution.spec.ts` verifies:

- A success result with the expected output path.
- The ZIP contains exactly `timeline.json` and `session-log.jsonl`.
- `timeline.json` parses and has the expected top-level keys (`days`, `cumulative`, `pending`).
- `session-log.jsonl` starts with the session header record whose `id` matches.
