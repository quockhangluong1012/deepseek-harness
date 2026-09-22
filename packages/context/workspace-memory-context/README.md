---
description: "Workspace memory brief injector rendering Instructions, Memory, and Context into agent pre-step."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-memory-context

English | [中文](README.zh.md)

## Summary

`dsh-workspace-memory-context` injects one durable `user/message` carrying the Workspace brief: the Workspace title and directory, user-authored instructions, the model-maintained memory document, and attached context items. It emits nothing for Sessions outside any Workspace and nothing when Instructions, Memory, and Context are all empty. Choose it when every Session in a directory should inherit shared knowledge.

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

Mount the plugin beside the store. The deployment must choose what a Workspace may cost per request.

```yaml
- name: '@deepseek-ai/dsh-workspace-memory'
  config:
    capacityBytes: 131072
- name: '@deepseek-ai/dsh-workspace-memory-context'
  config:
    maxBytes: 16384
```

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | required | Cap on the complete injected brief including the frame |

At each eligible pre-step the injector compares the record's digest against the newest visible `workspace-memory` message, scanning the claimed batch first and then the Session surface in reverse. Equal digest adds nothing; a different or absent digest appends exactly one complete fresh brief. The message carries source `{ kind: 'workspace-memory', form: 'instructions', workspaceId, digest }`, so replay and deduplication are exact.

### Budget and safety

The complete emitted text including the frame never exceeds `maxBytes`. Under pressure trailing Context items drop first, then Memory truncates, then Instructions truncate last, with one notice line naming what was dropped or truncated. Every workspace-authored string rewrites literal `</system-reminder>` to `<\/system-reminder>`. A missing or unreadable file item renders as `Context "<label>" is unavailable (<path>).` and the step proceeds.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The brief is one durable `user/message` appended from an `agent/pre-step` contribution, so it is replayable, compactable, and reconstructable from the session log. No new session event type is introduced.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: membership resolution, digest comparison, file materialization, pre-step listener |
| [`src/render.ts`](src/render.ts) | Pure brief rendering, budget drop order, frame escaping, UTF-8 truncation |

No invariant companion is published because the plugin owns no durable state to check against a second observation.

### Membership

Membership resolves from the Workspace records' `sessionIds`, falling back to a canonical-path match on the Session's `cwd`. The resolution is cached per Session id and invalidated on `session/disposed`. A Session outside any Workspace gets nothing. The listener is not prepended, so it observes the final claimed batch, and it spreads the decision so `startsRequestSeries` survives.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace Memory subsystem](../../../docs/subsystems/workspace-memory.md) — the behaviour contract this package implements.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-workspace-memory-context) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Workspace memory brief

#### What the model sees

One `<system-reminder>`-framed message per Session, replaced on change. Empty sections are omitted; when Instructions, Memory, and Context are all empty, no message is emitted.

##### Verbatim brief frame

```markdown
<system-reminder>
# Workspace memory: <workspace title>
Directory: <canonical path>

## Instructions
<instructions>

## Memory
<memory>

## Context: <label>
<materialized content>
</system-reminder>
```

#### Token effect

One brief per Session, replaced on change with a complete fresh message. An unchanged record adds no second message.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix. A replacement brief changes later request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the brief is a poor fit. They are current package constraints.

- **Web only** — Workspaces exist only in the web composition, so other profiles never carry a brief.
- **One brief at a time** — a change appends a complete new message rather than a diff, so many edits accumulate superseded briefs.
- **File context is read per request** — a large attached file is re-read on every brief refresh; the budget bounds what reaches the model, not what is read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
