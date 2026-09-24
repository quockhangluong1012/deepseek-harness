---
description: "Evolution memory brief injector with condition-driven nudges (agent pre-step), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-memory-context

English | [中文](README.zh.md)

## Summary

`dsh-evolution-memory-context` gives every Session in a scope one durable `user/message` brief built from that scope's instructions, lessons, profile, and attached context, spliced into `agent/pre-step` — replacing the brief when the record changes and adding nothing when it does not. The brief declares `supersedes`, so the model reads the live one while the log keeps every injected brief, and capacity usage stays in the brief header, so a memory write never invalidates the request's cached prefix. Choose it when a scope's Sessions should share knowledge without re-reading storage each turn. `maxBytes` is required and caps the whole brief.

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

Mount the plugin with the memory store and a workspace registry. Scopes resolve per turn from workspace membership (registry session ids, falling back to a canonical-path `cwd` match) under the required `profile`; turns outside any scope add nothing.

When `@deepseek-ai/dsh-agent-context` is mounted, this package also registers the exact rendered brief as an untrusted, required memory source. Without it, brief injection is unchanged.

### Configuration

`maxBytes` and `profile` are required: the deployment must choose what a brief may cost and which scope namespace it serves. The nudge cadence and the two condition thresholds are optional and default to the shipped values.

```yaml
- name: '@deepseek-ai/dsh-evolution-memory-context'
  config:
    maxBytes: 16384
    profile: default
```

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | required | Cap on the complete emitted text including the frame |
| `profile` | required | Scope-identity namespace placed before the workspace key |
| `memoryNudgeInterval` | `1` | Ceiling on memory-condition nudges: a condition that fired stays quiet this many turns |
| `skillNudgeInterval` | `10` | Ceiling on skill-condition nudges: a condition that fired stays quiet this many turns |
| `stagedWriteWaitMinutes` | `1440` | Minutes a staged write may wait before the memory nudge names it |
| `failureSignalScanLimit` | `20` | Failure signals one nudge evaluation grades |
| `capacityWarnPct` | `0.8` | Usage ratio at or above which the brief header warns to consolidate |

`memoryNudgeInterval` and `skillNudgeInterval` used to be the trigger — a nudge rendered on every turn that was a multiple of them. They are now the cadence ceiling over the recorded conditions (`conditions.ts`), which is the §53 upgrade: a nudge fires when evidence holds and stays silent while none does, and the interval only limits how often a standing condition repeats. A host that sets them keeps its numbers and gets the new meaning.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-memory-context) is the exhaustive source for every accepted field.

### Budget and digest
Empty sections are omitted and an all-empty record injects nothing. Under pressure trailing context items drop first, then the weakest lesson artifacts drop whole — strongest first by confidence, ties broken by ascending id, and a lesson is never truncated mid-statement — then the profile truncates with lessons already gone, then instructions truncate last; one notice line names every drop and truncation, and file bytes are re-read at injection time while the recorded size stays a snapshot. The digest covers instructions, lessons, profile, and context only, so output indexing and staged writes never re-inject the brief. Once usage reaches `capacityWarnPct` the header carries a near-capacity warning telling the model to consolidate instead of adding, ahead of the store's hard reject at full capacity.

Recalled context material — items labelled with the store's `RECALL_LABEL_PREFIX` — renders after every item the user attached, because the renderer drops trailing context first and recalled material outranks nothing the user attached.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The injector compares the record digest against the newest visible `evolution-memory` brief: an in-memory per-session mark first, then the claimed batch, then the logged surface through the asynchronous session query seam. Membership resolves the same way and is cached per session id, invalidated on `session/disposed`. A per-session counter of observed `turn/start` events supplies the turn number the nudge cadence measures, and the turn each condition last fired on is remembered per session and condition; both clear with the same lifecycle. Nothing scans session history synchronously, so resumed sessions contribute their observed suffix and restarts re-resolve through the query seam instead of duplicating the brief.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: pre-step injector, membership cache, file materialization, store reads and section wiring |
| [`src/render.ts`](src/render.ts) | Pure brief rendering within the byte budget |
| [`src/sections.ts`](src/sections.ts) | Nudge section registrations, the skill-tool gate, and the cadence predicate |
| [`src/conditions.ts`](src/conditions.ts) | The recorded conditions, their store-backed evaluators, and their line builders |

### Failure and recovery

Missing or unreadable files degrade to a one-line `Context "<label>" is unavailable (<path>).` notice and the step proceeds. A failing surface read degrades to injecting rather than blocking the turn. Malformed `profile` values, non-positive or fractional nudge intervals, a fractional or zero `failureSignalScanLimit`, and a negative `stagedWriteWaitMinutes` fail plugin load loudly. An unmounted evolution store leaves its own condition unevaluable rather than silently satisfied or silently absent, and the line it renders names the store. The listener observes the final claimed batch and spreads the downstream decision, preserving `startsRequestSeries`.

No invariant companion is published because the injector owns no durable state of its own: the brief is derived from the store record at each pre-step, and the domain table behind the store is the only durable copy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract this package implements.
- [Context group map](../README.md) — sibling request-context packages; the package lives in the `context/` group beside its workspace counterpart.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-memory-context) — every accepted config field.

-----

### Recorded conditions

