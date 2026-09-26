---
description: "Per-task working set injected into the model's request context: the primary files the current objective names plus their dependencies, tests, configuration, and documentation, refreshed only when the selection changes, for maintainers enabling, bounding, or debugging task-scoped file context."
kind: "package-reference"
---

# @deepseek-ai/dsh-working-set

English | [中文](README.zh.md)

## Summary

`dsh-working-set` turns one task into the files it touches: it ranks the repository index against the current objective, keeps the files whose symbols the objective names, adds the files they import and their tests, configuration, and documentation, and injects the result as a durable snapshot that supersedes the previous one. `maxBytes` and five per-role file caps bound it. The selection is a pure function of the index fingerprint and the objective, so an unchanged selection injects nothing and the request prefix stays byte-identical.

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

Mount the plugin beside `dsh-repo-index` and `dsh-repo-map` when the model should start each task knowing which files matter; it injects `repoIndex`, and each session's selection is derived from that session's working directory and its current objective.

```yaml
- name: '@deepseek-ai/dsh-working-set'
  config:
    maxBytes: 3072
    maxPrimaryFiles: 8
```

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | `3072` | Exclusive UTF-8 byte bound on the complete rendered selection text |
| `maxPrimaryFiles` | `8` | Maximum files declaring a symbol the objective names |
| `maxDependencyFiles` | `8` | Maximum files those files import |
| `maxTestFiles` | `6` | Maximum test files whose name shares a word with a selected file |
| `maxConfigFiles` | `4` | Maximum configuration files in the selected files' ancestor directories |
| `maxDocs` | `3` | Maximum documentation files in the selected files' ancestor directories |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-working-set) is the exhaustive source for every accepted field and its source declaration.

### What the model gets

On each eligible step the plugin renders the selection and appends it as a durable user-role message; the objective supplying the search terms is the newest user-authored text the step sees, including the messages the step just claimed. An unchanged selection injects nothing, so the model keeps reading the previous snapshot. A session with no working directory, an index with no symbols, or a task no indexed symbol names injects nothing at all.

### Choosing when to mount it

Mount it when a session works inside one workspace root and the model benefits from starting at the right files instead of searching the tree. Skip it when the objective changes rarely and the tree is small enough for the model to read directly, or when `dsh-repo-map` alone already orients it. The selection's own consumers are the model and the context compiler; it defines no tool and no command, and it never restricts what the model may read or edit.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

- **The objective is the admission rule.** A file enters the selection only when a symbol it declares names an objective term, so a task the index cannot match selects nothing rather than everything.
- **Ranking is the repository map's.** The primary files are the repository map's ranking (`rankRepositoryMap`) filtered to the symbols the objective names, so both views agree on which symbols matter and in what order.
- **Every other role is derived, never guessed.** Dependencies come from the index's resolved import edges, test files from the index's own test edges, configuration and documentation from the selected files' ancestor directories — all pure functions of the snapshot.
- **One render serves both consumers.** The pre-step listener stores the text it rendered in a `WeakMap` keyed by the session, and the compiler registration reads it instead of selecting a second time.
- **Injection by change, not by step.** A text equal to the session's previous one appends no message, so an index fingerprint that moved without changing the selection costs nothing, and a step that already claims this exact snapshot — a retry, or a session resumed from the log by a fresh process — emits nothing either.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config validation, the pre-step listener, and the compiler registration |
| [`src/select.ts`](src/select.ts) | Objective terms, the primary ranking, and the dependency, test, config, and doc roles |
| [`src/render.ts`](src/render.ts) | The selection text and its byte-bounded line truncation |
| [`src/types.ts`](src/types.ts) | The per-role file lists and the selection bounds |

### Main flow

