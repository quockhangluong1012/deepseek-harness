---
description: "Durable per-scope evolution memory record with lesson artifacts, profile writes, staged writes, capacity accounting and decay (ctx.evolutionMemory), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-memory

English | [中文](README.zh.md)

## Summary

`dsh-evolution-memory` owns the durable per-scope document behind evolution memory: the user-authored instructions, the model-maintained lesson artifacts and user-profile document with provenance and per-family stamps, attached text and file context items, the produced-file index, staged writes awaiting approval, and the newest-first log of decided staged entries. Hosts read it synchronously and mutate it through capped writes; the reviewer and injector packages consume it. Choose it when every Session in a scope should inherit shared knowledge that improves with use, without writing inside the project.

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

Mount the plugin when Sessions in a scope should share instructions, lesson artifacts, profile, and context. Scope identities are opaque `profile:workspaceId` (or `profile:global`) keys built with `EvolutionScopeId`. The JSON backend stores each scope at `evolution_memory/records/<profile>--<workspaceId>.json` via `storageKey()` because `:` is not path-safe. Reads are synchronous from validated memory; writes enforce byte caps before entering the write chain and stamp `updatedAt`.

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
| `maxAgentBytes` | `65536` | Cap on the artifacts, not on a document: the summed serialized bytes of `agentLessons` |
| `maxUserBytes` | `32768` | User profile document cap |
| `maxContextItemBytes` | `262144` | Per-item cap, and ceiling on a file item's observed size |
| `maxContextItems` | `50` | Item count cap |
| `maxOutputs` | `200` | Produced-file index size |
| `maxResolutions` | `200` | Decided staged entries retained per scope |
| `mergeSimilarityFloor` | `0.87` | Minimum similarity to an existing artifact that justifies merging instead of storing separately |
| `maintenanceIntervalHours` | `24` | Hours between two maintenance sweeps of every stored scope |
| `refutationFloor` | `3` | Refutations at or above which decay prunes an artifact regardless of age |
| `defaultTtlDays` | `30` | Days a new artifact is given as its ttl when its candidate supplies none |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-memory) is the exhaustive source for every accepted field.

### Capacity and digest

Capacity is the UTF-8 byte length of `instructions` plus `userProfile` plus the sum of the context items' sizes, plus the serialized artifact array — one artifact's JSON at a time, because a JSON array is not a string `Buffer.byteLength` can measure whole. Outputs and staged writes are excluded. The digest covers instructions, lessons, profile, and context items only; outputs, staged writes, and timestamps never invalidate the injected brief. An absent record reads as `undefined`, uses zero bytes, and digests as `'empty'`.

### Lesson artifacts

An artifact is one durable extracted fact: `statement`, `source` (a session id, or a label for a manually staged entry), `conditions`, `evidence` (`fact` | `observation` | `inference`), `confidence` in `[0, 1]`, `validationCount`, `refutationCount`, `scope` (`user` | `project` | `global`), an optional `ttlDays`, and the `createdAt` / `updatedAt` instants.

An artifact's identity is its normalized statement — lowercased, internal whitespace collapsed, trimmed — and that identity is the `id` every operation addresses. Identities are pairwise distinct within a record, so `addArtifact`, `updateArtifact`, and `removeArtifact` each name exactly one artifact, and the name survives every write: identity, counters, and instants are assigned by the store, never by a caller or a model. `updateArtifact` patches `conditions`, `confidence`, `evidence`, and `ttlDays` only; a changed statement is a different fact, so it is expressed as a remove plus an add rather than a patch.

`addArtifact` takes the candidate plus a merge strategy (`keep_both` by default) and is the one operation that can succeed without storing anything: when the candidate's identity is already present under `keep_both`, the call resolves with the record unchanged, entering no write and stamping no family. Under `overwrite` or `merge` the candidate folds into the artifact it matches — the artifact its identity keys, otherwise the most similar artifact at or above `mergeSimilarityFloor`, measured through the optional `ctx.embeddings` seam. `merge` unions the two `conditions` and keeps the higher confidence; `overwrite` replaces the artifact's content with the candidate's. Either way the matched artifact keeps its id, statement, counters, and creation instant, and only `updatedAt` moves. Without an embeddings service nothing is measured, so only an exact identity can match and a paraphrase is stored as an artifact of its own: paraphrase detection degrades, the write never fails.

`replaceArtifacts` is the document-level counterpart to the three id-addressed operations, not a compatibility shim: the markdown extraction pipeline rewrites a scope's lessons as one document and uses it until it emits per-candidate operations. Every candidate is validated and given a fresh identity, counters, and instants, so a list that repeats an identity is refused rather than deduplicated, and the supplied list becomes the whole array — an artifact the caller omits is dropped.

### Staged writes and decisions

`stageWrite` parks a memory or skill proposal without touching capacity. A staged memory payload names its operation: `setInstructions` and `setUserProfile` carry `{ text }`, `addArtifact` carries `{ candidate, strategy }`, `updateArtifact` carries `{ id, patch }`, `removeArtifact` carries `{ id }`, and `replaceArtifacts` carries `{ candidates }`. `approveStaged` applies a memory op (keeping the entry staged when a cap rejects it, or when the addressed artifact does not exist) and only drops a skill entry, while `rejectStaged` drops either.

A staged payload is a JSON value and is validated at the write boundary: a payload that cannot round-trip through JSON is refused loudly and nothing is stored.

Both decisions append a resolution — entry id, kind, op, gist, decision, origin session, and instant — to the record's newest-first `resolutions` log, capped by `maxResolutions`. Resolutions stay out of capacity and out of the digest, so deciding a write never re-injects the brief.

