# Agent Note: A host-wide idle-triggered task registry for the Evolutionary Harness

Status: implemented

English | [中文](2026-09-13-evolution-heartbeat.zh.md)

## Problem

The Evolutionary Harness maintains itself in the background: the reviewer extracts lessons after a turn, the curator moves idle skills along their lifecycle, and every further mechanism — memory consolidation, optimizer passes, index rebuilds — adds another piece of autonomous work.

Only the curator owned a host-wide schedule, and it owns it privately: its interval, idle gate, timer, and first-run deferral are wired to skill-lifecycle transitions. A new autonomous task therefore had two bad options — fold itself into the curator's pass, coupling unrelated work to skill curation's thresholds and failure semantics, or start a private timer, so a host with three maintenance tasks carries three timers, three idle observations, and three independent first-run deferrals.

The specification's Heartbeat mechanism names the missing middle: autonomous maintenance scheduled on idle time, owned once per host.

## Decision

`@deepseek-ai/dsh-evolution-heartbeat` provides `ctx.evolutionHeartbeat`, a host-wide registry of named maintenance tasks.

A consumer calls `register({ name, intervalHours, minIdleHours?, run })` and receives an idempotent disposer; its task runs only while that registration is live. The plugin runs one awaited start-time due-check and then one `unref()`ed timer every `tickMinutes`, disposed through `ctx.effect`, and observes host-wide `session/event` for the newest activity instant. A host that observed no activity at all counts as idle.

A task is considered only when its interval elapsed since its last attempt and the observed idleness satisfied its threshold. That threshold defaults to the engine's `minIdleHours` and a task may raise it. `runDue` exposes the same decision with clock, idleness, and `force` overrides; `runTask` runs one task immediately; `state` reports each task's cadence and last outcome.

Bookkeeping is one row per task in the `evolution_heartbeat` storage domain, version `1`, layout `per-record`, table `tasks`: the last attempt instant and the last failure message. An absent row is what defers a newly registered task by one interval, so mounting the engine never fires every task at once. Every attempt stamps the row whether it succeeded or failed, so a permanently failing task is retried on its interval rather than on every tick. Tasks run sequentially in registration order, and a rejection is contained — recorded in `lastError`, logged once, and never stopping the rest of the pass.

The engine is mounted in no shipped bundle. It has no registered consumer yet, and a mounted timer with no tasks would be pure overhead; the first consumer lands with its own composition row.

## Alternatives considered

**Fold maintenance into the curator's pass.** The curator already owns an idle gate, a host-wide timer, and first-run deferral, so the cheapest change was to let other work ride its pass. It loses on coupling: the curator's interval, idle threshold, and stale/archive thresholds describe skill lifecycle, and a memory-consolidation task inheriting them would run on the wrong schedule for the wrong reason. Its failure semantics are also transaction-shaped — a failing transition stops the pass and leaves the bookkeeping unstamped — which is wrong for independent maintenance tasks.

**Start a timer per consumer package.** Each task then owns its cadence and its failure isolation completely, with no shared registry. The cost is duplication: every package re-implements the idle observation, first-run seeding, and teardown of one `unref()`ed interval, and a host running several of them pays several timers and several independent guesses at "the host is idle".

**Reuse `@deepseek-ai/dsh-schedule`.** The existing Schedule package already persists work and delivers it on time. It delivers *reminders into a conversation* and its contract is explicit that nothing runs while the session is cold, which is the opposite of what host-wide maintenance needs; reusing it would mean either bending that contract or running maintenance only while a session happens to be live.

**Cron-style expressions instead of an interval.** Calendar rules such as "daily at 03:00" read naturally for maintenance and match the specification's cron examples. They also add a parser, a time-zone question, and daylight-saving semantics to a plugin whose job is "run this occasionally when nobody is working". An interval plus an idle gate expresses the real requirement — do not compete with the user — without a scheduler dialect.

## Consequences

The harness now has one place to schedule autonomous work, and a new maintenance mechanism costs a `register` call instead of a timer. The engine's own surface stays small: no model-visible registration, no tool, no UI, so it needs no real-composition test and no snapshot.

The trade-offs are real and recorded in the package README: tasks run sequentially and the engine imposes no per-task deadline, so a task that never settles blocks the rest of its pass and must bound itself; a failed attempt stamps `lastRunAt` and therefore waits a full interval before retrying; registrations live in memory and are re-established by the mounting plugin on restart; and the first due-check of a task only seeds it, so its first real run is one interval away.

Two implementations of the same idle gate now exist — this engine and the curator. Migrating the curator onto the registry would collapse them into one, but it changes shipped, tested curation behavior, so it is deliberately not part of this change and has no design owner yet.