The `agent/pre-step` listener delegates to the next listener first, returns the decision unchanged on rejection or an aborted signal, then resolves the session's working directory, asks `ctx.repoIndex.ensure()` for the snapshot, and selects against the objective. A selection with no file leaves the decision untouched; a selection equal to the session's previous one also leaves it untouched; a changed selection is stored and appended as a user message with a `working-set` snapshot source that supersedes the previous one.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-repo-index`](../../repo/repo-index/README.md) — the tree, symbols, resolved imports, and test edges this selection reads.
- [`dsh-repo-map`](../repo-map/README.md) — the ranking this selection reuses and the sibling view injected beside it.
- [Agent-context subsystem](../../../docs/subsystems/agent-context.md) — the source envelope, placement, and durable record the compiler registration follows.
- [Context group map](../README.md) — sibling request-context packages.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-working-set) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Durable working-set snapshot

#### What the model sees

The selection reaches the model as one appended user-role message whose text is the rendered selection. The first line is the header below with the file count filled in, and beneath it comes one block per non-empty role, labelled `primary (<count>):` and so on in role order, with one `- <path>` line per file. The message carries the source `{ kind: 'working-set', form: 'snapshot', sections: [{ name: 'working-set', text }], supersedes: true }`, so it replaces the previous selection as the session's live snapshot.

##### Selection header

```markdown
Working set (<total> files the current task is expected to touch, ranked against its objective):
```

#### Token effect

Conditional and bounded: a session without a working directory, an index without symbols, and a task no indexed symbol names each inject nothing, and a truncated selection keeps whole lines only, so one injection never exceeds `maxBytes` bytes (3072 by default).

#### KV Cache effect

Prefix-stable: an unchanged selection appends no message, so the request prefix stays byte-identical and existing KV Cache entries stay reusable; a changed selection appends after that prefix rather than rewriting it.

### Stable-core working-set artifact

#### What the model sees

When `dsh-agent-context` is mounted, the plugin also registers one source with producer `working-set`, kind `artifact`, trust `untrusted`, placement `stable-core`, and the same `maxBytes` bound; a compile that asks for that source receives the identical selection text as the single item `{ id: 'set', text, relevance: 1 }`, taken from the text the pre-step listener last rendered or selected on demand.

#### Token effect

Conditional and bounded: the source contributes that one item when a compile requests it and contributes nothing when the session has no working directory, the index has no symbols, or the selection is empty.

#### KV Cache effect

Independent of the durable message: the source republishes the same text while the index fingerprint and the objective are unchanged, and the plugin refreshes the text it serves only after the pre-step listener renders a changed selection.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the selection is a poor fit. They are current package constraints.

- **Admission is lexical** — a file enters the selection only through an objective term matched against a symbol name or path, so a synonym, abbreviation, or task description that never names the identifier selects nothing for that file.
- **One newest user text supplies the objective** — a task whose description is spread across several user messages selects by the newest one alone, plus the messages the step claimed.
- **Only the index's facts are selectable** — the selection inherits the line-oriented extraction of `dsh-repo-index`, so a symbol or import the index did not recognize cannot place a file here.
- **Dependencies are one import level deep** — a file two imports away from a primary file is not selected, and a dependency reached only through a dynamic import is invisible.
- **Tests come from the index's edges** — a test file is listed when the index related it to a selected file, by a resolved import or by the path convention, so a test that reaches its subject only dynamically, or through a differently named file, is not listed.
- **Configuration names are fixed** — only `package.json`, `tsconfig*.json`, and `*.config.<js|ts>` count as configuration, so a differently named configuration file is invisible.
- **Documentation comes from ancestor directories** — a document elsewhere in the repository that describes a selected file is not listed, and a translated `.zh.md` mirror is dropped when its English sibling exists.
- **The selection is context, not a contract** — nothing enforces the listed files as the only ones the model may read or write; the change contract that does is a separate capability.
- **Bytes, not tokens** — `maxBytes` truncates in UTF-8 bytes by whole lines, so the token cost varies with path length while the header keeps stating the full file count.
- **Truncation is silent** — the model is not told which files the byte bound cut, only how many were selected in total.
- **No working directory, no selection** — a session whose header carries no `cwd` receives nothing, however large the index.
- **A stale selection is never re-injected** — an objective that stops changing leaves the last snapshot in place, so a much later step still sees the selection as it was at the last change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The pre-step listener delegates before it computes anything, so a rejecting listener still short-circuits the step and an aborted signal costs no walk. The `WeakMap` entry is deleted when a session selects nothing, so a session that loses its working directory stops republishing the previous text.

The selection reads the objective from `session.deriveMessages()` plus the messages the step claimed because claimed messages are not on the surface yet; that is why the step that opens a task selects by the task it just claimed rather than by the previous turn's objective.

`renderWorkingSet` returns the empty string for a selection with no file, which is what keeps a task the index cannot match from spending a model-visible message on a header alone.

</details>
