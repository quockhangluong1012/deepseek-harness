# Agent Note: Reviewer defer queue

Status: implemented

English | [中文](2026-09-12-evolution-reviewer-defer-queue.zh.md)

## Problem

The reviewer extracted lessons at `turn/end`. That is the right moment when the extraction competes for nothing, and the wrong one when it competes with the conversation for the same provider: every gated turn paid for a second generation before the next user message could be served, and a burst of short turns paid it once per turn for snapshots that largely overlapped.

`specs/evolutionary-harness.spec.md` names the missing contract as reviewer-owned deferral — `defer: auto|never` plus `deferMaxAgeMs`, queued at turn end, coalesced per session, forced after the age ceiling, in memory only — and keeps it distinct from `deferContext`, which defers context materialization rather than review.

## Decision

`defer` defaults to `auto`: a gated turn enters an in-memory per-session queue instead of extracting immediately. `deferMaxAgeMs` defaults to `1800000` and bounds a queued turn's age, measured from the session's **first** snapshot, so a session that keeps producing turns still extracts within the ceiling rather than postponing forever. A later turn replaces the queued snapshot's `turn`/`rows`/`route` while the original deadline and timer stand: coalescing keeps one extraction per quiet window instead of one per turn.

The flush runs a due entry through the same per-scope promise chain the immediate path uses, so one scope never runs two extractions at once and a superseded entry drops exactly as it did before. `defer: never` restores turn-end extraction. `/refine` (the reviewer's `rebuild`) never consults the queue.

Disposal and teardown drop queued entries and clear their timers without extracting: they abort bound background work, and starting a new model call while a session is being torn down would be the opposite of that. The gate order is unchanged — membership, output indexing, `enabled`, `minTurnTextBytes`, cooldown, route — and the cooldown is deliberately not re-checked at flush time, because a queued turn already passed it.

No tool whitelist accompanies the queue. The specification's `extraTools[]` belongs to the deferred subagent fork; the in-process extraction is one tool-less request, so a whitelist field would have no reader.

## Consequences

Steady-state cost per turn drops to zero model calls; a session that ends goes quiet for at most `deferMaxAgeMs` before its lessons land. Memory is therefore staler by up to that ceiling, which is the trade the specification chose: the brief keeps working from the previous document meanwhile.

Queued snapshots are in memory only. A restart, teardown, or `session/disposed` before the deadline loses that turn's extraction — the records keep whatever the previous extraction wrote, and the next turn rebuilds from the observed suffix rather than replaying the lost one.

`timer.unref?.()` keeps the queue from pinning the event loop open, so a process with nothing else to do can still exit while a turn waits.

## Verification

`tests/reviewer.spec.ts` pins the observable behavior: `defer: never` extracts at turn end as before; `defer: auto` with `deferMaxAgeMs: 0` extracts nothing synchronously and exactly one extraction after the timer turn; the default (no `defer` key) queues; two turns closed before the flush produce one extraction whose transcript is the newer turn's and not the older one; teardown drops an armed entry without extracting; and a timer whose session was disposed before it fired starts nothing. `tests/config.spec.ts` pins the schema: an unknown mode and a negative ceiling throw, and `Config({})` resolves to `auto`/`1800000`. Per-file 100% holds on statements, branches, functions, and lines.

## Alternatives considered

**A runtime-availability signal.** Waiting for a "local model is busy" flag, as the upstream design does. Rejected: no such signal exists in this repository, and inventing one would couple the reviewer to a provider detail. The age ceiling gives a bounded delay without one.

**Deferring by a fixed delay from the newest turn.** Rejected: a busy session would push its own extraction back indefinitely; measuring from the first snapshot converts an unbounded wait into the ceiling.

**Persisting queued snapshots.** Rejected for now: the queue is a scheduling detail, and a durable queue would need its own format, migration story, and duplicate-suppression rules for a window measured in minutes.

**Keeping extraction synchronous with the turn.** Rejected: it makes background review part of the user-visible latency it was designed to sit behind.
