---
description: "Best-effort LSP diagnostics appended to successful edit and write results for deployments that compose a local provider."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-post-edit-diagnostics

English | [中文](README.zh.md)

## Summary

Use `dsh-lsp-post-edit-diagnostics` to append diagnostics for the changed file to a successful `edit` or `write` result, without starting another model turn. It queries the session workspace through `ctx.lsp`; empty results or lookup failures leave the result unchanged. Base-backed profiles mount this plugin and auto-detect local servers. It neither installs binaries nor confines server processes.

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

Base-backed profiles mount the plugin with `ctx.tools` and `ctx.lsp`. A custom composition must provide those services and a language-server provider; `dsh-lsp-stdio` can detect common commands on PATH or use explicit server entries.

### What happens after a file change

After a successful `edit` or `write`, the plugin reads `file_path` and the calling session's `header.cwd`, then asks `ctx.lsp` for diagnostics on the updated file. A non-empty result is formatted and appended as a text block to the tool result. A missing workspace, unsupported extension, provider error, or cancellation leaves the successful file result unchanged and never blocks the edit.

### Minimal composition

```yaml
- id: lsp-post-edit-diagnostics
  name: '@deepseek-ai/dsh-lsp-post-edit-diagnostics'
```

This row assumes `ctx.tools`, `ctx.fs`, `ctx.subprocess`, and `ctx.lsp` are provided. Base-backed profiles also mount `dsh-lsp-stdio` with auto-detection; custom compositions must mount a server provider. This plugin does not install server binaries or mount the `lsp` tool.

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `maxResultChars` | `16000` | Maximum diagnostics text, including truncation metadata |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsp-post-edit-diagnostics) lists every accepted field.

### Failures and recovery

The plugin is best-effort: it ignores a missing session cwd, a file extension with no registered provider, an empty diagnostics result, a provider failure, or cancellation. It leaves the successful edit/write result and any additional contexts from other post-execute listeners intact. Empty results add no diagnostic block.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin runs after tool dispatch, so the provider reads the file after the successful write. It formats diagnostics with `dsh-tool-lsp`'s formatter and appends a text block through `tools/post-execute`'s result content. If a later listener replaces that projection with a structured value, diagnostics use additional context so the value stays intact.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config, post-execute listener, best-effort `ctx.lsp` query |
| — | No runtime invariant companion is published; the plugin owns no durable projection or event stream, and its listener behavior is covered by package tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LSP navigation and diagnostics subsystem](../../../docs/subsystems/lsp.md) — operation and result contracts.
- [dsh-lsp-stdio](../lsp-stdio/README.md) — configure the local server that publishes diagnostics.
- [dsh-tool-lsp](../tool-lsp/README.md) — query and render diagnostics directly.
- [lsp group map](../README.md) — related packages and composition boundary.

-----

<a id="model-experience"></a>
## Model Experience

### Appended diagnostics

#### What the model sees

When a successful `edit` or `write` produces diagnostics, the following model request receives the diagnostic text as part of that tool's result. A clean file or failed lookup adds no diagnostic block.

#### Token effect

The appended diagnostic text is limited by `maxResultChars` and appears only for non-empty results.

#### KV Cache effect

Earlier request content and tool-result blocks remain unchanged; only the successful edit/write result gains a diagnostic block.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the plugin is a poor fit. They are current package constraints, not a task backlog.

- **No bundled server binaries** — base-backed profiles detect the four supported commands on PATH but do not install them. With no provider for a file extension, the `lsp` tool fails with `LSP_UNAVAILABLE` and this plugin leaves edit/write results unchanged.
- **Push diagnostics are best-effort** — a server that publishes nothing, or has not analyzed the file before `diagnosticsWaitMs` expires, returns an empty list; the plugin does not retry or block the edit.
- **Fixed trigger tools** — only built-in `edit` and `write` results are enriched; other editor tools are unchanged.
- **Server trust is deployment-owned** — the provider runs the configured server with the mounted subprocess and filesystem authority; this plugin adds no sandbox.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
