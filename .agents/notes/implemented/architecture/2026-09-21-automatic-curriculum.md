# Agent Note: Automatic curriculum from measured capability gaps

Status: implemented

English | [中文](2026-09-21-automatic-curriculum.zh.md)

## Problem

`specs/evolutionary-harness-v11-deep-research.md` §51 ranks "automatic curriculum" as P1 #14 (§10, §33): the harness should propose its own next tasks from measured capability gaps instead of waiting for a user to provide them. The evidence existed — the compressed learning traces (P0 #1) carry per-session failure gists, and telemetry maps skills to the sessions that loaded them — but nothing derived tasks from it, so learning stayed passive.

## Decision

One new package, `dsh-evolution-curriculum`, deriving and staging training tasks:

1. **Measurement is a join, not a model call.** `gaps()` reads the mounted telemetry and trace seams: for every tracked skill with sessions, the distinct failure gists of the compressed trace rows of those sessions. Without either seam nothing is measured. The join deliberately mirrors the curator survey's skill-sessions→evidence join, so both consumers see the same evidence shape.
2. **Derivation is pure and grounded.** `deriveTasks` emits one task per evidenced gap, most evidence first: the task names the capability, the recurring failure, and the session count, so a run can reproduce and recover from it. Task text is bounded (≤240 chars, ≤3 cited gists).
3. **Proposals are durable and deduplicated.** The `evolution_curriculum` domain (v1) holds one `proposals` table keyed by proposal id with `{id, capability, task, sourceSessions, gists, at, state}`. Staging skips open proposals for the same `capability + task`; `proposals()` lists open first, newest first; `retire(id)` retires deliberately.
4. **One command surface.** `/curriculum` measures, stages, and lists in one step; `/curriculum retire <id>` retires one. The package is mounted in the web-app profile (it writes only its own domain and reaches no model prompt).

## Alternatives considered

- Generate task text with a model — rejected: a model call per gap is the wrong default for a substrate that runs on every pass; the derived text is honest, and a model author can layer on later without changing the schema.
- Reuse the curator survey output as the gap source — rejected: the curator is lifecycle governance; curriculum needs the trace store's compressed rows (its P0 #1 consumer), and coupling the two would blur ownership.
- Derive tasks from the capability frontier ranking alone — rejected: the frontier ranks skills by mixed evidence; the curriculum needs the failure gists themselves so a task states what to reproduce.

## Consequences

- Learning is no longer passive: every pass can propose the next training/evaluation tasks from measured failures, directly consuming the P0 #1 trace substrate.
- Tasks are durable and idempotent: restarts keep them, re-running a pass stages nothing new for the same gap, and retirement is explicit.
- Nothing model-visible changes: the package registers no prompt, tool, or session event, and adds no model call.

## Deviations from the plan

None beyond routine: the gap measurement sits on the service (`gaps()`) rather than in the command, so the join has one owner and the command stays thin.

## Fixes found on the way

None.

## Testing

Derivation: no task for an evidenceless gap, one grounded task per gap ordered by evidence breadth, gist citation capped, text clipped, one-session vs many-session wording. Store: evidence floor, dedup against open proposals, open-first ordering, retire paths (unknown id, already-retired), reads-before-start. Gap measurement: both seams mounted (deduped gists, empty-session skill skipped), missing seam, no-gist trace rows. `/curriculum`: unmounted, usage, staged+listed rendering, nothing-staged message, retire success and failure. 12 curriculum tests and 139 command tests pass; the package is at 100% statements/branches/functions/lines.

## Left alone

No executor consumes the proposals yet — the evaluation/benchmark and shadow/canary work (P1 #17, #19) owns running them — and proposals are host-wide rather than scope-keyed; both are documented in the package's Known Limitations.