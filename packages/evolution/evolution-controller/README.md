---
description: "Host Remote controller for the evolution harness: scope reads and writes, staged-write decisions, the journey timeline, and the per-scope follow stream (ctx.evolutionController)."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-controller

English | [中文](README.zh.md)

## Summary

`dsh-evolution-controller` is the host half of the evolution Web surface. It publishes the `evolution` Remote namespace over the durable per-scope record and reuses the `/journey` read model instead of restating it. Every scoped verb resolves the Workspace first and answers `workspace/not-found` for an unknown one; `follow` publishes one baseline carrying every registered scope, then one upsert per durable record change. Reads and writes touch no session log, and the package owns no durable state of its own.

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

Mount it beside `dsh-evolution-memory` and a workspace registry when a Web client (or any Remote consumer) must read and edit a scope's evolution state, decide its staged writes, and render its journey. The commands in `dsh-command-evolution` remain the CLI governance surface; both read the same record.

### Configuration

`profile` is required: the deployment must name which scope namespace the controller serves. Scopes never share a default namespace.

```yaml
- name: '@deepseek-ai/dsh-evolution-controller'
  config:
    profile: default
```

| Field | Default | Meaning |
|---|---|---|
| `profile` | required | Scope-identity namespace placed before the workspace key |

### The `evolution` namespace

| Verb | Request | Result |
|---|---|---|
| `read` | `{ scopeId }` | The scope's projected record, or the empty projection when it has none. |
| `setInstructions` | `{ scopeId, instructions }` | Replaces the user-authored rules and returns the projection. |
| `setLessons` | `{ scopeId, artifacts }` | Replaces the whole lesson-artifact list and returns the projection; an artifact the caller omits is dropped rather than kept beside the new ones. |
| `setProfile` | `{ scopeId, profile }` | Replaces the user-profile document by hand and returns the projection. |
| `addContextItem` | `{ scopeId, kind, label, text }` or `{ scopeId, kind, label, path }` | Attaches pasted text or a real file inside the Workspace. |
| `removeContextItem` | `{ scopeId, itemId }` | Detaches one context item. |
| `rebuildMemory` | `{ scopeId }` | Rebuilds lessons through the mounted reviewer. |
| `listStaged` | `{ scopeId }` | The pending staged writes, oldest first. |
| `approveStaged` | `{ scopeId, stagedId }` | Applies one staged write and drops it. |
| `rejectStaged` | `{ scopeId, stagedId }` | Drops one staged write without applying it. |
| `timeline` | `{ scopeId, range }` | The `/journey` timeline for `today`, `7d`, `30d`, or `all`. |
| `follow` | stream | One baseline carrying every registered scope, then one upsert per changed record. |

`scopeId` is the Workspace identity the scope is keyed by; the controller namespaces it with the configured `profile`, so a client never names a profile itself.

The controller owns no new error vocabulary: a missing Workspace is `workspace/not-found`, a malformed context request is `gateway/bad-request`, an unknown timeline range is `gateway/bad-request`, a duplicated staged decision is `evolution/staged-not-found`, and a rebuild without a mounted reviewer is `evolution/extraction-failed`.

### Composing the controller

```yaml
- name: '@deepseek-ai/dsh-workspace'
- name: '@deepseek-ai/dsh-evolution-memory'
  config:
    capacityBytes: 131072
- name: '@deepseek-ai/dsh-evolution-reviewer'
- name: '@deepseek-ai/dsh-evolution-controller'
  config:
    profile: default
```

The reviewer is optional at the Remote boundary: without it every verb but `rebuildMemory` still works, and a rebuild reports the missing seam instead of failing opaquely.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the controller; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One record, two surfaces.** The controller reads and writes the same durable record the CLI commands govern and the injector renders; it neither caches nor forks state, so the store stays the single authority.
- **The read model lives once.** `scopeTimeline` is imported from `dsh-command-evolution`, so `/journey` text and the timeline verb can never disagree about a bucket.
- **Scope-first, always.** Every verb resolves the Workspace through the registry before it touches the store, so an unknown scope fails with `workspace/not-found` rather than writing to a fabricated key. Staged decisions additionally prove the entry belongs to the resolved scope: another scope's id is reported absent, never decided.
- **One generation per stream call.** `follow` yields a complete baseline and then increments; a transport loss ends the generation, and `RemoteStream` opens the next one with its own fresh baseline. No reconnect bookkeeping lives here.
- **Detached projections.** Every result is a fresh structure, so no consumer can mutate the durable record by holding a returned value.

### Scope resolution and the follow stream

The scope key is `profile:workspaceId`. The feed subscribes to `domain/changed`, keeps only `evolution_memory.records` writes, ignores tombstones, maps the record key back to a registered Workspace by recomputing that Workspace's storage key (so another profile's records, or the profile-wide `global` record, are ignored), and pushes one upsert per follower. Followers are closed by the owning context's teardown, which also ends an in-flight generation.

### File context items

A `file` context item is resolved before it is stored: a relative path is resolved against the Workspace root, both sides are canonicalized, the target must be a regular file inside the Workspace, and the observed size is recorded. Later reads of the item are the injector's concern; the controller never re-reads the file.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service entry: the `evolution` Remote verbs, scope resolution, the follow feed, and file resolution |
| [`src/types.ts`](src/types.ts) | Remote request, result, and stream vocabulary, re-exporting the store's record types |
| — | No invariant companion is published because this service holds no state of its own: the store owns the single durable domain table, and the feed only projects writes it observes. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough.

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract behind the Remote namespace.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Evolution memory store](../evolution-memory/README.md) — the durable record every verb reads and writes.
- [Evolution commands](../command-evolution/README.md) — the CLI governance surface and the shared `/journey` read model.
- [Improvement roadmap](../../../specs/improvement.spec.md) — the Phase 6 controller slice this package lands.

-----

<a id="model-experience"></a>
## Model Experience

### Evolution controller (human surface)

#### What the model sees

Nothing directly: the `evolution` namespace serves human and Web consumers, and the model-visible evolution brief is rendered by `dsh-evolution-memory-context` from the record this controller edits. A `setLessons` or `setProfile` write changes the next brief the way a direct store write would.

#### Token effect

The namespace adds no model tokens. Requests carry only the fields a human surface supplies.

#### KV Cache effect

No effect of its own. An approved or hand-edited document invalidates reuse from the next injected brief, exactly as a direct store write would.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the controller is a poor fit; they are the current package constraints.

- **No scheduling or triggers** — the controller serves reads, writes, decisions, and the timeline; background review, rebuild scheduling, and skill curation keep their own owners.
- **One scope per verb** — every verb except `follow` addresses exactly one Workspace's scope; `follow` is the only cross-scope read.
- **Reconnect is the transport's job** — a `follow` call is one generation. `RemoteStream` reopens it with a fresh baseline; nothing in this package retries.
- **Attached file sizes are observations, not guarantees** — a file item records the size seen at attach time and is never refreshed, mirroring the store.
- **The reviewer is a separate mount** — `rebuildMemory` answers `evolution/extraction-failed` when no reviewer is composed, rather than degrading to a partial rebuild.
- **The Web surface is a separate package** — this package ships the host face only; the journey page and its locale-owned copy live in the client package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **The read model is imported across packages, on purpose** — `scopeTimeline` lives in `dsh-command-evolution` because the CLI shipped first. If a third consumer appears, the model earns its own package; until then, one import beats two copies.
- **The client Remote face is not here** — `RemoteStream` and the page verbs belong to the Web client package that consumes this namespace.

</details>