Each memory family stamps its own instant: `setInstructions` stamps `instructionsUpdatedAt`, the `addArtifact` / `updateArtifact` / `removeArtifact` / `replaceArtifacts` family stamps `lessonsUpdatedAt`, and `setUserProfile` stamps `profileUpdatedAt`. A staged approval stamps only the family its op changed, and a lesson add that stores nothing stamps none. `memoryUpdatedAt` remains for one release as the later of the lessons and profile stamps. Every accepted write stamps `updatedAt`.

Recalled context material — the reviewer's ranked recall — is an ordinary context item labelled with the exported `RECALL_LABEL_PREFIX`, so the digest covers it and the brief drops it first.

### Decay and maintenance

`sweep` drops every artifact decay condemns: one whose `refutationCount` has reached `refutationFloor`, or whose `ttlDays` has elapsed since its `updatedAt` — the last validation, refutation, or edit, never a read or a rendered brief. An artifact with no `ttlDays` never expires by age, so only the refutation floor can drop it; a candidate that supplies none is given `defaultTtlDays` when the store admits it, so every artifact written through the ordinary paths carries one. A sweep drops whole artifacts and never edits or truncates one, and a sweep that finds nothing to drop reaches no write at all, moving neither `updatedAt` nor the family stamp.

When `ctx.evolutionHeartbeat` is mounted the store registers the `evolution-memory-maintenance` task, which sweeps every stored scope every `maintenanceIntervalHours` hours; with nothing mounted the store is unchanged and a caller drives `sweep` itself. `sweep` reports `pruned` and `refined`; `refined` is always `0` — splitting the coarse artifact a migrated document is admitted as belongs to Phase 2, and until then that artifact is a correct, permanent fallback.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

One durable record per scope in storage domain `evolution_memory`, version `2`, layout `per-record`, table `records`, keyed by `EvolutionScopeId`. Version `2` declares `compatibleVersions: [1]` because the per-record backend reads a document stamped with a version outside the accepted set as an absent record: a bare bump would silently empty every existing scope rather than fail. Instructions are user-authored rather than disposable derived data, so this domain deliberately declares no `invalidRecords` policy and a record that fails the schema still fails the domain open loudly. The record schema accepts `agentLessons` as either the version-1 markdown string or the artifact array: a legacy string is admitted as one coarse artifact — `statement` = the document, `source: 'migration-pending'`, `evidence: 'inference'`, `confidence: 0.5`, `scope: 'project'`, both counters `0`, epoch instants, no ttl — so an old record opens and reads synchronously, and its first write stamps version `2`. There is no global slot and no migration hook to run: the domain facility offers none, and `read()` is synchronous.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `EvolutionMemoryStore` service, caps, write paths, staged approval, maintenance registration and sweep |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: record schema, legacy-document admission, and `defineDomain` spec |
| [`src/types.ts`](src/types.ts) | Public record, context item, output, provenance, and staged-write types |
| [`src/lesson-artifact.ts`](src/lesson-artifact.ts) | Artifact type and schema, statement identity, and admission of a legacy lessons document |
| [`src/merge.ts`](src/merge.ts) | Cosine similarity, the merge strategies, and merge-target selection |
| [`src/maintenance.ts`](src/maintenance.ts) | The decay predicate and the shape of one sweep's result |
| [`src/digest.ts`](src/digest.ts) | Digest, capacity, byte-length, and clipping helpers |

### Failure and recovery

A rejected write never mutates the record. `addContextItem` rejects with `evolution/capacity-exceeded` past the item count or capacity, and any write whose bytes no longer fit rejects the same way. A serialized artifact array past `maxAgentBytes` rejects with `evolution/too-large` naming the field, the observed bytes, and the ceiling instead. `updateArtifact` and `removeArtifact` on an unknown identity reject with `evolution/item-not-found`, which is also how a staged op addresses a missing artifact. A candidate list that repeats an identity and a statement that normalizes away to nothing are refused as programmer errors, loudly and before any durability: the first cannot distinguish two artifacts, and the second would persist a record the artifact schema rejects, which the next open of the domain would refuse. Unknown staged ids report `evolution/staged-not-found` on both approval and rejection. `recordOutputs` resolves without writing when the list is unchanged, so an idempotent turn produces no `domain/changed` churn.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness specification](../../../specs/evolutionary-harness-spec-v10-complete.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-memory) — every accepted config field.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-evolution-memory-context`, which renders the stored instructions, lesson artifacts, profile, and context into the injected brief.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the store is a poor fit. They are current package constraints.

- **Machine-local only** — records live under `$DSH_HOME`, never inside the project directory.
- **Paraphrase merging needs embeddings** — the similarity a candidate is matched by comes from the optional `ctx.embeddings` seam; without it only an exact normalized statement matches, so a reworded duplicate is stored as an artifact of its own.
- **A migrated artifact stays coarse** — a legacy lessons document opens as one artifact covering the whole text, and nothing splits it until Phase 2's structured extraction lands; until then it is one line in the brief, not a set of facts.
- **Decay needs a write, not a read** — an artifact is pruned `defaultTtlDays` after the last write that reached it, and using an artifact never counts; in this phase nothing yet writes the validations that would refresh one. A migrated coarse artifact carries no ttl at all, because admission does not assign one, so only the refutation floor could ever drop it.
- **File size is a snapshot** — a file item's recorded size is not refreshed when the file changes on disk.
- **Staged writes are unbounded** — staged entries are excluded from capacity by design, so an unreviewed backlog grows until approved or rejected.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
