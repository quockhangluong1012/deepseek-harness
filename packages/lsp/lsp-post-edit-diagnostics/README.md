---
description: "Best-effort diagnostics context after successful edit and write calls, for deployments that compose an LSP provider with the file tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-post-edit-diagnostics

English | [中文](README.zh.md)

## Summary

Use `dsh-lsp-post-edit-diagnostics` to attach diagnostics for the changed file after a successful `edit` or `write`, without starting a separate model turn. It uses the session workspace and configured `ctx.lsp` provider; empty diagnostics or any lookup failure leave the successful file result unchanged. Choose it when a coding profile should receive language-server feedback immediately after edits. It neither installs language servers nor provides process confinement.

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

Mount the plugin beside a configured LSP provider and the filesystem tools; the composition must already provide `ctx.tools` and `ctx.lsp`.

### What happens after a file change

After a successful configured tool call, the plugin reads `file_path` and the calling session's `header.cwd`, then asks `ctx.lsp` for diagnostics on the updated file. A non-empty result is appended as additional context for the next model request; an empty result adds nothing. A missing workspace, unsupported extension, provider error, or cancellation also adds nothing and never converts a successful edit into a failure.

### Minimal composition

```yaml
- id: lsp-post-edit-diagnostics
  name: '@deepseek-ai/dsh-lsp-post-edit-diagnostics'
```

This row assumes `ctx.tools`, `ctx.fs`, `ctx.subprocess`, and `ctx.lsp` are already provided, with at least one `dsh-lsp-stdio` server configured for the files the tools change. The plugin does not mount a server or the `lsp` tool.

### Configuration

| Key | Default | Meaning |
|---|---|---|
| `toolNames` | `['edit', 'write']` | Successful tool names that trigger diagnostics lookup |
| `maxResultChars` | `16000` | Maximum diagnostics text, including truncation metadata |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsp-post-edit-diagnostics) lists every accepted field.

### Failures and recovery

The plugin is best-effort: it ignores a missing session cwd, a file extension with no registered provider, an empty diagnostics result, a provider failure, or cancellation. The original edit/write result and any context attached by other post-execute listeners remain unchanged. Empty results are not sent to the model.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin runs after the tool dispatches, so the provider reads the file after the successful write. It formats diagnostics with `dsh-tool-lsp`'s formatter and adds the text through `tools/post-execute`'s `additionalContexts`; it does not replace the tool result or add a model-visible tool.

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

### Additional diagnostics context

#### What the model sees

When a successful configured tool call produces diagnostics, the following model request receives a separate user-context message containing the file path and bounded diagnostic text. The original tool result stays unchanged. A clean file or failed lookup adds no message.

#### Token effect

The context is limited by `maxResultChars` and is added only for non-empty results.

#### KV Cache effect

The new message is appended after the existing request prefix; it does not change the preceding cached prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the plugin is a poor fit. They are current package constraints, not a task backlog.

- **No default server or profile mount** — language-server binaries are deployment-owned, and the shipped profiles do not configure an LSP provider. Compose this plugin only where `ctx.lsp` has a configured provider.
- **Push diagnostics are best-effort** — a server that publishes nothing, or has not analyzed the file before `diagnosticsWaitMs` expires, returns an empty list; the plugin does not retry or block the edit.
- **Default tool names only** — `edit` and `write` trigger by default. Add another name, such as `str_replace_editor`, in `toolNames` when that tool is mounted.
- **Server trust is deployment-owned** — the provider runs the configured server with the mounted subprocess and filesystem authority; this plugin adds no sandbox.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