| Condition | Evidence it reads | Line when it holds |
|---|---|---|
| `staged-writes` | `ctx.evolutionMemory.read(scope).staged` — the scope's pending writes, oldest first | a pending write older than `stagedWriteWaitMinutes`; `run /memory pending` |
| `contradicted-claims` | `ctx.evolutionGraph.claims(scope)` — active claims, best-supported first | active claims carrying contradicting evidence; `run /claims` |
| `skill-trust` | `ctx.evolutionSkillTelemetry.entries()` — one record per tracked skill | skills standing at provisional trust after a recorded demotion; `run /curator status` |
| `failure-signals` | `ctx.evolutionFeedback.signals(workspace session ids, failureSignalScanLimit)` | signals the store itself graded `trigger_review`; record the durable lesson with `skill_manage` |
| `holdout-gaps` | `ctx.evolutionBenchmark.tasks()` — every task with its state | capabilities under evaluation with no holdout task; `run /benchmark` |

`memoryNudgeInterval` and `skillNudgeInterval` are the cadence ceiling, not the trigger: a condition that fired stays quiet until that many further turns have been observed, and the turn a condition fired on is remembered per session and condition, so assemblies within one turn agree. A condition whose store is not mounted is unevaluable rather than satisfied or silently absent, and its line names the store (`<subject> cannot be checked: the <store> store is not mounted.`). A session outside every workspace has no scope, so the two scope-bound conditions stay quiet there while the global ones still render.

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

One durable `user/message` carrying the framed brief: the scope title, directory, and `Memory usage: used/cap (pct%)` header, then the `Instructions`, `Lessons`, `User profile`, and per-item `Context: label` sections that are non-empty, plus one budget notice line when anything was dropped or truncated. The `Lessons` section renders one line per stored artifact — `- <statement> (confidence: 0.82)`, or `- (untrusted, from <source>) > <statement> (confidence: 0.82)` for a fact derived from content nobody vouched for, which reaches the model as quoted data labelled with its source rather than as a directive — strongest first: confidence descending, ties broken by ascending `id` so the same record always renders the same order. Under budget pressure the weakest artifacts drop whole, and when not even one fits the section is omitted entirely rather than sending a truncated statement.

##### Verbatim text for this field, when needed

```markdown
<system-reminder>
```

#### Token effect

Capped: at most one brief per digest change, bounded by `maxBytes` including the frame; an unchanged record adds zero tokens.

#### KV Cache effect

Prefix-stable while the record is unchanged: the brief is appended after the claimed batch, so a repeated identical brief preserves the reusable prefix; a changed record replaces it and invalidates reuse from that point on.

### Prompt sections

#### What the model sees

Three nudge sections: `evolution-memory-scope`, `evolution-lessons-skills`, `evolution-session-search`. The first two carry §53's recorded conditions instead of fixed advice: each line names the condition that fired, its count, and the surface that acts on it, and a section renders nothing while none of its conditions holds. The skill section renders only beside a visible `skill_manage` tool, because one of its lines tells the model to record a lesson with that tool.

##### Verbatim text for this field, when needed

```markdown
To recall earlier work in this scope, search past sessions before asking the user to repeat context.
```

#### Token effect

Bounded by the cadence ceiling: at most one line per condition per `memoryNudgeInterval` / `skillNudgeInterval` turns, plus the session-search hint on every assembly. Each line is one sentence naming a count, the condition, and the surface that acts on it — the fired conditions are listed in the table above and none of them quotes memory text.

#### KV Cache effect

Stable while the conditions' status does not change: the lines carry counts, instants, and store identities, so a memory write alone leaves this tier byte-identical, and a condition that neither starts nor stops holding leaves it byte-identical too. A condition starting or ceasing to hold changes the tier from that point on, which is the intended cost of a nudge that says something. Capacity usage is reported exclusively in the brief's header (see above), which already rides its own digest-gated replacement.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the injector is a poor fit. They are current package constraints.

- **One brief at a time on the surface, every brief in the log** — a changed record commits a complete replacement, the loop supersedes the scope's previous brief on the surface, and the superseded brief stays a durable log record that a transcript and a replay still show. A session that accumulated duplicates before the brief declared `supersedes` keeps them until compaction shadows them; new turns never add another.
- **File context re-read per refresh** — the budget bounds model bytes, not disk reads.
- **File capacity snapshot** — the recorded size is not refreshed when the file changes on disk.
- **No per-session file reader** — file items resolve against the process filesystem, not a workspace-scoped reader.
- **Nudges say nothing while the stores report nothing** — the always-on lessons-to-skills advice is gone by design: with no failure signal, no demoted skill, and no holdout gap, the skill section stays empty, and the memory section stays empty while no staged write has waited and no claim is contradicted. A deployment that wants the old standing advice back must keep that text in its own section.
- **An unmounted store costs a prompt line** — the notice naming the missing store repeats on the cadence ceiling until the store is mounted, so a deployment that reads `evolution-memory` alone sees four such lines per interval in place of the conditions it cannot evaluate.
- **Scope-bound conditions need a workspace** — a session in no registered workspace has no scope, so staged writes and contradicted claims are never reported to it even when the scope holds them.
- **Nudge cadence counts process-observed turns** — the turn counters start at plugin load and clear on session disposal, so turns before load or before a host restart are not replayed, a resumed session begins again from its first observed `turn/start`, and the first turn after a restart can repeat a condition the previous process already reported.
- **Condition evidence is read at assembly time** — a store write between two assemblies of one turn can change the section text for the second, and every read is synchronous: a store that only answers asynchronously (none of the five today) could not be a condition.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
