---
description: "Library helper that creates, attaches, titles, and starts one root Session in a Workspace, shared by the producers that publish Workspace-backed Sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-session

English | [中文](README.zh.md)

## Summary

`dsh-workspace-session` exposes one function that turns a producer's decision — this workspace, this title, this composition, this first message — into a live root Session: it resolves the presets, creates the Workspace, creates the Agent, attaches the Session, applies the permission preset, titles it, and admits the message, rolling all of that back if any step fails. Webhook rules and scheduled routines both call it, so the ordering and rollback rules live in one place. It registers no tool, prompt, or session event of its own.

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

Call `startWorkspaceSession` from a plugin that publishes an unattended Session — a webhook rule, a scheduled routine, or a new producer of the same kind. It is a library, not a mounted plugin: it owns no service and needs no `cordis.yml` row.

```ts
await startWorkspaceSession(ctx, {
  workspacePath: '/srv/projects/app',
  sessionId: brandString<SessionId>(`routine-${randomUUID()}`),
  title: 'Nightly sweep',
  agentPreset: 'standard',
  permissionPreset: 'workspace-write',
  modelSelection: { provider: 'deepseek', model: 'deepseek-chat' },
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  owner: 'schedule-routines',
}, createUserMessage({ content: [{ type: 'text', text: 'Sweep the tree.' }], source: { kind: 'routine', /* … */ } }), signal)
```

The call is complete when the message is admitted. Ownership then ends: the Agent is lifecycle-owned by the context it was created on, and the caller arranges nothing further.

### What the caller must supply

| Input | Why the caller owns it |
|---|---|
| `workspacePath` | The producer decides which project the Session belongs to; the path must be absolute |
| `sessionId` | The producer's identity prefix makes the Session traceable to its origin (`webhook-…`, `routine-…`) |
| `title` | The producer knows what the Session is about before any model call exists |
| `agentPreset`, `permissionPreset` | Composition and authority are the producer's policy, resolved and validated before anything is created |
| `modelSelection`, `agentOptions` | The creation-time model, so the Session's first request does not depend on a later settings change |
| `message` | The producer owns the durable source kind the first message carries |
| `owner` | Names the producer in rollback warnings |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Ordered creation with real rollback.** Presets resolve first (a bad name fails before any side effect), then the Workspace is created, then the Agent, then the attachment; a failure after attachment detaches the Workspace and disposes the Agent, reporting each rollback failure without replacing the original error.
- **The creation-time model is pinned until the request header exists.** A listener on `agent/request` rewrites the resolved selection only while the Session has no durable request header, so the first request uses what the producer asked for and later turns follow normal resolution.
- **One implementation for every producer.** The webhook path and the routine path differ only in the identity prefix, the title, the composition, and the message source; those are the parameters, not a second copy of the sequence.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `startWorkspaceSession` and the model-selection pin |
| — | No runtime invariant companion is published; the helper's effect is the creation transaction itself, and its failure ordering is covered by the producers' tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace registry](../workspace/README.md) — the entity a created Session is attached to.
- [Webhook](../../webhook/webhook/README.md) — one producer that calls this helper, and the rule-result validation it owns.
- [Scheduled routines](../../schedule/schedule-routines/README.md) — the other shipped producer.

-----

<a id="model-experience"></a>
## Model Experience

### Session creation inputs

#### What the model sees

Nothing of its own. The helper contributes no prompt, tool, or schema: the only model-visible effect is the caller's `user/message`, admitted as the new Session's first user message under the caller's durable source kind. The title, permission preset, and model pin are session settings, not request content.

#### Token effect

Zero. `startWorkspaceSession` assembles no request; the message it admits and the turns that follow are the caller's and the new Session's ordinary costs.

#### KV Cache effect

No effect. A new Session starts with an empty reusable prefix, so nothing cached is invalidated.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the helper deliberately does not do. They are current package constraints, not a task backlog.

- **Root Sessions only** — the helper creates one top-level Session; forking, subagents, and parent attachment belong to their own services.
- **No post-creation ownership** — a caller that needs to observe, retry, or clean up the Session it started must do that itself; this helper's transaction ends at admission.
- **Creation-time model pin only** — the selection is honored until the first durable request header; a caller needing a different policy after that point must install its own listener.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
