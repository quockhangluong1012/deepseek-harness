# Agent Note: Evolution governance commands

Status: implemented

English | [中文](2026-09-12-command-evolution-governance.zh.md)

## Problem

After `/memory` and `/refine` landed, a human could decide staged memory writes and rebuild lessons, but not see what the harness had recorded, decide a staged skill entry, or read curation status at all (`/memory approve` answered a skill-kind id with "needs its skill write first" and nothing else). `specs/improvement.spec.md` Phase 6 names the missing surface and makes the CLI the governance owner until the Web journey lands: `/journey [today | 7d | 30d | all]`, `/skills pending | diff | approve`, `/curator status | run [--dry-run]`.

The visibility half needed a read model over data that already exists — the scope record, the curator's ledger, skill telemetry — with no new durable state, no session event, and no model-visible text.

## Decision

`@deepseek-ai/dsh-command-evolution` registers three more commands and splits skill-kind governance out of `/memory`.

`/journey [range]` renders the scope timeline from a new pure module, `src/journey.ts`: `scopeTimeline(input)` takes the record the command already read, capacity, digest, range, and clock, and returns day buckets, cumulative accounting, and pending rows. A delta is emitted only for a fact the record proves — the memory document (extraction origin, or "edited by hand" from `memoryUpdatedAt`), each context item, each indexed output, each staged entry — placed on the dashboard's UTC+7 calendar. The calendar helpers (`dayKeyUTC7`, `daysOfRange`, `windowStartOfRange`, `isUsageRange`) are now exported from `@deepseek-ai/dsh-usage-ledger`, so the journey buckets on exactly the days the usage dashboard reports instead of re-deriving the zone offset.

Bounded ranges keep zero-filled buckets in the model (the spec's shape) and render only active days plus the window, so a quiet `30d` window stays one screen; `all` reports its active-day count. The command's output is capacity, document bytes, digest, the per-day lines, and the staged count — all host-stable text.

`/skills pending | approve <id> | diff <id>` owns skill-kind staged entries. Approving drops an entry whose skill file the human already wrote through `skill_manage` (the store's approver deliberately performs no write), and the success text says so. `/memory approve` on a skill-kind id now redirects to `/skills approve <id>` instead of explaining the refusal, and `/skills approve` on a memory-kind id reports `No staged skill '<id>'.` — one decision path per kind, no silent cross-kind apply. `diff` reports the actual gap: the staged payload has no declared shape until background review proposes skills.

`/curator status` is host-wide and resolves no scope, and `/curator run [--dry-run]` runs the same maintenance pass the interval trigger owns — grammar is validated before the mount check, so a malformed verb reports usage even where no curator exists: it reads `evolutionCurator.lastRunAt()` / `passes()` and `evolutionSkillTelemetry.entries()` through `ctx.get`, so a deployment without either service still gets the command with an honest short answer (`The evolution curator is not mounted.`, or `Tracked skills: unavailable (skill telemetry is not mounted).`). The pass reports its movements, skip counts, and snapshot id, and marks a preview as writing nothing.

## Consequences

A human can now see what a scope recorded and when, decide a staged skill entry, and read curation bookkeeping without a Web client or storage inspection; the commands add no durable state and no model-visible text.

The timeline reports the facts the record keeps. Two spec-listed bucket counts do not appear: `stagedApproved` and `stagedRejected` need a resolution record the store does not keep (it drops the entry on either decision) and the session-query surface read exposes model-surface events only, so per-event `command/run` payloads are not reachable without an N+1 event-window read; and `instructions` / `profile` deltas are not separable from lessons because the record keeps one `memoryUpdatedAt` for that family and shares `updatedAt` with output indexing and staging. Both gaps are recorded in the package README and the specification rather than filled with a guess.

Skill-kind governance is now a two-step contract a human must understand: write the skill, then approve the entry. A deployment that stages skill entries but never mounts `skill_manage` can approve into nothing, which the success text warns about explicitly.

## Verification

`packages/evolution/command-evolution/tests/journey.spec.ts` pins the pure model against a fixed clock: day bucketing across two UTC+7 days, window filtering for `today`/`7d`/`all`, zero-filled bounded ranges against data-only `all`, the hand-edited fallback, capacity/digest/document bytes, pending projection, and the rendered text including the empty-range and zero-capacity cases.

`packages/evolution/command-evolution/tests/command-evolution.spec.ts` pins the commands through the real registry: registration and disposal of all five commands, usage errors, the scopeless refusal, a seeded `/journey` rendered exactly (with the day key computed from `dayKeyUTC7`), the `/skills` empty state and its skill-only listing, approval dropping the entry, the cross-kind refusals on both commands, the `diff` gap message, `/curator status` with and without telemetry and with recorded passes, and `/curator run` in both modes with its skip counts, snapshot line, singular/plural wording, and unmounted refusal.

Documentation gates keep the contract visible: `verify-package-readme-limitations`, `verify-package-readme-summaries`, `verify-export-jsdoc` on the new exports, and `verify-translation-pairing` for the README trio.

## Alternatives considered

**Wait for the Remote controller and build the read model there.** The spec assigns the timeline to `evolutionController`, which does not exist yet, so the CLI would have gained nothing this phase. The model lives in `src/journey.ts` and is exported, so the controller can import it instead of restating it.

**Derive approval counts from `command/run` events.** The payload carries the command name and arguments, but the session-query seam returns event records without payloads; reaching them means one `readEvent` window per command event, which is an N+1 read for a count. Recording resolutions in the store is the durable fix and belongs to the spec change that adds them.

**Report `instructions` and `profile` deltas from `updatedAt`.** That timestamp also moves for output indexing and staging, so the claim would be wrong whenever the record changed for another reason. One memory delta that names its actual source is the honest shape.

**Keep every staged decision in `/memory`.** A single command that silently drops skill entries would let a human believe a skill landed; the split makes the two-step contract explicit in the message that refuses it.

**Put the timeline vocabulary in a new package.** The kinds and buckets are the command's read model today and the controller's tomorrow; a package whose only current consumer is one command adds a workspace entry and a dependency chain for no reuse yet.
