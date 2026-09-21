---
description: "Evolution memory brief injector with scope nudges (agent pre-step), for hosts composing the self-learning harness."
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

### Configuration

`maxBytes` and `profile` are required: the deployment must choose what a brief may cost and which scope namespace it serves. The two nudge intervals are optional and default to the shipped cadence.

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
| `memoryNudgeInterval` | `1` | Turns between scope-narrowing nudges |
| `skillNudgeInterval` | `10` | Turns between lessons-to-skills nudges |
| `capacityWarnPct` | `0.8` | Usage ratio at or above which the brief header warns to consolidate |

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

The injector compares the record digest against the newest visible `evolution-memory` brief: an in-memory per-session mark first, then the claimed batch, then the logged surface through the asynchronous session query seam. Membership resolves the same way and is cached per session id, invalidated on `session/disposed`. A per-session counter of observed `turn/start` events gates the nudge cadence and clears with the same lifecycle. Nothing scans session history synchronously, so resumed sessions contribute their observed suffix and restarts re-resolve through the query seam instead of duplicating the brief.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: pre-step injector, membership cache, file materialization, section wiring |
| [`src/render.ts`](src/render.ts) | Pure brief rendering within the byte budget |
| [`src/sections.ts`](src/sections.ts) | Nudge section texts (static — no interpolated value), skill-tool visibility, turn-interval predicate |

### Failure and recovery

Missing or unreadable files degrade to a one-line `Context "<label>" is unavailable (<path>).` notice and the step proceeds. A failing surface read degrades to injecting rather than blocking the turn. Malformed `profile` values and non-positive or fractional nudge intervals fail plugin load loudly. The listener observes the final claimed batch and spreads the downstream decision, preserving `startsRequestSeries`.

No invariant companion is published because the injector owns no durable state of its own: the brief is derived from the store record at each pre-step, and the domain table behind the store is the only durable copy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-spec-v10-complete.md) — the behaviour contract this package implements.
- [Context group map](../README.md) — sibling request-context packages; the package lives in the `context/` group beside its workspace counterpart.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-memory-context) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Request context and condition

#### What the model sees

One durable `user/message` carrying the framed brief: the scope title, directory, and `Memory usage: used/cap (pct%)` header, then the `Instructions`, `Lessons`, `User profile`, and per-item `Context: label` sections that are non-empty, plus one budget notice line when anything was dropped or truncated. The `Lessons` section renders one line per stored artifact — `- <statement> (confidence: 0.82)` — strongest first: confidence descending, ties broken by ascending `id` so the same record always renders the same order. Under budget pressure the weakest artifacts drop whole, and when not even one fits the section is omitted entirely rather than sending a truncated statement.

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

Three nudge sections: `evolution-lessons-skills`, `evolution-memory-scope`, `evolution-session-search` — all fixed text, no interpolated value. The skills nudge renders only beside a visible `skill_manage` tool and only on turns that are a multiple of `skillNudgeInterval`; the scope nudge renders only on turns that are a multiple of `memoryNudgeInterval`; the session-search hint always renders. A session with no observed turn yet counts as its first turn, so the interval-`1` scope nudge renders before it while wider intervals wait for their multiple.

##### Verbatim text for this field, when needed

```markdown
To recall earlier work in this scope, search past sessions before asking the user to repeat context.
```

#### Token effect

Bounded by cadence: the session-search hint on every assembly, the scope nudge every `memoryNudgeInterval` turns, the skills nudge every `skillNudgeInterval` turns while `skill_manage` is visible.

#### KV Cache effect

Prefix-stable regardless of memory content: section text is fixed and carries no per-scope value, so the nudge set changes only on an interval turn, never on a memory write. Capacity usage is reported exclusively in the brief's header (see above), which already rides its own digest-gated replacement — a memory write cannot invalidate this tier's cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the injector is a poor fit. They are current package constraints.

- **One brief at a time on the surface, every brief in the log** — a changed record commits a complete replacement, the loop supersedes the scope's previous brief on the surface, and the superseded brief stays a durable log record that a transcript and a replay still show. A session that accumulated duplicates before the brief declared `supersedes` keeps them until compaction shadows them; new turns never add another.
- **File context re-read per refresh** — the budget bounds model bytes, not disk reads.
- **File capacity snapshot** — the recorded size is not refreshed when the file changes on disk.
- **No per-session file reader** — file items resolve against the process filesystem, not a workspace-scoped reader.
- **Nudge cadence counts process-observed turns** — the interval counters start at plugin load and clear on session disposal, so turns before load or before a host restart are not replayed and a resumed session begins again from its first observed `turn/start`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
