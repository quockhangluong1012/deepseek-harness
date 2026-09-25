---
description: "The stdio language-server provider for ctx.lsp: configured server commands, extension mappings, and bounded transient-open queries, for users and maintainers composing local code navigation."
kind: "package-reference"
---

# @deepseek-ai/dsh-lsp-stdio

English | [中文](README.zh.md)

## Summary

Use `dsh-lsp-stdio` to query configured local language servers for definitions, references, implementations, hover information, and file diagnostics. It maps file extensions to language identifiers, starts one server per workspace on demand, and reads each queried file afresh. Diagnostics use `textDocument/publishDiagnostics` and wait only up to `diagnosticsWaitMs`; a server that publishes nothing within that window returns an empty list. Deployments supply the server commands and any required confinement.

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

Mount this provider when a deployment has local language servers — for example `typescript-language-server` — and wants the harness to navigate code through them. It needs filesystem and subprocess providers for the same execution world, plus the `dsh-lsp` seam and, for model access, `dsh-tool-lsp`.

### Minimal configuration

The `servers` record maps each stable provider id to one server command. The provider resolves every executable at load after credential scrubbing, so a bad entry prevents every provider from registering; processes launch lazily on the first matching query.

```yaml
- name: '@deepseek-ai/dsh-fs-local'
- name: '@deepseek-ai/dsh-subprocess-local'
- name: '@deepseek-ai/dsh-lsp'
- name: '@deepseek-ai/dsh-lsp-stdio'
  config:
    servers:
      typescript:
        command: typescript-language-server
        args: ['--stdio']
        extensionToLanguage:
          '.ts': typescript
- name: '@deepseek-ai/dsh-tool-lsp'
```

| Field | Default | Meaning |
|---|---|---|
| `command` | required | Executable to spawn — absolute, or resolved on the child PATH at load; launched without a shell |
| `extensionToLanguage` | required | Lowercase leading-dot extension → LSP language id (e.g. `{ '.ts': 'typescript' }`) |
| `args` | `[]` | Arguments passed to the executable |
| `env` | `{}` | Extra env merged over the credential-scrubbed ambient env; variables matching `KEY`/`PASSWORD`/`SECRET`/`TOKEN` and all `DSH_*` names are not forwarded |
| `initializationOptions` | `null` | Static `initialize` options forwarded to the server |
| `configuration` | `null` | Static answer to every `workspace/configuration` item |
| `maxMessageBytes` | `16000000` | Largest single framed message accepted from the server |
| `maxStderrBytes` | `1000000` | Largest stderr tail retained for diagnostics |
| `maxDocumentBytes` | `4000000` | Largest source file this host opens |
| `shutdownTimeoutMs` | `5000` | Graceful `shutdown`/`exit` budget before escalation |
| `killGraceMs` | `2000` | Request-cancel and SIGTERM→SIGKILL escalation grace |
| `diagnosticsWaitMs` | `3000` | Maximum wait after opening a file for a matching `textDocument/publishDiagnostics` notification; timeout returns an empty list |

`servers` must contain at least one entry with non-empty ids; timer budgets including `diagnosticsWaitMs` must be positive integers within Node's timer range, and byte caps must be positive. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-lsp-stdio) is the exhaustive source for every accepted field.

### What a query does

On the first query for a workspace, the provider launches one server process for that workspace and keeps it pooled. Each query reads the current source through `ctx.fs` and opens it (`textDocument/didOpen`). Cursor operations then send one request; `diagnostics` waits for a matching `textDocument/publishDiagnostics` notification, bounded by `diagnosticsWaitMs`. A timeout returns an empty list, which means "no diagnostics observed in time," not proof that the file is clean. The provider closes the document after the result. Queries to one server and workspace run one at a time; different workspaces run in parallel. If the pooled process fails during a request/response query, the provider retries that read-only query once on a fresh process.

### Observable success and failures

A successful navigation returns normalized locations, hover returns normalized text or a no-hover notice, and diagnostics returns a normalized list or an empty list after its bounded wait. The query fails when the server does not support a requested cursor operation or transient open/close synchronization (`LSP_UNSUPPORTED_OPERATION`), when the source is missing, non-regular, non-UTF-8, oversized, or outside the canonical workspace (rejected before the server starts), or when the server returns a malformed location, hover, or diagnostic (`LSP_MALFORMED_RESPONSE`). A hard-killed harness leaves servers running until they exit on their own — graceful shutdown happens only through service disposal.

### Security boundary

