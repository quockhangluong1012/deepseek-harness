---
description: "Durable per-scope evolution memory record with lesson artifacts, profile writes, staged writes, capacity accounting and decay (ctx.evolutionMemory), for hosts composing the self-learning harness."
kind: "package-reference"
---

# @deepseek-ai/dsh-evolution-memory

English | [中文](README.zh.md)

## Summary

`dsh-evolution-memory` owns the durable per-scope document behind evolution memory: the user-authored instructions, the model-maintained lesson artifacts and user-profile document with the extraction that last wrote them and per-family stamps, attached text and file context items, the produced-file index, the recall ledger behind §23's relevance feedback loop, staged writes awaiting approval, and the newest-first log of decided staged entries. Hosts read it synchronously and mutate it through capped writes; the reviewer and injector packages consume it. Choose it when every Session in a scope should inherit shared knowledge that improves with use, without writing inside the project.

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

Mount the plugin when Sessions in a scope should share instructions, lesson artifacts, profile, and context. Scope identities are opaque `profile:workspaceId` (or `profile:global`) keys built with `EvolutionScopeId`. The JSON backend stores each scope at `evolution_memory/records/<profile>--<workspaceId>.json` via `storageKey()` because `:` is not path-safe. Reads are synchronous from validated memory; writes enforce byte caps before entering the write chain and stamp `updatedAt`. Every mutation also takes the scope's cross-process lock file in `lockDirectory`, so two dsh processes whose scopes share a storage medium never rewrite one scope's record at the same time; a write that cannot claim it within `lockWaitMs` fails with `evolution/scope-locked` instead of hanging.

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
| `maxRecalls` | `50` | Recalls retained per scope in the recall ledger, newest kept |
| `mergeSimilarityFloor` | `0.87` | Minimum similarity to an existing artifact that justifies merging instead of storing separately |
| `maintenanceIntervalHours` | `24` | Hours between two maintenance sweeps of every stored scope |
| `refutationFloor` | `3` | Refutations at or above which decay prunes an artifact regardless of age |
| `defaultTtlDays` | `30` | Days a new artifact is given as its ttl when its candidate supplies none |
| `episodicRetentionDays` | `7` | Days an episodic note stays readable after it landed; the append path drops older notes |
| `maxEpisodicEntries` | `100` | Episodic notes retained per scope past the age cut, newest kept |
| `demoteUtilityFloor` | `0.35` | S8 utility value below which a sufficiently surfaced fact is demoted by decay |
| `demoteMinSurfaced` | `3` | Surfacings a fact needs before its utility value is trusted for demotion |
| `lockDirectory` | `<DSH_HOME>/evolution-memory/locks` | Directory holding one cross-process lock file per scope; every process whose scopes share a storage medium must name the same one |
| `lockWaitMs` | `2000` | Milliseconds a write waits for a scope's held lock before it fails with `evolution/scope-locked`; `0` fails on first contention |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-evolution-memory) is the exhaustive source for every accepted field.

### Capacity and digest

Capacity is the UTF-8 byte length of `instructions` plus `userProfile` plus the sum of the context items' sizes, plus the serialized artifact array — one artifact's JSON at a time, because a JSON array is not a string `Buffer.byteLength` can measure whole — plus the episodic notes' text. Outputs and staged writes are excluded. The digest covers instructions, lessons, profile, and context items only; outputs, staged writes, episodic notes, and timestamps never invalidate the injected brief: the brief renders the curated snapshot, and raw consolidation material must not re-inject an identical brief. An absent record reads as `undefined`, uses zero bytes, and digests as `'empty'`.

### Lesson artifacts

An artifact is one durable extracted fact. Credentials are scrubbed before any durable write: a statement, its conditions, and the label it was drawn from have every recognized credential shape replaced with `[REDACTED]`, and identity is derived from the scrubbed statement, so a redacted fact keeps one identity instead of acquiring a twin. The fields are `statement`, `source` (a session id, or a label for a manually staged entry), `conditions`, `evidence` (`fact` | `observation` | `inference`), `confidence` in `[0, 1]`, `validationCount`, `refutationCount`, `scope` (`user` | `project` | `global`), an optional `ttlDays`, and the `createdAt` / `updatedAt` instants.

