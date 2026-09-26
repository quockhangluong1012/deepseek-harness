---
description: "The MCP servers settings page of the dsh web client: it lists the servers declared in the project and user config files with their trust labels and live connection state, and adds, edits, or removes them through the Host."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-mcp

English | [中文](README.zh.md)

## Summary

Open **Settings** in the sidebar and select **MCP** to see every server declared in this project's `.mcp.json` and in your user config, with the trust label each declaration carries and whether its connection is up. The page adds a declaration, edits one, or deletes one; the Host owns both files, so every change is a Host call that re-reads the merged configuration and reports the result. A change that extends what the model can reach is refused unless the Host's approval seam grants it. Stored environment and header values are never shown.

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

Shipped profiles mount [`mcp-project-config`](../../mcp/mcp-project-config/README.md) by default, which serves this page's `mcpServers` Remote and mounts one `dsh-mcp-client` per accepted declaration. The list shows each server's name, its layer (project or user), its declared trust label, its endpoint, the names of the environment variables or headers it sets, and its connection: **Connected**, **Connecting**, **Reconnecting** with the attempt counter, **Disconnected**, or **Not running** with the reason the declaration was rejected.

## Add, edit, and remove

**Add server** opens an editor: a name, the config file to write, the transport, the executable with one argument per line and one `NAME=value` per line for a local process, or an absolute URL with one `Name: value` per line for a remote endpoint, and the trust label. **Edit** opens the same editor on an existing declaration, with its secret fields blank — stored values are never sent to the page, so an edit asks the Host to keep them and merges the pairs it writes over them. **Remove** asks for confirmation first.

A declaration that extends what the model can reach — adding one, replacing one, or deleting a project declaration that unmasks the user-level declaration of the same name — is written only after the Host's approval seam answers. The page addresses that ask to the session you are viewing, so the prompt appears in that session's conversation; with no open turn, no live agent, or a declined prompt, nothing is written and the page says so.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host half is an empty `apply`, present only so the package holds a Loader row the client module system serves the browser half for. The browser half registers one `settings.section` entry with `id: 'mcp'` into the settings shell's ledger, so the shell projects it as a navigation row and renders the section while it is the active one, and registers its `settings.mcp` dictionary through `ctx.locale.register`.

`McpSettingsController` holds the page's state in a snapshot store: the merged view, whether a write is in flight, and the last notice. It reads the view through `remote.mcpServers.list`, writes through `remote.mcpServers.upsert` and `remote.mcpServers.remove`, and publishes a refusal as data — a refusal outcome carries the unchanged view, so a refused change leaves the list exactly as the Host reported it. The session an approval ask is addressed to is read at the moment of a write, never cached, so it follows the selection.

`McpServersSection` renders the list and the one open editor; `draftDeclaration` turns a draft's text into the declaration the Host writes, and names the first field that cannot be read. Every product string lives in `locales.ts` and reaches the component through the `t` seat; the component renders no stored value, only the names a declaration sets.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [mcp-project-config](../../mcp/mcp-project-config/README.md) — the Host half: config discovery, the `mcpServers` Remote, and the approval gate.
- [mcp-client](../../mcp/mcp-client/README.md) — the connection whose state this page reports.
- [ui-settings](../ui-settings/README.md) — the settings page shell and the `settings.section` ledger this section registers into.
- [approval](../../interaction/user-approval/README.md) — the seam a reach-extending change asks through.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side settings surface that registers no model surface.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **A change needs an approval channel** — a reach-extending change is refused while no session holds an open turn, because `user-approval` answers only inside one; the page reports the refusal instead of writing.
- **Values are write-only** — stored `env` and `headers` values are never read back to the page, so an edit shows the names alone and merges over the stored pairs.
- **No connection control** — the page reports the state each mounted client announces; it neither reconnects a server nor unregisters its tools.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