This provider trusts its configured server and adds no sandbox confinement; the server receives the filesystem and process authority of the mounted execution world. It rejects query sources that are missing, non-regular, non-UTF-8, oversized, or canonically outside the workspace before server startup. Result locations may point outside the workspace, but an external path can never become a query source. Mount filesystem and subprocess providers for the same execution world — a split-world composition is invalid.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider and where the code realizes them; observable behavior is covered in [Use this package](#use-this-package).

### Design philosophy

- **Generic host, not a catalog.** Deployments configure commands and mappings explicitly; presets belong in `cordis.yml` overlays, not in this package.
- **Compatibility-first transient open.** Every query runs `didOpen` (version 1, full text) → request or bounded diagnostics wait → `didClose`, so the server sees current bytes without retained document state. The diagnostics waiter is armed before `didOpen` reaches the server, so an immediate push is not lost.
- **Read before spawn.** The source is resolved, contained, and byte-bounded inside the workspace queue before any process is created, so a queued query sees current bytes when its turn starts and an invalid source cannot leave an idle process pooled.
- **One pooled process per canonical workspace.** Instances are single-flighted per `(server id, canonical workspace target)`; a transport failure retries the read-only query once on a fresh process after awaiting disposal.
- **Per-workspace serialization.** One abortable queue per workspace serializes source-read/open/query/close lifecycles; distinct workspaces run in parallel, and a cancellation that fails to stop a server terminates only that instance.
- **Bounded teardown.** Graceful `shutdown`/`exit` escalates through the subprocess provider's managed-range termination procedure; quiescence is confirmed by awaiting that whole range, not by the termination request's outcome.
- **Execution-world pairing.** Servers launch through `ctx.subprocess` with `processId: null` (another machine or PID namespace must not monitor the harness), sources read through `ctx.fs`, and no `fs/observed` event is emitted — only the LSP result is model-visible.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, executable resolution, provider registration, process pooling |
| [`src/host.ts`](src/host.ts) | Workspace canonicalization and bounded source reads through `ctx.fs` |
| [`src/instance.ts`](src/instance.ts) | One server process: initialize handshake, transient-open queries, push-diagnostics wait, bounded teardown |
| [`src/connection.ts`](src/connection.ts) | JSON-RPC endpoint: id correlation, outbound messages, inbound server requests and notifications, stderr cap |
| [`src/framing.ts`](src/framing.ts) | `Content-Length` framing and a bounded decoder |
| [`src/protocol.ts`](src/protocol.ts) | Wire-type subset: capabilities, locations, hover, diagnostics, text-document synchronization |
| [`src/translate.ts`](src/translate.ts) | Capability checks, UTF-16 negotiation, location/hover/diagnostic normalization |
| [`src/abort.ts`](src/abort.ts) | Cancellation helpers fusing caller and disposal signals |
| — | No runtime invariant companion is published; process pools and per-workspace queues are private implementation state, and this provider publishes no independent lifecycle event stream or enumerable snapshot. |

### Protocol behavior

Initialization advertises UTF-16 positions, workspace folders and configuration, markdown/plaintext hover, and link support for definition and implementation, with no dynamic registration; the server's returned capabilities are authoritative. An omitted server `positionEncoding` defaults to `utf-16`; any other value fails the query. The client answers `workspace/configuration` from static config, accepts lifecycle bookkeeping requests, and rejects `workspace/applyEdit` — it never applies edits or runs commands. Navigation normalizes `Location` and `LocationLink`; hover normalizes `MarkupContent` and `MarkedString`. For `diagnostics`, the client accepts the matching `textDocument/publishDiagnostics` push and normalizes ranges, severity, message, source, and code. Malformed results fail with `LSP_MALFORMED_RESPONSE`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared navigation model to the seam and the tool.

- [LSP navigation subsystem](../../../docs/subsystems/lsp.md) — operations, coordinates, requests and results, and `LspError` codes.
- [dsh-lsp](../lsp/README.md) — the seam this provider registers against.
- [dsh-tool-lsp](../tool-lsp/README.md) — the model-facing tool over the seam.
- [lsp group map](../README.md) — the four-package family and its related documentation.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-lsp`, which surfaces this provider's normalized results while this host contributes no prompt or schema itself.

#### KV Cache effect

No direct invalidation; `dsh-tool-lsp` owns request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No confinement policy** — this package trusts the configured server and does not sandbox its process; a restricted deployment must supply appropriate process and filesystem providers or a same-world sandbox wrapper.
- **Transient-open compatibility floor** — servers whose synchronization omits open/close (or advertises `None`) are unsupported even if closed-document queries would work; the pinned TypeScript e2e establishes one compatibility floor, not a cross-language claim.
- **Push diagnostics are time-bounded** — a server that publishes nothing or is still analyzing when `diagnosticsWaitMs` expires produces an empty result; the provider cannot distinguish a clean file from a late analysis.
- **Per-server and per-workspace serialization latency** — parallel agents sharing one server and workspace queue behind one process; long-lived workspace processes consume memory until disposal.
- **A hard-killed harness orphans language servers** — `initialize.processId: null` removes server-side client-PID monitoring, so servers are cleaned only by graceful service disposal; a SIGKILL'd harness leaves them running until they exit on their own.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
