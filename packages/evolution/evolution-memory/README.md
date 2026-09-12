---
description: "Durable per-scope evolution memory record with lessons/profile writes, staged writes, and capacity accounting (ctx.evolutionMemory), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-memory

English | [中文](README.zh.md)

## Summary

`dsh-evolution-memory` owns the durable per-scope document behind evolution memory: the user-authored instructions, the model-maintained lessons and user-profile documents with provenance and per-family stamps, attached text and file context items, the produced-file index, staged writes awaiting approval, and the newest-first log of decided staged entries. Hosts read it synchronously and mutate it through capped writes; the reviewer and injector packages consume it. Choose it when every Session in a scope should inherit shared knowledge that improves with use, without writing inside the project.

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

Mount the plugin when Sessions in a scope should share instructions, lessons, profile, and context. Scope identities are opaque `profile:workspaceId` (or `profile:global`) keys built with `EvolutionScopeId`. The JSON backend stores each scope at `evolution_memory/records/<profile>--<workspaceId>.json` via `storageKey()` because `:` is not path-safe. Reads are synchronous from validated memory; writes enforce byte caps before entering the write chain and stamp `updatedAt`.

### Configuration

`capacityBytes` is required: the deployment must choose what a scope may cost per request. Every other field is a validated `Config` member changeable from `cordis.yml`.

```yaml
- name: '@deepseek-ai/dsh-evolution-memory'
  config:
    capacityBytes: 131072
```

| Field | Default | Meaning |
|---|---|---|
| `capacityBytes` | required | Capacity-bar denominator and hard ceiling on stored bytes |
| `maxAgentBytes` | `65536` | Lessons document cap |
| `maxUserBytes` | `32768` | User profile document cap |
| `maxContextItemBytes` | `262144` | Per-item cap, and ceiling on a file item's observed size |
| `maxContextItems` | `50` | Item count cap |
| `maxOutputs` | `200` | Produced-file index size |
| `maxResolutions` | `200` | Decided staged entries retained per scope |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-memory) is the exhaustive source for every accepted field.

### Capacity and digest

Capacity is the UTF-8 byte length of `instructions` plus `agentLessons` plus `userProfile` plus the sum of `contextItems[].sizeBytes`. Outputs and staged writes are excluded. The digest covers instructions, lessons, profile, and context items only; outputs, staged writes, and timestamps never invalidate the injected brief. An absent record reads as `undefined`, uses zero bytes, and digests as `'empty'`.

### Lessons, staged writes, and decisions

`addLesson` appends one lesson and resolves without writing on an exact duplicate. `replaceLesson` and `removeLesson` take a substring expected exactly once: an unknown substring rejects with `evolution/item-not-found`, an ambiguous one with `evolution/ambiguous-match` carrying bounded excerpts. `stageWrite` parks a memory or skill proposal without touching capacity; `approveStaged` applies a memory op (keeping the entry when caps reject) and only drops a skill entry, while `rejectStaged` drops either.

A staged payload is a JSON value and is validated at the write boundary: a payload that cannot round-trip through JSON is refused loudly and nothing is stored.

Both decisions append a resolution — entry id, kind, op, gist, decision, origin session, and instant — to the record's newest-first `resolutions` log, capped by `maxResolutions`. Resolutions stay out of capacity and out of the digest, so deciding a write never re-injects the brief.

Each memory family stamps its own instant: `setInstructions` stamps `instructionsUpdatedAt`, the `setLessons` / `addLesson` / `replaceLesson` / `removeLesson` family stamps `lessonsUpdatedAt`, and `setUserProfile` stamps `profileUpdatedAt`. A staged approval stamps only the family its op changed, and a duplicate lesson add stamps none. `memoryUpdatedAt` remains for one release as the later of the lessons and profile stamps. Every accepted write stamps `updatedAt`.

Recalled context material — the reviewer's ranked recall — is an ordinary context item labelled with the exported `RECALL_LABEL_PREFIX`, so the digest covers it and the brief drops it first.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One durable record per scope in storage domain `evolution_memory`, version `1`, layout `per-record`, table `records`, keyed by `EvolutionScopeId`. Invalid records fail the domain open loudly: instructions are user-authored, not disposable derived data. There is no global slot and no migration facility.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionMemoryStore` service, caps, write paths, staged approval |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: record schema and `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | Public record, context item, output, provenance, and staged-write types |
| [`src/digest.ts`](src/digest.ts) | Digest, capacity, byte-length, and clipping helpers |

### Failure and recovery

A rejected write never mutates the record. `addContextItem` rejects with `evolution/capacity-exceeded` past the item count or capacity, and `removeContextItem` on an unknown id rejects with `evolution/item-not-found`. Field caps report `evolution/too-large` with the field, observed bytes, and ceiling. Ambiguous lesson substrings report `evolution/ambiguous-match` with the searched text and up to five excerpts. Unknown staged ids report `evolution/staged-not-found` on both approval and rejection. `recordOutputs` resolves without writing when the list is unchanged, so an idempotent turn produces no `domain/changed` churn.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness.spec.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-memory) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-evolution-memory-context`, which renders the stored instructions, lessons, profile, and context into the injected brief.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Machine-local only** — records live under `$DSH_HOME`, never inside the project directory.
- **One document per scope** — there is no per-entry provenance, per-entry deletion, or memory history.
- **File size is a snapshot** — a file item's recorded size is not refreshed when the file changes on disk.
- **Staged writes are unbounded** — staged entries are excluded from capacity by design, so an unreviewed backlog grows until approved or rejected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