An artifact's identity is its normalized statement — lowercased, internal whitespace collapsed, trimmed — and that identity is the `id` every operation addresses. Identities are pairwise distinct within a record, so `addArtifact`, `updateArtifact`, and `removeArtifact` each name exactly one artifact, and the name survives every write: identity, counters, and instants are assigned by the store, never by a caller or a model. A fact is admitted as durable learning only when it names the source, trajectory, and lineage it was drawn from: `addArtifact` and `applyExtractionDecisions` both refuse a candidate whose `sourceRefs` is empty (`it names no source reference`), whose `trajectoryRefs` is empty (`it names no trajectory reference`), or whose `lineage` is absent (`it carries no lineage`) — each check is independent, so a candidate can fail on more than one at once — and a generic transcript summary therefore never lands as a lesson (spec §9.2). `utility` is deliberately not required at admission: it is emergent, computed only once a fact is surfaced and its recall graded through `rememberOutcome`, never supplied by a caller. The store supplies what the caller cannot know — the expiry policy, and the zeroed utility the estimator later updates. A candidate that declares its own content `trust: 'untrusted'` — text drawn from repository files, tool output, a fetched page, or an MCP server — is **not admissible directly**: `addArtifact` and `applyExtractionDecisions` refuse it and name the staging path, so taint reaches durable memory only through an approval a human or a policy answered for. `updateArtifact` patches `conditions`, `confidence`, `evidence`, and `ttlDays` only; a changed statement is a different fact, so it is expressed as a remove plus an add rather than a patch. `validationCount` and `refutationCount` move only through a decision batch — no other operation touches them.

`addArtifact` takes the candidate plus a merge strategy (`keep_both` by default) and is the one operation that can succeed without storing anything: when the candidate's identity is already present under `keep_both`, the call resolves with the record unchanged, entering no write and stamping no family. Under `overwrite` or `merge` the candidate folds into the artifact it matches — the artifact its identity keys, otherwise the most similar artifact at or above `mergeSimilarityFloor`, measured through the optional `ctx.embeddings` seam. `merge` unions the two `conditions` and keeps the higher confidence; `overwrite` replaces the artifact's content with the candidate's. Either way the matched artifact keeps its id, statement, counters, and creation instant, and only `updatedAt` moves. Without an embeddings service nothing is measured, so only an exact identity can match and a paraphrase is stored as an artifact of its own: paraphrase detection degrades, the write never fails.

`replaceArtifacts` is the whole-list write, not a compatibility shim: the controller's `setLessons` Remote call replaces every artifact of a scope in one write. A candidate that restates an artifact the record already holds — the identity its statement derives, or the statement a corrected artifact now carries — folds into that artifact with the `overwrite` merge, so its id, counters, creation instant, source, and expiry survive the write; only a statement the record does not hold is stored as a fresh artifact. A list that repeats an identity is refused rather than deduplicated, and the supplied list becomes the whole array — an artifact the caller omits is dropped.

### Decision batches

`applyExtractionDecisions(id, decisions, extraction?)` is the reviewer's one write per extraction call, and the only path that moves the two counters. A batch holds `LessonDecision` entries: `confirms` bumps the addressed artifact's `validationCount`, `contradicts` either bumps its `refutationCount` or, when the decision carries a correction, **supersedes** the fact: the old wording moves into the artifact's `supersedes` history, `validationCount` and `refutationCount` reset because they measured the value that no longer stands, and the standing value can therefore never be pruned by refutations of the wording it replaced. `new` adds an artifact candidate through the same merge-by-meaning path `addArtifact` uses — so a candidate that restates an artifact already stored is not stored beside it. A `new` decision that omits `strategy` folds under `keep_both`, which folds no content in: a candidate the similarity lookup matched is counted as a validation of the artifact it matched, because the extraction reported evidence for the fact it resembles, rather than being dropped with the decision. A correction keeps the artifact's `id`, `createdAt`, and every field the decision did not supply, so a corrected fact keeps its lineage and the identity callers address it by.

Decisions fold in the order the extraction reported them, against the record read at write time, so each addresses what the decisions before it produced. A `confirms` or `contradicts` naming an artifact the record no longer holds is skipped rather than refused — the target was resolved against an earlier read and a prune can land in between — and the rest of the batch still applies. The batch is one write: it stamps `lessonsUpdatedAt` once, a batch that changed nothing (an empty one, or one whose decisions were all skipped) stamps no family at all, and the extraction that found nothing is still recorded on `lastExtraction`.

A batch that lands with an extraction record is also published, after the write is durable, as one `evolution/decisions-applied` event carrying the scope, the source session, the decisions, and the scope's artifacts as they read *before* the write. Deriving consumers fold it into their own state — the knowledge graph's claim layer is the shipped one — and the pre-write artifacts are what make that possible: a `contradicts` decision keeps the artifact's `id` while replacing its statement, so the statement a correction corrects is only visible before the write. The event attributes every decision to the session that reported it, which is why a batch applied without an extraction record is not published at all: unattributable evidence is worse than none. A staged `applyDecisions` approval publishes under the entry's `originSessionId`. Listeners do not hold up the write and cannot fail it: the batch is already stored, so a listener that throws is logged and contained, exactly as `domain/changed` observers are.

