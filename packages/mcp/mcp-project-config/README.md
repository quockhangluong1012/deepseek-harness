---
description: "Discovers a project .mcp.json and a user-level MCP config file, then mounts one dsh-mcp-client instance per configured server, for users and maintainers who want MCP servers available without an inline cordis.patch.yml entry."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-project-config

English | [中文](README.zh.md)

## Summary

`dsh-mcp-project-config` reads the Claude-Code-compatible `.mcp.json` format from a project file and a user-level file, mounts one [`dsh-mcp-client`](../mcp-client/README.md) instance per accepted server declaration, and serves the `mcpServers` Remote that lists, writes, and deletes those declarations for the Desktop MCP settings page. Shipped profiles mount this package by default; neither file existing is the common case and mounts nothing. A project entry overrides a user entry of the same name. One malformed entry is skipped with a warning rather than dropping every configured server, and a missing or unparsable file is treated the same way — the profile always finishes booting.

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

Shipped profiles already mount this package once. Put your MCP servers in a `.mcp.json` at your project root, or in the user-level file, and they connect the next time the profile boots; the Desktop page under **Settings → MCP** lists them and edits the same files.

### `.mcp.json` format

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "..." }
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ..." }
    }
  }
}
```

An entry may carry a `trust` label — `trusted`, `untrusted` (the default when the field is absent), or `unknown` — which every declaration of that server's tools passes to the agent kernel; a value outside that vocabulary skips the entry like any other malformed field.

A `command` entry with no `type` field is a stdio server. `args` and `env` default to empty. An entry with `"type": "http"` needs an absolute `http://` or `https://` `url`; `headers` default to empty. Every other declared type (`sse`, `websocket`, and anything else) is unsupported and skipped.

### Where the files live

| Field | Default | Meaning |
|---|---|---|
| `configPath` | `./.mcp.json` | Project MCP config, resolved against the process launch cwd |
| `userConfigPath` | `$DSH_HOME/mcp.json` | User-level MCP config, shared across every project |
| `failOnStartupError` | `false` | Fail this plugin's activation when a configured server's initial connection fails |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-project-config) is the exhaustive source for every accepted field.

A server declared in both files under the same (normalized) name mounts once, from the project file: the project is more specific to the current work, so it wins.

### Failures degrade to "no server," never a broken boot

Neither file existing mounts nothing and logs nothing — this is what every repository without configured MCP servers sees. A file that exists but is not valid JSON logs one warning naming the path and mounts nothing from that file; the other file (if valid) still mounts normally. An individual entry that is missing a required field, has the wrong shape, or is an unsupported type is skipped with one warning naming the raw key and the reason; every other entry in the same file still mounts.

By default (`failOnStartupError: false`), a configured server that cannot be reached still mounts: `dsh-mcp-client` logs the connection failure and enters its own reconnect policy, and every other configured server is unaffected.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [base bundle](../../bundle/base/README.md) owns this row, inherited by every base-backed profile (Web, Desktop, ACP, SDK, headless):

```yaml
- id: mcp-project-config
  name: '@deepseek-ai/dsh-mcp-project-config'
```

### Parsing is pure; the management service owns mounting

[`src/parse.ts`](src/parse.ts) parses one already-JSON-decoded `.mcp.json` document into a map of accepted servers plus a list of skipped entries with reasons — no filesystem access, no Cordis, independently unit-testable. [`src/mcp-servers.ts`](src/mcp-servers.ts) owns the merged view: it reads both files (a missing file is the empty case, not an error), merges them with project precedence, and calls `ctx.plugin(McpClient, config)` once per accepted server, sequentially — matching the [ACP bridge](../../acp/acp/README.md)'s own `mountAcpMcpServers`, which converts the same shape from protocol parameters instead of files. Each management write re-reads both files and reconciles the running instances, so what the Remote reports is what runs.

### Server-name normalization

A `.mcp.json` key that already matches `dsh-mcp-client`'s `serverName` pattern (`^[A-Za-z0-9_-]{1,32}$`) passes through unchanged. Any other key — spaces, punctuation, non-ASCII — is transliterated and a content-hash suffix is appended, reproducing the same normalization the ACP bridge applies to human-readable server names from a connecting editor. The two normalizers are intentionally independent implementations: file-based `.mcp.json` entries are developer-owned and already trusted at the level a project's `bash`/`edit` tools are, while ACP's `mcpServers` parameter arrives from a potentially remote editor peer under a stricter validation policy (an absolute stdio `command`, for instance) that this package does not need or want to inherit.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the config schema and the Host wiring that builds the approval channel |
| [`src/mcp-servers.ts`](src/mcp-servers.ts) | The `mcpServers` Remote Service: merged view, mount reconciliation, approval-gated writes |
| [`src/config-file.ts`](src/config-file.ts) | Reading and rewriting one `.mcp.json` document without disturbing its other keys |
| [`src/types.ts`](src/types.ts) | The Remote wire types: the merged view, the write requests, and the refusal vocabulary |
| [`src/parse.ts`](src/parse.ts) | Pure `.mcp.json` parsing, entry validation, declared trust labels, and server-name normalization |

No runtime invariant companion is published: the service's view derives from the two files, the parser, and the state its mounted children report, and no second observer records those facts independently.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [MCP client](../mcp-client/README.md) — the plugin mounted once per configured server: transports, instructions, and connection lifecycle.
- [MCP resources](../mcp-resources/README.md) — the shared resource-discovery tools available once any server is configured.
- [ACP MCP bridge](../../acp/acp/README.md) — the sibling mounting path for MCP servers supplied by a connecting editor instead of a file.
- [MCP settings page](../../client/ui-settings-mcp/README.md) — the Desktop page that lists these servers and writes declarations through the `mcpServers` Remote.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-mcp-project-config) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through each mounted `dsh-mcp-client` instance and, once any server is configured, [`dsh-mcp-resources`](../mcp-resources/README.md)'s shared tools. This package itself registers no tool, prompt section, or PTC declaration.

#### KV Cache effect

None directly; each mounted `dsh-mcp-client` instance owns its own request-prefix effect.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A management write needs an approval channel** — adding a declaration, replacing one, or deleting a project declaration that unmasks the user-level declaration of the same name is refused while no live session holds an open turn, because `user-approval` answers only inside one.
- **The files are read at launch and after every management write** — a `.mcp.json` edited outside the Host is not picked up until the profile restarts; there is no file watcher.
- **No OAuth, legacy SSE, or MCP prompt templates** — only `dsh-mcp-client`'s supported subset (stdio, Streamable HTTP) reaches a mounted server; every other declared type is skipped.
- **Sequential mounting** — servers mount one after another, so `dsh-mcp-client`'s own blocking initial-connection behavior means N configured servers can add up their worst-case startup delay; this matches the ACP bridge's existing mounting pattern rather than introducing a second concurrency convention.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
