---
description: "Package map for the artifact store family: the storage service, the read-only retrieval service, the local backend, and the result policy."
kind: "package-group"
---

# spill/ — text spill capability family

English | [中文](README.zh.md)

## Summary

The `spill/` group stores full text outside the model's context and returns a locator with retrieval guidance, then reads those artifacts back on demand. The family splits into the storage and retrieval services in `spill/`, the local filesystem backend in `spill-local/`, and the tool-result policy in `spill-policy/`. Tool-result spilling is opt-in through `maxInlineTokens` and keeps the original result on storage failure. [Session references](../context/session-reference/README.md) also consume storage directly for truncated captured transcripts, with their own preview and failure notices; they do not require the tool-result policy.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three packages play the spill roles; the subsystem reference owns the exhaustive vocabulary and contracts.

| Package | Role | ctx key |
|---|---|---|
| [`spill/`](spill/README.md) | Storage and retrieval seams: saves oversized text, returns a locator plus retrieval guidance, and reads stored artifacts back | `ctx.spillStore`, `ctx.artifacts` |
| [`spill-local/`](spill-local/README.md) | Saves spilled text to private session-scoped files on this machine, and retrieves them read-only | registers on `ctx.spillStore` and `ctx.artifacts` |
| [`spill-policy/`](spill-policy/README.md) | Replaces oversized plain-text tool results with a preview and locator | listens on `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the subsystem reference for the shared vocabulary, then the design decision.

- [Spill subsystem](../../docs/subsystems/spill.md) — the `SaveTextSpill`/`SpillRef` vocabulary, ownership, retrieval operations, and backend relationships.
- [Tool output spill decision](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) — the capability boundary between storage, retention, and tool-owned output handling.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