### Staged writes and decisions

`stageWrite` parks a memory or skill proposal without touching capacity. A staged memory payload names its operation: `setInstructions`, `appendInstructions`, `setUserProfile`, and `appendEpisodic` carry `{ text }`, `addArtifact` carries `{ candidate, strategy }`, `updateArtifact` carries `{ id, patch }`, `removeArtifact` carries `{ id }`, `replaceArtifacts` carries `{ candidates }`, and `applyDecisions` carries `{ decisions, extraction? }`. `approveStaged` applies a memory op (keeping the entry staged when a cap rejects it, or when the addressed artifact does not exist) and only drops a skill entry, while `rejectStaged` drops either. Approving an `applyDecisions` batch applies the whole batch atomically against the record read at approval time, and resolves each `new` candidate's merge target then — the same measure-then-re-validate split `addArtifact`'s staged path uses, never a snapshot taken when the batch was staged.

A staged payload is a JSON value and is validated at the write boundary: a payload that cannot round-trip through JSON is refused loudly and nothing is stored.

A staged entry is also a remembered candidate: it carries a nullable `mergeKey`, a `recurrence` count starting at 1, a nullable `blockedReason`, and a `neededEvidence` list. `stageWrite` accepts an optional `mergeKey`; re-staging the same key in the same scope while an entry is pending bumps its `recurrence` instead of appending a duplicate, so a repeatedly proposed candidate is remembered rather than silently retried. `blockStaged` marks a pending entry with a reason and the evidence that would unblock it, keeping it pending; approving or rejecting clears the block by removing the entry.

A `create` proposal additionally needs a capture contract before approval: `capability`, `procedureRefs`, `validationRefs`, `validationSummary`, and `limitations`, with the validation refs independent of — disjoint from — the procedure refs. `approveStaged` on a creation proposal without a valid contract keeps the entry staged with `blockedReason: 'capture-contract'` and the missing evidence in `neededEvidence`, and rejects with `evolution/staged-blocked`. A `patch` is not gated that way: it revises a capability the catalog already admitted, and the measurement that justifies it — baseline versus candidate — lives with its proposer, which this store cannot read. `supplyStagedContract` attaches a fully valid contract to a pending creation proposal and lifts the block; the entry still needs an explicit approval. The reviewer stages skill proposals with a merge key derived from the produced paths, so repeated proposals bump recurrence while the admission evidence is still missing.

Both decisions append a resolution — entry id, kind, op, gist, decision, origin session, instant, merge key, and recurrence — to the record's newest-first `resolutions` log, capped by `maxResolutions`. Resolutions stay out of capacity and out of the digest, so deciding a write never re-injects the brief.

Each memory family stamps its own instant: `setInstructions` and `appendInstructions` stamp `instructionsUpdatedAt`, the `addArtifact` / `updateArtifact` / `removeArtifact` / `replaceArtifacts` / `applyDecisions` family stamps `lessonsUpdatedAt`, and `setUserProfile` stamps `profileUpdatedAt`. A staged approval stamps only the family its op changed, so a lesson add, or a decision batch, that changed nothing stamps none. `appendEpisodic` stamps no family: an episodic note is unapproved consolidation input, not a curated document. `memoryUpdatedAt` remains for one release as the later of the lessons and profile stamps. Every accepted write stamps `updatedAt`.

### The recall ledger

Recalled context material — the reviewer's ranked recall — is an ordinary context item labelled with the exported `RECALL_LABEL_PREFIX`, so the digest covers it and the brief drops it first. The same label is §23's `retrieved` link: `addContextItem` reads the recalled memory's identity out of the label and appends one row to the scope's recall ledger, `recalls` (newest first, capped by `maxRecalls`), each carrying the item it landed as and its instant.

Two more links are recorded from what the profile already writes. A decision batch that lands with an extraction record — `applyExtractionDecisions(id, decisions, extraction)` — binds every recall still awaiting one to that batch, recording its session and instant: that batch is the recorded decision the recalled material was in play for. `recordRecallOutcome(id, recalledId, outcome, at?)` records the session's graded outcome on the newest recall still awaiting one, refusing loudly when a memory has none, so a memory recalled again after an outcome is graded again on its newer recall.

