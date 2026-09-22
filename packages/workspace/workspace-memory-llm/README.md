---
description: "Workspace memory derivation: per-turn output indexing, gated extraction, and on-demand rebuild (ctx.workspaceMemoryExtractor)."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-memory-llm

English | [中文](README.zh.md)

## Summary

`dsh-workspace-memory-llm` derives the model-maintained memory document. Every completed turn indexes produced files; gated turns rewrite the whole document from the turn transcript; the page's regenerate control rebuilds from chat history. Extraction is deterministic (`temperature: 0`, reasoning disabled through `purpose: 'workspace-memory'`) and never surfaces as a Session error.

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

Mount the plugin beside the store. Output indexing always runs; `autoExtract: false` pays only for the regenerate control.

```yaml
- name: '@deepseek-ai/dsh-workspace-memory-llm'
  config:
    autoExtract: true
```

| Field | Default | Meaning |
|---|---|---|
| `autoExtract` | `true` | Whether a completed turn triggers extraction; output indexing always runs |
| `minTurnTextBytes` | `200` | Skip extraction for trivial turns |
| `cooldownMs` | `60000` | Minimum gap between two extractions for one Workspace |
| `maxInputBytes` | `131072` | Transcript budget per call |
| `maxOutputTokens` | `1024` | Output cap |
| `timeoutMs` | `60000` | Call deadline |
| `rebuildSessionLimit` | `20` | Sessions scanned by a rebuild |
| `outputTools` | `write`, `edit`, `str_replace_editor` | Which successful calls count as productions |
| `provider` / `model` | unset | Route override; both or neither, one alone fails plugin load |

The transcript admits only human `user/message`s and `assistant/message`s. Route precedence is the configured pair, else the Session's last logged `request/header` route. A rebuild with no route rejects with `workspace-memory/extraction-failed`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

No invariant companion is published because derivation holds no durable state beyond the store it writes.

### Design concept

One backward scan of the live Session's events to the most recent `turn/start` feeds output indexing and extraction. Work is enqueued on a per-`WorkspaceId` promise chain, so one Workspace never runs two extractions at once and a turn is never blocked. Teardown aborts every in-flight extraction; `session/disposed` aborts the one bound to that Session.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: turn listener, output indexing, gated extraction, rebuild |
| [`src/prompt.ts`](src/prompt.ts) | System prompt, JSON framing, UTF-8 truncation helpers |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace Memory subsystem](../../../docs/subsystems/workspace-memory.md) — the behaviour contract this package implements.
- [Workspace package map](../README.md) — the group's packages and their repository position.

-----

<a id="model-experience"></a>
## Model Experience

### Memory extraction call

#### What the model sees

A deterministic derivation request with JSON-framed `{ role, text }` rows and the current document. The model returns only the replacement document under `## Purpose`, `## Preferences`, `## Decisions`, `## References`.

#### Token effect

Capped by `maxInputBytes` in and `maxOutputTokens` out. `max-tokens` finish is tolerated and sets `truncated: true`.

#### KV Cache effect

Independent of live requests: the auxiliary call runs outside the conversation request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when derivation is a poor fit. They are current package constraints.

- **Extraction needs a route** — a Session that never issued a model request has no route to reuse, so its turns produce no memory unless the row names a provider and model.
- **Memory is one document** — there is no per-entry provenance, per-entry deletion, or memory history.
- **Outputs are tool-derived** — a file written by a shell command, or by a tool outside the configured set, is not indexed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
