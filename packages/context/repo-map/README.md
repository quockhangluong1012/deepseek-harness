---
description: "Ranked, byte-bounded repository map injected into the model's request context: ranks the repository index against the session objective and injects the compact graph when it changes, for maintainers enabling, bounding, or debugging repository context."
kind: "package-reference"
---

# @deepseek-ai/dsh-repo-map

English | [中文](README.zh.md)

## Summary

`dsh-repo-map` gives the model a compact, ranked map of the workspace source tree: it ranks the repository index against the current task objective, keeps the best symbols and their best related symbols, and injects the rendered result as one durable, superseding snapshot whenever the map changes. `maxBytes`, `maxNodes`, and `maxEdgesPerNode` bound the text and the ranking. The map is a pure function of the index fingerprint and the objective, so a step whose objective and tree are unchanged injects nothing and stays behind a byte-identical request prefix.

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

Mount the plugin beside `dsh-repo-index` when the model should start each task already oriented in the source tree; it injects `repoIndex`, and each session's map is derived from that session's working directory.

```yaml
- name: '@deepseek-ai/dsh-repo-map'
  config:
    maxBytes: 4096
    maxNodes: 24
```

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | `4096` | Exclusive UTF-8 byte bound on the complete rendered map text |
| `maxNodes` | `24` | Maximum ranked symbols the map lists |
| `maxEdgesPerNode` | `4` | Maximum related symbols the map lists beneath one symbol |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repo-map) is the exhaustive source for every accepted field and its source declaration.

### What the model gets

On each eligible step the plugin renders the map and appends it as a durable user-role message; the objective supplying the ranking terms is the newest user-authored text the step sees, including the messages the step just claimed. An unchanged map injects nothing, so the model keeps reading the previous snapshot. A session with no working directory, or an index with no symbols, injects nothing at all.

### Choosing when to mount it

Mount it when a session works inside one workspace root and the model benefits from knowing which files and symbols matter for the current task. Skip it when the objective changes rarely and the tree is small enough for the model to read directly, or when a different context source already carries the same facts. The map's own consumers are the model and the context compiler; it defines no tool and no command.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **Injection by change, not by step.** The listener renders the map, compares it with the session's previous map text, and appends a message only when the text differs, so unchanged steps keep the request prefix intact.
- **Ranking is a fixed weighted score.** Objective terms score exact and word matches on the symbol name, word matches on the declaring path, reference degree below a ceiling, and the declaration kind; ties break on identifier, path, and line, so the same index and objective always yield the same map.
- **One render serves both consumers.** The pre-step listener stores the text it rendered in a `WeakMap` keyed by the session, and the optional compiler registration reads it instead of walking the tree a second time.
- **Bounds apply to the complete text.** The renderer keeps whole lines only, so a truncated map is always a prefix of the complete one and never exceeds `maxBytes`.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config validation, the pre-step listener, and the optional compiler registration |
| [`src/rank.ts`](src/rank.ts) | Objective terms, the weighted score, and the deterministic rank order |
| [`src/render.ts`](src/render.ts) | The map text and its byte-bounded line truncation |
| [`src/types.ts`](src/types.ts) | The ranked node, selection bounds, and header counts |

### Main flow

The `agent/pre-step` listener delegates to the next listener first, returns the decision unchanged on rejection or an aborted signal, then resolves the session's working directory, asks `ctx.repoIndex.ensure()` for the snapshot, and returns the decision untouched when the snapshot has no symbols. Otherwise it ranks the snapshot against the objective and renders the map; a text equal to the session's previous one leaves the decision untouched, and a changed text is stored and appended as a user message with a `repo-map` snapshot source that supersedes the previous one.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-repo-index`](../../repo/repo-index/README.md) — the snapshot, symbols, and references this map ranks.
- [Agent-context subsystem](../../../docs/subsystems/agent-context.md) — the source envelope, placement, and durable record the optional compiler registration follows.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-repo-map) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Durable repository map snapshot

#### What the model sees

The map reaches the model as one appended user-role message whose text is the rendered map. The first line is the header below, verbatim, and beneath it comes one line per ranked symbol plus one indented line per related symbol, in the form `- <name> [<kind>] <path>:<line>` and `  -> <name> [<kind>] <path>:<line>`, best first. The message carries the source `{ kind: 'repo-map', form: 'snapshot', sections: [{ name: 'repo-map', text }], supersedes: true }`, so it replaces the previous map as the session's live snapshot.

##### Map header

```markdown
Repository map (ranked by relevance to the current task; <symbols> indexed symbols from <indexed> files, most relevant first):
```

#### Token effect

Conditional and bounded: an unchanged map, a session without a working directory, and an index without symbols each inject nothing, and a truncated map keeps whole lines only, so one injection never exceeds `maxBytes` bytes (4096 by default).

#### KV Cache effect

Prefix-stable: an unchanged map appends no message, so the request prefix stays byte-identical and existing KV Cache entries stay reusable; a changed map appends after that prefix rather than rewriting it.

### Stable-core repository map artifact

#### What the model sees

When `dsh-agent-context` is mounted, the plugin also registers one source with producer `repo-map`, kind `artifact`, trust `untrusted`, placement `stable-core`, and the same `maxBytes` bound; a compile that asks for that source receives the identical map text as the single item `{ id: 'map', text, relevance: 1 }`, taken from the text the pre-step listener last rendered or rendered on demand.

#### Token effect

Conditional and bounded: the source contributes that one item when a compile requests it and contributes nothing when the session has no working directory, the index has no symbols, or the rendered text is empty.

#### KV Cache effect

Independent of the durable message: the source republishes the same text while the index fingerprint and the objective are unchanged, and the plugin refreshes the text it serves only after the pre-step listener renders a changed map.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the map is a poor fit. They are current package constraints.

- **Ranking is lexical** — the objective supplies lowercased word terms of at least three characters, so a synonym or abbreviation that appears only in the task text and not in the identifier or path scores nothing.
- **One newest user text supplies the objective** — a task whose description is spread across several user messages ranks by the newest one alone, plus the messages the step claimed.
- **Only the index's facts are rankable** — the map inherits the line-oriented extraction of `dsh-repo-index`, so a symbol or reference the index did not recognize cannot appear here.
- **Bytes, not tokens** — `maxBytes` truncates in UTF-8 bytes by whole lines, so the token cost varies with identifier and path length while the header keeps stating full index totals.
- **Truncation is silent** — the model is not told which ranked symbols or related symbols the byte bound cut, only how many the index holds in total.
- **No working directory, no map** — a session whose header carries no `cwd` receives nothing, however large the index.
- **A stale map is never re-injected** — an objective that stops changing leaves the last snapshot in place, so a much later step still sees the map as it was at the last change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pre-step listener delegates before it computes anything, so a rejecting listener still short-circuits the step and an aborted signal costs no walk. The `WeakMap` entry is deleted when a session renders nothing, so a session that loses its working directory stops republishing the previous text.

The ranking reads the objective from `session.deriveMessages()` plus the messages the step claimed because claimed messages are not on the surface yet; that is why the step that opens a task ranks by the task it just claimed rather than by the previous turn's objective.

</details>