Two §23 links have no record at all, and the ledger never guesses them: nothing observes whether an injected item was actually **used**, and nothing marks one as **cited**. `recalls()` returns every recorded row with the scope it landed in, and Grading a recall (`recordRecallOutcome`) also folds the outcome into the recalled fact: `rememberOutcome` adds the surfacing and recomputes the Laplace value from the counters, so a fact surfaced by a task that then failed accumulates the failing outcomes that `demotable` reads. A recall of something that is not a fact keeps its ledger row and updates no artifact. `recallUtility()` derives §24's reading from them, and each reading also carries S8's `estimate` (`surfaced`, `passingTasks`, `failingTasks`, and the Laplace `value` from `utilityValue`), which `demotable` uses to demote a fact surfaced `minSurfaced` times below `minUtility`: `relevance × decision impact × outcome gain`, where relevance is `n / (n + 1)` over the memory's recorded recalls — the same saturation the knowledge graph's belief uses, so no memory reaches the ceiling on retrieval alone — decision impact is the share of those recalls a recorded batch followed, and outcome gain is the share graded `ok`. §24's fourth factor, **source quality**, has no recorded source for a recalled memory, so the product carries three factors rather than a fabricated fourth.

Removing the context item does not remove the recall: the recall happened, and dropping the item from the brief does not un-retrieve it.

### Episodic notes

The record's third tier beside the curated families is the episodic daily log: raw session notes in append order, each carrying its UTC calendar day. Approval appends the note verbatim and then prunes — first the notes past `episodicRetentionDays`, then the oldest past `maxEpisodicEntries` — so the tier stays short-lived consolidation material rather than a second lessons document. A blank note is refused and the entry stays staged. The dreaming light phase reads the surviving notes as consolidation candidates alongside the feedback observations: one note is one sighting, sightings on distinct days are the independent contexts the deep phase gates on, and a note restating a recorded failure folds into that failure's candidate. Notes never enter the model brief — the brief is the approved snapshot — but their text counts toward capacity.

### Decay and maintenance

`sweep` drops every artifact decay condemns: one whose `refutationCount` has reached `refutationFloor`, whose `ttlDays` has elapsed since its `updatedAt` — the last validation, refutation, or edit, never a read or a rendered brief — or one `demotable` condemns by S8 utility: a value below `demoteUtilityFloor` once it has been surfaced at least `demoteMinSurfaced` times. A fact surfaced fewer times than that floor is never demoted on utility alone — absence of evidence is not evidence of uselessness — and utility only accumulates through `recordRecallOutcome`, so a fact nothing ever recalls keeps whatever ttl and refutation decay would otherwise apply to it. An artifact with no `ttlDays` never expires by age, so only the refutation floor or a low utility reading can drop it; a candidate that supplies none is given `defaultTtlDays` when the store admits it, so every artifact written through the ordinary paths carries one. A sweep drops whole artifacts and never edits or truncates one, and a sweep that finds nothing to drop reaches no write at all, moving neither `updatedAt` nor the family stamp.

When `ctx.evolutionHeartbeat` is mounted the store registers the `evolution-memory-maintenance` task, which sweeps every stored scope every `maintenanceIntervalHours` hours; with nothing mounted the store is unchanged and a caller drives `sweep` itself. `sweep` reports `pruned` and `refined`; `refined` is always `0` — nothing splits the coarse artifact a migrated document is admitted as, because the extraction writes new artifacts beside the ones it reads rather than refining them, and until a pass does that the coarse artifact is a correct, permanent fallback.

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
| [`src/capture-contract.ts`](src/capture-contract.ts) | Skill admission gate: `CaptureContract` validation and its JSON materialization |
| [`src/spec.ts`](src/spec.ts) | Domain declaration: record schema, legacy-document admission, and `defineDomain` spec |
| [`src/scope-lock.ts`](src/scope-lock.ts) | Cross-process scope write lock: exclusive lock file, bounded wait, and its `evolution/scope-locked` failure |
| [`src/types.ts`](src/types.ts) | Public record, context item, output, extraction, and staged-write types |
| [`src/lesson-artifact.ts`](src/lesson-artifact.ts) | Artifact type and schema, statement identity, and admission of a legacy lessons document |
| [`src/decisions.ts`](src/decisions.ts) | Decision vocabulary and the pure confirm/contradict/new fold over a record |
| [`src/merge.ts`](src/merge.ts) | Cosine similarity, the merge strategies, and merge-target selection |
| [`src/recall.ts`](src/recall.ts) | Recall-label reading, the ledger folds, and the pure §24 utility derivation |
| [`src/maintenance.ts`](src/maintenance.ts) | The decay predicate and the shape of one sweep's result |
| [`src/digest.ts`](src/digest.ts) | Digest, capacity, byte-length, and clipping helpers |

### Failure and recovery

