---
description: "The complete V5-to-V6 Session conversion: the event-attribution rename, newly required budget and evidence members, preservation, and named refusals."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v5-to-v6

English | [中文](README.zh.md)

## Summary

Restore supported released V5 Sessions as V6 without inventing provenance or evidence. This page is the single specification for this adjacent edge: what it transforms, preserves, and refuses, followed separately by native V6 admission. The library renames one event-attribution member, admits the optional members and union arms V6 added, and refuses the historical cases whose V6 meaning would have to be fabricated. Persistence consumes it through the static catalog; the library does not read or publish files.

## Table of Contents

- [Use this package](#use-this-package)
- [V5-to-V6 specification](#v5-to-v6-specification)
  - [Header conversion](#header-conversion)
  - [Attribution rename](#attribution-rename)
  - [Newly required members](#newly-required-members)
  - [Additive V6 members and vocabulary](#additive-v6-members-and-vocabulary)
  - [Preserved values](#preserved-values)
  - [Inherited cut](#inherited-cut)
  - [Refusal families](#refusal-families)
  - [External prerequisites](#external-prerequisites)
- [Native V6 admission](#native-v6-admission)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use the [catalog](../session-format-catalog/README.md) to restore a Session. Direct imports serve catalog assembly and tests; this library has no Cordis mount configuration. The [public exports](src/index.ts) provide the migration declaration, the released V5 source codec, the V6 target codec, the target header validator, and the target restorer.

### Entry point

The header-only operation does not convert or validate an event body:

```text
const targetHeader = sessionFormatV5ToV6.migrateHeader(sourceHeader)
```

Full restoration feeds decoded events through a fresh stage and validates the target artifact. Callers must not treat partial stage emissions as a successful restore: an error can occur at a later event or at `finish()`. The [format protocol](../session-format/README.md) owns stage scheduling and catalog error handling; [JSONL persistence](../session-persistence-jsonl/README.md) owns read preparation and immutable successor publication.

-----

<a id="v5-to-v6-specification"></a>
## V5-to-V6 specification

The source shape is the accepted V5 baseline recorded in the [V5 format reference](../../../docs/persistence-changes/historical-formats/v5.md) and the [finalized V5 checkpoint](../../../docs/persistence-changes/finalized/v5.json); it is not whatever a later checkout happens to write. The edge preserves event count, order, timestamps, sequence coordinates, ids, and references. It inserts no event, deletes none, and never substitutes zero for an unknown cut. Only the members below change; preservation applies to admitted input, not arbitrary unaudited extensions.

<a id="header-conversion"></a>
### Header conversion

The logical header changes `version: 5` to `version: 6`. The V6 header shape is identical to V5's, so `id`, `createdAt`, `isSeeded`, `delegationDepth`, and the admitted optional `cwd`, `parentSession`, `origin`, and `agentPreset` keep their values. A header that is not a released V5 header is refused by `migrateHeader`; `assertReleasedV6Header` refuses a V6 header that does not satisfy those same rules. The physical row layout is unchanged, so the V6 codec reuses the released V5 framing with the version discriminator; no run tag, envelope member, or packed-row representation changes.

<a id="attribution-rename"></a>
### Attribution rename

`data.metadata.provenance` becomes `data.metadata.sourceRef` on every event that carries event metadata. The seventeen released V5 roots that carry it are `action/committed`, `action/decided`, `checkpoint/created`, `checkpoint/resumed`, `claim/updated`, `delegation/issued`, `delegation/received`, `evidence/recorded`, `failure/recorded`, `hypothesis/updated`, `recovery/decided`, `recovery/started`, `task/created`, `task/plan`, `task/transitioned`, `verification/requested`, and `verification/result`. The rule is stated on the position rather than on that list, so a producer that attaches metadata to another event is converted the same way.

`evidence/recorded.data.provenance` becomes `evidence/recorded.data.sourceRef` at the same time. The value shape `{ source, locator?, digest? }` and its nine `source` literals (`policy`, `user`, `model`, `tool`, `kernel`, `repo`, `subagent`, `web`, `mcp`) are unchanged, so the rename is total and lossless: the same value object moves, and no literal is translated, defaulted, or dropped.

The rename is refused when the target member is already present, because two attributions in one position have no defined V6 meaning. The diagnostic names the event type, its sequence, and both member paths.

<a id="newly-required-members"></a>
### Newly required members

V6 requires members a V5 record cannot supply. This edge refuses those records rather than synthesizing a value:

| Event | Required V6 member | Why it cannot be synthesized |
|---|---|---|
| `budget/exceeded` | `data.ceilings` | The ceiling set the run was measured against was never recorded in V5. |
| `budget/exceeded` | `data.scope` | The scope a limit applies to is not recoverable from the limit name. |
| `task/created` | `data.dependencies` | An empty list would assert "no dependencies", which the record does not say. |
| `task/created` | `data.evidence` | An empty list would assert "no evidence", which the record does not say. |
| `task/transitioned` | `data.evidence` | An empty list would assert "no evidence", which the record does not say. |
| `verification/requested` | `data.repositoryDigest` | A digest identifies the repository state verified; inventing one fabricates evidence. |
| `hypothesis/updated` | `data.tests[].repositoryDigest` | The same, per recorded test. |

Each diagnostic names the event type, its sequence, and the exact dotted path, so the first absent member of a record that lacks several is reported. Refusal is per artifact: the first such event ends the conversion and no partial successor is published.

<a id="additive-v6-members-and-vocabulary"></a>
### Additive V6 members and vocabulary

These V6 changes need no conversion, because a V5 record cannot contain them and V6 accepts their absence. They are admitted unchanged and are not refusals:

- Optional members: `budget/exceeded.data.runId`, `checkpoint/created.data.budgets.background`, `task/created.data.changeContract`, `verification/requested.data.changeContract`, `hypothesis/updated.data.tests[].changeContract`, `goal/change.data.goal.maxGoalTokens`, and `goal/change.data.tokensUsed`.
- Added union literals: `action/committed.data.governance.approvalOutcome` and `approval/decided.data.outcome` gain `allowed-always` and `allowed-session`; `budget/exceeded.data.name` gains the nine ceiling names; `checkpoint/created.data.unresolvedFailures[].kind`, `failure/recorded.data.kind`, and `recovery/started.data.kind` gain `plan-drift` and `verification-regressed`; `task/created.data.acceptance[].verifier`, `verification/requested.data.criteria[].verifier`, and `hypothesis/updated.data.tests[].criteria[].verifier` gain `lint`, `review`, `security`, `typecheck`, and `browser`; `task/transitioned.data.trigger.kind` gains `approval-decided`; the Message `source` union gains `repo-map`, `working-set`, `lsp-post-edit-diagnostics`, `mentor-loop`, and `routine`.
- Removed union arms that a V5 record could not have carried are not refusals. `session/title-llm-request.data.messages` reorders its five role arms without changing their membership.
- The six event roots V6 added, and the members listed above, are ordinary same-version growth in the payload model; the version bump is required because they cannot be recorded separately against the accepted V5 baseline, not because this edge transforms them.

<a id="preserved-values"></a>
### Preserved values

Everything else survives byte for byte:

- Event order, count, dense `seq`, `time`, `ignorable`, `surfaceOp`, and `sourceEventSeqs`.
- Ids and references: `header.id`, `parentSession`, task, goal, hypothesis, evidence, failure, delegation, and message ids; `contentRef`; `evidenceId`; `retryId`; `transitionId`; `sourceEventSeqs[]`; `messageSeqs[]`; `shadowedRange`; `shadowedSeqs[]`.
- Opaque nested data: message content blocks, tool arguments and results, `replayState`, attachments, budget numbers, and any producer extension. A member named `provenance` inside opaque nested data is not an event attribution and is not renamed; the rule applies only to the `data.metadata` object and to `evidence/recorded.data`.
- Numbers, strings, and literals with no mapping above keep their values, including a `source` literal the V6 union still admits.

<a id="inherited-cut"></a>
### Inherited cut

This edge changes no cardinality, so the inherited cut is unchanged. An unseeded Session exposes `headerInheritedEventCount: 0` and returns `0`; a seeded Session exposes the supplied source count when the chain already knows it, and otherwise derives the exact cut from the last `session/end-seed` carrying `data.inherited: true` at `finish()`. A supplied count that disagrees with the marker, a seeded record with no marker, and an unseeded record with a marker are all refused. Each `createStage` call owns its own marker state, so concurrent Sessions never share a cut.

<a id="refusal-families"></a>
### Refusal families

The removed attribution kind is the one V5 union arm that V6 deleted:

| Family | Slot | Reason |
|---|---|---|
| Removed source kind `workspace-memory-llm` | `user/message.data.source` | V6 removed the kind from the Message source union; a replacement attribution would be false provenance. |
| Removed source kind `workspace-memory-llm` | `developer/message.data.message.source` | Same union, same reason. |
| Removed source kind `workspace-memory-llm` | `agent/inbox/spliced.data.inserted[].source` | Same union, same reason. |
| Removed source kind `workspace-memory-llm` | `session/title-llm-request.data.messages[].source` | Same union, same reason. |
| Newly required member absent | the payloads in [Newly required members](#newly-required-members) | The value was never recorded; synthesizing it fabricates evidence. |
| Rename collision | `data.metadata`, `evidence/recorded.data` | Two attributions in one position have no defined V6 meaning. |

These four removed-kind slots are exactly the V5 positions whose `source` union admitted `workspace-memory-llm`; the union is shared, so the rule is stated per position. Migration-stage refusals raise `SessionFormatUnsupportedMigrationError`, and the catalog reports them as an unsupported migration. Source bytes, the source path, and the source generation are never changed, and no fallback to a predecessor generation is attempted.

<a id="external-prerequisites"></a>
### External prerequisites

Restoring a V5 record reaches V6 only when every earlier edge admits it. Released V0 through V4 vocabulary, the V3 system-head and canonical-envelope rules, PTC and preset renames, delivery watermarks, and the historical child-catalog facts all apply unchanged before this edge runs; this package does not relax or repeat them. A V5 record that a preceding edge would refuse is refused there, not here. The parent/child relationship between generations is owned by the catalog and persistence layers.

-----

<a id="native-v6-admission"></a>
## Native V6 admission

Input already marked V6 does not run V5-to-V6. The following checks belong to native admission and are performed by `restoreReleasedV6Artifact`, which the catalog calls for both a decoded V6 artifact and a chain-produced one:

- The V6 header is validated, then V5's unchanged vocabulary and relationship rules run over the same artifact under the V5 version discriminator. `restoreReleasedV6Artifact` returns the original artifact; it never rewrites or repairs it.
- An event that still carries `data.metadata.provenance`, or `evidence/recorded.data.provenance`, is refused: those members do not exist in V6.
- A missing [required member](#newly-required-members) is refused, and a removed `workspace-memory-llm` source kind is refused.
- The installed Session package owns the complete V6 event-shape, vocabulary, relationship, and surface validation. Catalog restoration with `validation: 'current'` runs it after this restorer; `validation: 'transformed'` runs this restorer alone. This restorer is deliberately narrower than the declared V6 schema and does not duplicate the installed validators.
- A record that no migration path can supply is never partially published: a refusal during conversion leaves the committed V5 generation exactly as it was.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [stage](src/migration.ts) owns only the inherited-marker cut; every conversion is a pure per-event function, so two concurrent Sessions share no mutable state. Compact runs are re-expanded one event at a time and re-emitted through `context.emitEvent`, because a converted event cannot stay inside a codec-owned run. The [codec](src/codec.ts) reuses the released V5 framing through the preceding edge package's export and changes only the version discriminator. The [restorer](src/validation.ts) checks the V6 delta, then hands the artifact to the frozen V5 rules. The source codec is re-exported, never redefined: `releasedV5SessionFormatCodec` in this package is the same object `@deepseek-ai/dsh-session-format-v4-to-v5` exports, which the tests assert by identity.

[Migration tests](tests/migration.spec.ts) pin the rename, every refusal family, the cut discipline, and stage independence. [Catalog tests](tests/catalog-restore.spec.ts) prove strict restoration through `sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' })`, including a seeded multi-hop cut from a released V0 shape and the absence of any predecessor fallback.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [V4-to-V5 edge](../session-format-v4-to-v5/README.md) — the preceding codec and migration whose source codec this package reuses.
- [V5 format reference](../../../docs/persistence-changes/historical-formats/v5.md) — the accepted V5 schema this edge reads.
- [Session format status](../../../docs/session-format-status.md) — writer, accepted baseline, and release records.
- [Session-format version cookbook](../../../docs/cookbook/adding-a-session-format-version.md) — version transitions and immutable generations.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

The model sees exactly the messages the V5 record contains. The renamed attribution is audit metadata, and the added members are not prompt content.

#### Token effect

The migration changes no model message or token-bearing field.

#### KV Cache effect

The migration preserves the recorded request prefix and adds no prompt text.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Records without a repository digest are not migratable** — a V5 `verification/requested`, `verification/result`, or `hypothesis/updated` record predating repository digests has no evidenced V6 mapping and is refused. A future edge may map it from a reproducible corpus; it must not invent the digest.
- **Records carrying `workspace-memory-llm` attribution are not migratable** — the kind has no V6 union arm, and any replacement would misattribute the content. This is a deliberate refusal, not a gap to be filled by inference.
- **No downgrade path** — V6 generations are never rewritten or opened as V5, and no predecessor is selected when the newest generation is newer or invalid. See the [compatibility obligations](../../../docs/session-format-status.md).
- **Narrower native restorer** — `restoreReleasedV6Artifact` validates the V6 delta plus the frozen V5 rules; complete V6 validation is the installed Session package's, reached through catalog `validation: 'current'`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
