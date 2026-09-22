---
description: "Durable per-workspace memory record with caps and capacity accounting (ctx.workspaceMemory), for hosts composing workspace memory."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-memory

English | [中文](README.zh.md)

## Summary

`dsh-workspace-memory` owns the durable per-Workspace document behind Workspace Memory: the user-authored description and instructions, the model-maintained memory document with its provenance, attached text and file context items, and the produced-file index. Hosts read it synchronously and mutate it through capped writes; the injector and extractor packages consume it. Choose it when every Session in a directory should inherit shared knowledge without writing inside the project.

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

Mount the plugin when Sessions in a Workspace should share instructions, memory, and context. Reads are synchronous from validated memory; writes enforce byte caps before entering the write chain and stamp `updatedAt`.

### Configuration

`capacityBytes` is required: the deployment must choose what a Workspace may cost per request. Every other field is a validated `Config` member changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-workspace-memory'
  config:
    capacityBytes: 131072
```

| Field | Default | Meaning |
|---|---|---|
| `capacityBytes` | required | Capacity-bar denominator and hard ceiling on stored bytes |
| `maxDescriptionBytes` | `4096` | Description cap |
| `maxInstructionsBytes` | `65536` | Instructions cap |
| `maxMemoryBytes` | `65536` | Memory document cap |
| `maxContextItemBytes` | `262144` | Per-item cap, and ceiling on a file item's observed size |
| `maxContextItems` | `50` | Item count cap |
| `maxOutputs` | `200` | Produced-file index size |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-workspace-memory) is the exhaustive source for every accepted field.

### Capacity and digest

Capacity is the UTF-8 byte length of `instructions` plus `memory` plus the sum of `contextItems[].sizeBytes`. Description and outputs are excluded. The digest covers instructions, memory, and context items only; description, outputs, and timestamps never invalidate the injected brief. An absent record reads as `undefined`, uses zero bytes, and digests as `'empty'`.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One durable record per Workspace in storage domain `workspace_memory`, version `1`, layout `per-record`, table `records`, keyed by `WorkspaceId`. Invalid records fail the domain open loudly: instructions are user-authored, not disposable derived data. There is no global slot and no migration facility.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `WorkspaceMemoryStore` service, caps, write paths |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: record schema and `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | Public record, context item, output, and provenance types |
| [`src/digest.ts`](src/digest.ts) | Digest, capacity, and byte-length helpers |

### Failure and recovery

A rejected write never mutates the record. `addContextItem` rejects with `workspace-memory/capacity-exceeded` past the item count or capacity, and `removeContextItem` on an unknown id rejects with `workspace-memory/item-not-found`. Field caps report `workspace-memory/too-large` with the field, observed bytes, and ceiling. `recordOutputs` resolves without writing when the list is unchanged, so an idempotent turn produces no `domain/changed` churn.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace Memory subsystem](../../../docs/subsystems/workspace-memory.md) — the behaviour contract this package implements.
- [Workspace package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-workspace-memory) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-workspace-memory-context`, which renders the stored instructions, memory, and context into the injected brief.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Machine-local only** — records live under `$DSH_HOME`, never inside the project directory.
- **One document per Workspace** — there is no per-entry provenance, per-entry deletion, or memory history.
- **File size is a snapshot** — a file item's recorded size is not refreshed when the file changes on disk.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
