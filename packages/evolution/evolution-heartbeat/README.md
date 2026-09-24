---
description: "Host-wide idle-triggered task scheduling: one timer and a registry of autonomous maintenance tasks with durable per-task bookkeeping (ctx.evolutionHeartbeat)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-heartbeat

English | [中文](README.zh.md)

## Summary

`dsh-evolution-heartbeat` is the autonomous-maintenance engine behind the Evolutionary Harness: consumers register named tasks with their own cadence, and the plugin runs them while the host is idle. Mounted once per host, it owns a single timer, so every task shares one host-wide schedule. A task runs only once its interval elapsed and the host stayed idle long enough; its first due-check seeds the bookkeeping and defers one interval, so mounting the engine never fires every task at once. A failing task is recorded without stopping the others.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin once per host, then register tasks through `ctx.effect` so their asynchronous disposer drains a running attempt before its provider unloads.

```ts
import type { Context } from '@deepseek-ai/cordis'

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.evolutionHeartbeat.register({
    name: 'memory-consolidation',
    intervalHours: 24,
    run: async (signal) => { await consolidate(signal) },
  }))
}
```

The engine then owns the schedule: it observes host-wide `session/event` activity itself, runs one start-time due-check, and repeats a due-check every `tickMinutes` on an `unref()`ed timer disposed with the plugin. A task is considered only when its interval elapsed since its last attempt and the host was idle for its threshold; a host that observed no session activity at all counts as idle. Registering after start-up is fine: the next due-check seeds the task and defers one interval.

Call `runDue` to run the same due-check yourself (`force: true` ignores both the interval and the idle gate), `runTask` to run one task immediately, and `state` to read every task's cadence and last outcome.

### Configuration

The engine's cadence and its default idle threshold are validated `Config` members changeable from `cordis.yml`. Each task supplies its own interval and may raise its own idle threshold above the default.

```yaml
- name: '@deepseek-ai/dsh-evolution-heartbeat'
  config:
    tickMinutes: 10
    minIdleHours: 2
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; off starts no timer, runs no task, and touches no bookkeeping |
| `tickMinutes` | `15` | Minutes between host-wide due-checks |
| `minIdleHours` | `2` | Default minimum observed idle hours before a task may run |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-heartbeat) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One bookkeeping row per task in storage domain `evolution_heartbeat`, version `1`, layout `per-record`, table `tasks` keyed by task name. The row holds the last attempt instant and the last failure message; an absent row means the task was never attempted, which is what defers a freshly registered task by one interval. The engine holds registrations in memory only: a restart re-registers them from the mounting plugins, and the durable bookkeeping is what survives.

The clock and the idleness arrive as call arguments on `runDue`, while the mounted plugin adds the host-wide parts: a `session/event` listener keeping the newest activity instant, a fire-and-forget start-time due-check that never blocks plugin startup, and an `unref()`ed interval disposed through `ctx.effect`. Specs drive the schedule with fake timers, so the plugin carries no test-only clock seam.

### Task execution

Tasks run sequentially in registration order. Each attempt owns one `AbortController`, aborted at plugin teardown, so a long-running task observes disposal instead of outliving its plugin. Every attempt stamps the bookkeeping whether it succeeded or failed, so a permanently failing task is retried on its interval instead of on every tick; the failure message lands in `lastError` and one warning is logged. A rejection is contained: it is recorded and the pass continues with the next task.

### Disposal

Registering returns an idempotent asynchronous disposer that removes the task, aborts and awaits its active attempt, and preserves its bookkeeping row for later registration. Plugin teardown stops the timer, aborts active attempts, prevents remaining tasks in their current passes from starting, waits for active passes to settle, then closes the bookkeeping domain.

### Failure and recovery

Invalid bookkeeping fails the domain open loudly: a lost `lastRunAtMs` would rerun the first-attempt seeding and shift every task's schedule. Reads throw before the engine starts. A failing registration — a duplicate name, a name that is not path-safe, an interval below one hour, or a negative idle threshold — throws before anything is stored. A failing scheduled pass is caught and warned, leaving the timer and the bookkeeping intact for the next tick.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract behind the self-learning family.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-curator`](../evolution-curator/README.md) — the skill-lifecycle maintenance pass this engine's idle gating mirrors.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-heartbeat) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

None, as this scheduler registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected. A registered task that calls a model owns its own request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the engine is a poor fit. They are current package constraints.

- **Tasks run sequentially** — one pass awaits each task in registration order, and a task that never settles blocks every later task in that pass. A task that can run long must bound itself.
- **A task owns its own timeout** — the engine passes an abort signal at teardown but imposes no per-task deadline, so a hung task is only released by disposal.
- **Failures are retried on the interval** — a failed attempt stamps `lastRunAt`, so a broken task waits a full interval instead of backing off quickly.
- **Registrations are in-memory** — a restart drops every registration; the mounting plugin re-registers, and only the bookkeeping is durable.
- **The first run of a task is deferred** — a newly registered task is seeded and skipped, so its first real run is one interval away.
- **No task-level enable switch** — a task is on exactly while it is registered; `enabled: false` is the only global switch.
- **Machine-local only** — bookkeeping lives under `$DSH_HOME`, never inside the project directory.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The curator owns an equivalent idle gate and host-wide timer of its own. Migrating it onto this registry would leave one scheduling implementation instead of two, but it also changes shipped, tested curation behaviour, so the migration is deliberately not part of this package's introduction. No design owner yet.

</details>
