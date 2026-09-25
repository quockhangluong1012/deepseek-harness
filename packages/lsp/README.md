---
description: "The lsp group map: language-server code navigation and diagnostics through the LSP seam, its stdio provider, the model-facing lsp tool, and post-edit result enrichment, for users and maintainers navigating the group."
kind: "package-group"
---

# lsp/ — Language-server code navigation

English | [中文](README.zh.md)

## Summary

Agents can navigate code and inspect diagnostics through local language servers: definitions, references, implementations, hover, and file diagnostics. `dsh-lsp` standardizes provider results; `lsp-stdio` connects configured servers and can detect four common commands; `tool-lsp` exposes on-demand queries; `lsp-post-edit-diagnostics` appends diagnostics to successful `edit`/`write` results. Base-backed profiles mount the stack but do not install server binaries.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`lsp/`](lsp/README.md) | Defines the code-navigation and diagnostics service: provider selection by file extension, five normalized operations, and structured errors | `ctx.lsp` |
| [`lsp-stdio/`](lsp-stdio/README.md) | Drives configured or auto-detected stdio language servers as providers over `ctx.fs` and `ctx.subprocess`, including bounded diagnostics waits | registers on `ctx.lsp` |
| [`tool-lsp/`](tool-lsp/README.md) | Exposes precise code navigation and on-demand diagnostics to the model through the `lsp` tool | registers on `ctx.tools` |
| [`lsp-post-edit-diagnostics/`](lsp-post-edit-diagnostics/README.md) | Appends a touched file's diagnostics to successful `edit`/`write` results, without a model round-trip | listens on `tools/post-execute` |

Providers register capabilities, not tools: `tool-lsp` is the only owner of the model-facing name, schema, prompt guidance, and presentation, so swapping a provider never changes how the model asks for navigation or diagnostics.

-----

<a id="related-documentation"></a>
## Related documentation

- [LSP navigation subsystem](../../docs/subsystems/lsp.md) — operations, coordinates, requests and results, and `LspError` codes.
- [Generated tool catalog](../../docs/tool-catalog.md#deepseek-aidsh-tool-lsp) — the `lsp` schema the model receives.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