A rejected write never mutates the record. `addContextItem` rejects with `evolution/capacity-exceeded` past the item count or capacity, and any write whose bytes no longer fit rejects the same way. A serialized artifact array past `maxAgentBytes` rejects with `evolution/too-large` naming the field, the observed bytes, and the ceiling instead. `updateArtifact` and `removeArtifact` on an unknown identity reject with `evolution/item-not-found`, which is also how a staged op addresses a missing artifact. A candidate list that repeats an identity and a statement that normalizes away to nothing are refused as programmer errors, loudly and before any durability: the first cannot distinguish two artifacts, and the second would persist a record the artifact schema rejects, which the next open of the domain would refuse. Unknown staged ids report `evolution/staged-not-found` on both approval and rejection. `recordOutputs` resolves without writing when the list is unchanged, so an idempotent turn produces no `domain/changed` churn. A write whose scope another process holds rejects with `evolution/scope-locked` naming the lock file and the holder's pid once `lockWaitMs` elapsed; the record is untouched, and the lock is released on the rejection path too, so the next write claims it immediately.

No invariant companion is published because the domain table is the only copy of this state, so there is no second independent observation to check it against.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Evolutionary Harness subsystem](../../../docs/subsystems/evolutionary-harness.md) — the behaviour contract this package implements.
- [Evolution package map](../README.md) — the group's packages and their repository position.
- [`dsh-evolution-graph`](../evolution-graph/README.md) — the claim/evidence consumer of this store's decision batches.
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
- **The scope lock excludes scope writers, it does not merge them** — each process holds its own snapshot of a scope's record, so the lock serializes the processes writing one scope rather than reconciling what the second one missed; a scope two processes both write keeps the later writer's view of the earlier one's fields. Point `lockDirectory` at one location shared by every process whose scopes share the storage medium, and relocating the storage root without relocating the lock directory leaves writers unserialized.
- **A lock file outlives the process that was killed while holding it** — a process that dies between claiming and releasing leaves its lock file behind, and later writers for that scope then fail after `lockWaitMs` with a message naming the file; deleting that file is the recovery. There is deliberately no staleness expiry, because expropriating a live holder's claim would admit the second writer the lock exists to exclude.
- **Paraphrase merging needs embeddings** — the similarity a candidate is matched by comes from the optional `ctx.embeddings` seam; without it only an exact normalized statement matches, so a reworded duplicate is stored as an artifact of its own.
- **A migrated artifact stays coarse** — a legacy lessons document opens as one artifact covering the whole text, and no pass splits it yet; the extraction folds decisions into the artifacts it is shown, so a migrated scope keeps that one long artifact line in the brief and gains new artifacts beside it rather than in place of it.
- **Decay is driven by writes and refutations, plus S8 utility once surfaced** — an artifact is pruned `defaultTtlDays` after the last write that reached it, and using an artifact never counts toward that clock, so a fact nothing discusses again decays even when it is still true. The counters a decision batch writes are what a scope's own turns supply: a `confirms` refreshes an artifact's `updatedAt` and a `contradicts` counts toward `refutationFloor`, while an artifact the extraction's relevance window never shows the model receives neither. A migrated coarse artifact carries no ttl at all, because admission does not assign one, so only the refutation floor or a low utility reading could ever drop it. Utility itself only accumulates through `recordRecallOutcome`, so an artifact recall never surfaces keeps neither the evidence nor the risk of that third decay path.
- **File size is a snapshot** — a file item's recorded size is not refreshed when the file changes on disk.
- **The recall ledger records two of §23's four links** — retrieval and the decision batch that followed are recorded, and a grader supplies the outcome; whether the injected item was *used* and whether it was *cited* have no writer anywhere, so they contribute nothing to a memory's utility, and §24's fourth factor (source quality) has no recorded source for a recalled memory. The ledger is therefore a floor on utility, not a full measurement.
- **The recall ledger is capped, not cumulative** — `maxRecalls` bounds it per scope, so a memory recalled more often than the cap keeps its newest recalls and its count is a count of retained recalls; anything reading it should not treat `recalls` as an all-time total. Outcomes are graded by a caller: nothing decides on its own that a recalled memory helped.
- **Staged writes are unbounded** — staged entries are excluded from capacity by design, so an unreviewed backlog grows until approved or rejected.
- **A decision batch carries no per-decision writer** — every decision in a batch is attributed to the session the batch's `extraction` names, so a caller that applies a batch without an extraction record publishes nothing to deriving consumers, and two confirmations of one artifact from one session are indistinguishable from a confirmation repeated by that session. Independence is the consumer's to count: the claim layer keys support by source and refuses to let one source attest a claim twice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
