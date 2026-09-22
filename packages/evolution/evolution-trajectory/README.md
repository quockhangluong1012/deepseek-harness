---
description: "ShareGPT trajectory export of finished Sessions and Workspace scopes: per-turn conversations written under the harness home (ctx.evolutionTrajectory), for evals and outer-loop training."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-trajectory

English | [中文](README.zh.md)

## Summary

`dsh-evolution-trajectory` writes finished Sessions as ShareGPT conversation files for evals and reinforcement-learning data. One Session export writes one file holding one conversation per turn; a scope export writes one file per non-archived Session of a Workspace and reports the totals. Conversations keep the session log's own text and roles, while injected context, reasoning, and attachments stay out. Exports land under `$DSH_HOME` unless the composition or the call names another directory, and never inside the project. A Session with no admitted message exports an empty array instead of failing.

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

Mount the plugin and call `ctx.evolutionTrajectory.exportSession(sessionId)` for one Session, or `exportScope(scopeId)` for every non-archived Session of a Workspace scope. Both verbs report the written path, the conversation count, and the UTF-8 byte size; `exportScope` names the directory it filled and sums the totals of its files.

`toShareGpt({ sessionId, events })` is the pure shaper behind both verbs: pass a Session's committed events and receive one conversation per turn.

### When to choose it

Choose it when a finished Session should become training or evaluation data outside the harness. It is the export half of the outer loop; the scorer that measures a Session against fixtures belongs to its own package, and the trajectory viewer is a browser surface over the same logs. Reach for `ctx.sessionQuery` instead when the answer is a query rather than a file, and for the Web export when a human wants a ZIP download rather than a path.

### Configuration

`outDir` is a validated `Config` member changeable from `cordis.yml`. When it is unset, `$DSH_HOME` is read at export time and exports land in `$DSH_HOME/evolution-trajectories`.

```yaml
- name: '@deepseek-ai/dsh-evolution-trajectory'
  config:
    outDir: D:/trajectories
```

| Field | Default | Meaning |
|---|---|---|
| `outDir` | `$DSH_HOME/evolution-trajectories` | Directory used when an export call names no destination |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-trajectory) is the exhaustive source for every accepted field.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

Export reads a Session's committed events through a persistence read handle, after flushing that Session if it is still live, and shapes them with one pure function. Nothing is written until the conversations exist in memory, so a rejected read leaves no partial file, and a scope export writes each Session's file independently: one unreadable log is skipped with a warning instead of voiding the rest.

### The ShareGPT shape

Each exported file is a JSON array of conversations, one per turn that produced an admitted message. The conversation id is `<sessionId>#<turn>`, and messages carry the ShareGPT role vocabulary: `system/message` becomes `system`, a human `user/message` becomes `human`, an `assistant/message` becomes `gpt`, and a `tool/result` becomes `tool`. Assistant tool calls render as a `<tool_call>` tag holding the call name and the model's raw arguments JSON, so unparseable arguments survive verbatim. Admission is the reviewer's rule: only `user/message` events sourced from the human user pass, so injected context and empty renderings never become training data.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionTrajectoryExporter` service, export verbs, default directory, file writes |
| [`src/sharegpt.ts`](src/sharegpt.ts) | Pure shaping: event admission and conversation construction |
| [`src/types.ts`](src/types.ts) | Public ShareGPT, export-option, and result types |

### Failure and recovery

An unknown Session rejects with `session/not-found`, an unknown scope with `workspace/not-found`, and any other storage failure propagates unchanged. A scope whose roster names a Session with no stored log skips that Session with a warning. Exported files are plain artifacts: re-exporting overwrites the previous file, and deleting one loses nothing the harness holds elsewhere.

No invariant companion is published because the package holds no durable state: every export is a derived projection of the session log and the Workspace roster.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-trajectory) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

### Exported trajectory files

#### What the model sees

Nothing. An export reads the session log and writes a file under `$DSH_HOME`; it registers no prompt, tool, or schema, and no exported conversation re-enters a model request.

#### Token effect

Zero. An export runs outside any model turn and spends no tokens.

#### KV Cache effect

None. The files land on the host filesystem, so no request prefix changes and provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when an export is a poor fit. They are current package constraints.

- **Text only** — images and other attachments referenced by a message are not written; only text blocks reach a conversation.
- **Reasoning is dropped** — an assistant message contributes its text and tool calls, never its reasoning blocks.
- **The system prompt repeats** — every conversation starts with the system message its turn carried, because a conversation is one turn.
- **One conversation per turn** — a Session is never exported as a single long conversation, so a consumer that needs one needs to join the file itself.
- **The global scope has no roster** — `exportScope` needs a Workspace scope; the profile-wide scope holds no Session list to iterate.
- **Service only** — export is reachable through `ctx.evolutionTrajectory` and its Remote namespace; no slash command exists yet.
- **Overwrite, never append** — a second export replaces the file at the same path.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
