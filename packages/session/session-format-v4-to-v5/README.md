---
description: "Moves a supported V4 Session log into the V5 writer format without changing events or the inherited prefix."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v4-to-v5

English | [中文](README.zh.md)

## Summary

Use this library to migrate a V4 Session log to V5 when the current writer adds the `max-steps` turn-end reason. The edge changes the header version and preserves each event and the inherited prefix. V5 keeps V4's physical row encoding. Use the session-format catalog for complete restoration; this package does not own file reads or publication.

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

### When to use it

The static session-format catalog uses this library when a stored V4 Session is read by the V5 writer. Callers use the catalog rather than assembling migration edges themselves.

### Entry point

Catalog builders use `sessionFormatV4ToV5` for the adjacent header and body edge. Directly calling its header converter does not restore the event body:

```ts
const v5Header = sessionFormatV4ToV5.migrateHeader(v4Header)
```

`restoreReleasedV5Artifact(artifact, knownEventTypes)` validates a complete V5 artifact and returns the same object. Invalid headers, event relationships, or unknown non-ignorable event types fail restoration; the persistence backend owns publication.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The V5 codec keeps V4's physical row representation and validates a V5 header. The adjacent body stage forwards scalar events and compact runs unchanged, preserving the inherited cut. V5 adds `turn/end.reason.kind: 'max-steps'`; existing V4 reasons and message source metadata retain their recorded values.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session format catalog](../session-format-catalog/README.md) — complete historical restoration and the current writer codec.
- [Session-format version cookbook](../../../docs/cookbook/adding-a-session-format-version.md) — version transitions and immutable generations.
- [Session format status](../../../docs/session-format-status.md) — writer, accepted baseline, and release records.
- [V3-to-V4 edge](../session-format-v3-to-v4/README.md) — the preceding codec and migration.

-----

<a id="model-experience"></a>
## Model Experience

### Historical restoration

#### What the model sees

The V4-to-V5 edge preserves model messages. The new `turn/end.reason.kind: 'max-steps'` field is audit metadata and does not add prompt content.

#### Token effect

The migration changes no model message or token-bearing field.

#### KV Cache effect

The migration preserves the recorded request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No downgrade path** — V5 generations are not rewritten or opened as V4; older generations remain unchanged.
- **V4 source coverage** — unsupported physical rows still fail through the V4 codec, without publishing a partial V5 generation.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
