---
description: "Human inspection commands that report the deployment's checks, the command catalog, and the mounted MCP, agent, and hook surfaces."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-inspect

English | [中文](README.zh.md)

## Summary

`dsh-command-inspect` gives users five commands that answer "what does this deployment actually have?": `/help` lists every command the session can run, `/doctor` runs five independent deployment checks and then reports the mounted environment, and `/mcp`, `/agents`, and `/hooks` list the configured capability surfaces. Every command reads services and prints text; none of them writes state, starts a turn, or appends a session event, and each tolerates the optional services a smaller deployment omits.

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

Mount `dsh-command-inspect` in any deployment with a command adapter whose users debug their own setup. The shipped base bundle already includes it, so base-backed profiles have all five commands.

### Command reference

Each command takes no arguments; any input is a usage error.

| Command | Output |
|---|---|
| `/help` | `- /<name> <hint> — <description>` per command the invoking agent can reach, sorted by name, or `No commands are registered.` |
| `/doctor` | The five checks below, one line each; then the environment facts (provider routes with their advertised model counts, the callable tool count, the hook-bridge state, and whether the filesystem and storage capabilities are mounted); then one `Machine-readable:` line carrying the same checks as JSON |
| `/mcp` | MCP tools grouped by the server segment of their bridged name, or `No MCP tools are registered.` |
| `/agents` | Agent compositions with their plugin-row counts, the registered subagent providers, and the children of the invoking session |
| `/hooks` | The mounted hook bridges with their enabled state, or the explicit none |

Each check line is `<title>: <status> — <observation>`, and `<status>` is `ok`, `degraded`, or `unavailable`.

### What the checks report

| Check | `ok` | `degraded` | `unavailable` |
|---|---|---|---|
| Sandbox | The resolved policy, with a sandbox provider mounted or the mode `danger-full-access` | A confining mode with no sandbox provider mounted, so nothing enforces it | No `sandboxPolicy` service |
| Provider keys | Every credential reference a provider profile declares is configured, or no profile declares one | A declared reference is unconfigured; reported as `<route> → <REFERENCE>` | A declared reference exists but no `credentials` service is mounted |
| MCP | Every mounted client row published the server's bridged `mcp__<server>__<tool>` tools | A mounted row published no bridged tool | A row whose fiber failed, or no Loader and no bridged tool, or no client row and no tool |
| LSP | Every mounted `dsh-lsp*` row is active | The lsp service is mounted with no language-server row | No `lsp` service, no Loader, or a row whose fiber failed |
| Disk | Free bytes on the workspace volume | — | No workspace root, or the volume could not be read |

The concrete observation is always named: the sandbox mode with its workspace root and backend module, the provider route with its credential reference, the server with its Loader entry id, and the byte count with the volume it was read from.

A credential value never appears. The provider-key check reads the `apiKeyEnv` reference each configurable provider's settings profile declares, then asks `ctx.credentials.describe` for presence, so an absent key is reported by reference name only. Every third-party message that reaches the report passes through the guard's `redactSecrets`.

Each check is independent: a check whose probe throws reports `unavailable` with its redacted message, and the remaining checks still report. A check with nothing to read names the missing referent — the service, the Loader, the credential seam, or the workspace root.

### Minimal configuration

The commands have no configuration fields; they need the command registry, the tool registry, and the model registry. The checks additionally use whatever `ctx.settings`, `ctx.credentials`, `ctx.sandboxPolicy`, `ctx.sandbox`, `ctx.lsp`, and `ctx.loader` the composition mounts and report the rest as `unavailable`.

```yaml
- {name: '@deepseek-ai/dsh-commands'}
- {name: '@deepseek-ai/dsh-tools'}
- {name: '@deepseek-ai/dsh-llm'}
- id: command-inspect
  name: '@deepseek-ai/dsh-command-inspect'
```

Headless, ACP automation, and JSON-RPC apps register no command adapter and therefore cannot reach these commands.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design

- **Report, never probe hard.** Every optional service is resolved with `ctx.get`, and each report line states its absence explicitly, so an unmounted sandbox or a missing Loader degrades one line instead of failing the command.
- **One check, one observation.** Each check reads exactly the services that answer its question and never infers one fact from another's absence; the statuses come from what the probe returned.
- **The tool registry is the truth for tools.** `/doctor` counts what `ctx.tools.schemas()` returns and `/mcp` groups those same names, so both match the catalog the model would receive in an enabled session.
- **The Loader is the truth for mounts.** `/hooks`, the sandbox backend, the MCP client rows, and the LSP rows all read the plugin inventory, so a row that is mounted but disabled or failed is reported as such rather than being assumed active.
- **Redaction at the boundary.** Only the doctor's report builds text from third-party messages, and it passes each one through `redactSecrets` first.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The five commands, their usage grammar, and the report formatting |
| [`src/doctor.ts`](src/doctor.ts) | The five checks, their status rules, the MCP tool grouping `/mcp` shares, and the report renderer |
| — | No runtime invariant companion is published; every command is a read-only projection of services other packages own, and its output is covered by package tests. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Commands service](../commands/README.md) — the registry `/help` reports over.
- [Tool runtime](../../core/tools/README.md) — the registry `/doctor` and `/mcp` read.
- [Plugin inventory](../../host/plugin-inventory/README.md) — the Loader projection the checks and `/hooks` read.
- [Credentials](../../credentials/README.md) — the reference seam that answers presence without a value.
- [Settings](../../settings/README.md) — the profile values that declare each provider's credential reference.

-----

<a id="model-experience"></a>
## Model Experience

### Human inspection output

#### What the model sees

Nothing. All five commands answer in the UI command plane: they contribute no prompt section, message, tool, or schema, and they append no `user/message` or lifecycle event, so the report is not part of the conversation the model later reads.

#### Token effect

Zero. No command path assembles a request or adds content to one; the commands read registries and settings that already exist.

#### KV Cache effect

None. The commands change no request prefix and send no request of their own.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the commands can say. They are current package constraints, not a task backlog.

- **Observable facts only** — a capability that registers nothing (`/hooks` rules inside a bridge's own config, credentials behind an environment reference) is not listed, because the command reports what the running process can see.
- **MCP health is inferred, never pinged** — the check reads the mounted client rows and the bridged tools; it never calls a server tool, and a server that is reconnecting reads as a mounted row without tools.
- **A failed row is named without its message** — the Loader projection carries a row's module, enablement, and fiber phase, not the error a failed activation threw.
- **LSP rows describe the plugin, not a process** — a stdio provider starts its server on the first matching query, so an active row does not mean a server process is running.
- **Disk space is reported, not judged** — the check names the free bytes it read and applies no threshold, so the operator decides whether the volume is too full.
- **No per-command arguments** — every command takes the whole report or the explicit empty state; filtering by provider, server, or agent is not supported, and the machine-readable form is the report itself rather than a selected subset.
- **Text output only** — results are plain lines with one embedded JSON line for machine consumers; a client that wants interactive panels renders them from its own data, not from these strings.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
