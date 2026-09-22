---
description: "Workspace memory page and its Host workspaceMemory Remote face over the durable store."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-memory

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-workspace-memory` owns the Workspace page and the `workspaceMemory` Remote namespace. The page opens from the sidebar Workspace name and shows the description, produced-file outputs, chats and activity tabs, and the Instructions, Memory, and Context cards; it draws no input of its own, because the conversation's composer docks into the band the page holds open beneath its name and description. The Host face serves reads, mutations, file candidates, rebuilds, and the live follow stream over the durable store.

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

Mount the row in the `web-app` bundle beside the store, extractor, and injector. Clicking a Workspace name opens its page; the disclosure button expands the group. The page occupies the frame's `shell.page` seat, so it draws over the conversation in the center column rather than covering the app, and it renders null while nothing is open.

Opening a page resolves its Workspace's blank Session (`uiWorkspace.connectWorkspace` reuses an existing one, else creates it) and selects it, so the conversation's resident composer — the same control the home page shows, with its model, permission, and mode seats live — docks into the band the page holds open beneath its name and description; a prompt typed there goes straight into that Workspace's Session. The page yields the column back as soon as its own Session is talked to (the first prompt clears the blank flag, and the reply streams in the conversation the composer belongs to), when the reader opens another Session anywhere, and through the sidebar's `close` call; a cleared selection leaves it standing, because the page is also what the no-session view shows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

No invariant companion is published because the controller projects the store without holding independent state.

### Design concept

Host service `ctx.workspaceMemoryController` owns the `workspaceMemory` namespace; every verb resolves the Workspace first with `workspace/not-found`. The browser page calls `read` on open and subscribes to `follow` for live updates while a background extraction or output-index write lands.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host Remote service and follow feed |
| [`src/types.ts`](src/types.ts) | Browser-safe Remote vocabulary |
| [`src/client/index.ts`](src/client/index.ts) | Browser opener service, Workspace-Session connect, and page-seat registration |
| [`src/client/rpc.ts`](src/client/rpc.ts) | Page verbs and the follow subscription |
| [`src/client/Seat.tsx`](src/client/Seat.tsx) | Page-seat wiring for the page state |
| [`src/client/Page.tsx`](src/client/Page.tsx) | The page: identity block, composer band, outputs, tabs, cards |
| [`src/client/locales.ts`](src/client/locales.ts) | Typed dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace Memory subsystem](../../../docs/subsystems/workspace-memory.md) — the behaviour contract this package implements.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `@deepseek-ai/dsh-workspace-memory-context`, which renders the edited instructions, memory, and context into the injected brief.

#### KV Cache effect

Independent of live requests: the package never touches a request prefix, so it cannot invalidate provider cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the page is a poor fit. They are current package constraints.

- **Web only** — the page lives in the web composition; other profiles have no surface.
- **An Outputs tile opens its Session, not the file** — workspace-scoped surfaces have no file reader.
- **Memory is one document** — there is no per-entry provenance or history.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
