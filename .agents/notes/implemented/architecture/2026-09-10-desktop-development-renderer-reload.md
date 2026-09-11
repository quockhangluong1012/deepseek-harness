# Agent Note: Desktop development reloads the renderer window

Status: implemented

English | [中文](2026-09-10-desktop-development-renderer-reload.zh.md)

## Problem

Workspace development of the Electron desktop application had no refresh loop. `dev:desktop` builds the Host, the client bundles, the Web frontend, and the Electron shell once, then launches them; the Host serves the composed client bundles and the Web frontend `dist` from the linked workspace as if they were installed artifacts. The browser development loop cannot cover it. The reload driver's node half injects `webServer` to serve the `/plugins/events` SSE channel, and the desktop composition disables the `webserver` row because requests arrive over framed byte pipes instead of a listening socket; the browser half, which performs the in-page fiber swap, exists only to consume that channel. A developer editing a client plugin therefore had to stop the application, rebuild, and relaunch. Even a manual window reload was not enough: the module table serves bundle bytes from memory under immutable cache headers, and nothing in the desktop composition calls `clientModules.rebuilt`, so the reload kept the composition-time revision.

## Decision

The bundle watch is transport-independent, and a composition without the SSE channel mounts it alone and decides what a rebuild means.

- `packages/client/hmr/src/bundle-watch.ts` owns the stat poll, the graph-following watch set, and the `clientModules.rebuilt(id)` reporting. Both rows mount it, so the poll has one implementation and one set of semantics.
- The `client-hmr` row keeps the browser composition's shape: the shared watch plus the `/plugins/events` channel that drives the in-page swap.
- `@deepseek-ai/dsh-client-hmr/watch` (`packages/client/hmr/src/watch.ts`) is the watch-only row. It injects only `clientModules`, declares the same `pollIntervalMs` field, and has no browser half.
- In workspace development, the Desktop Host (`apps/desktop-host`, `--allow-linked-profile`) appends a patch layer inserting that row. The Host also subscribes to `clientModules.onRebuilt` and polls the served shell index document, then announces `{ type: 'renderer-rebuilt' }` on the Node IPC channel.
- The Electron shell registers a listener for that event and reloads the main window 300 ms after the last announcement, so one source edit's burst of artifact writes settles first.

### Why the desktop reloads the window instead of swapping fibers

Reload is the honest reaction to the transport: the desktop renderer is a client of the Host, its state lives in the Session log and the Host services, and a window reload reconnects and replays. Reimplementing the in-page swap over the byte pipes would first require an event channel the desktop deliberately does not have, and would then duplicate a driver whose failure policy is stated for the browser's module table.

### What the developer runs

`pnpm run dev:web` beside `pnpm run dev:desktop`. The watcher rebuilds client bundles and the Web frontend dist; the Host notices either, and the window reloads. Main-process and preload changes still need `pnpm run build:desktop` and a relaunch through `pnpm run start:desktop`, because Electron loads the built main process.

## Alternatives considered

| Rejected | One-line reason |
|---|---|
| Enable the `client-hmr` row in the desktop composition | Its browser half subscribes to `/plugins/events` with `EventSource`, which the desktop transport cannot carry; the renderer would retry a route the Host does not serve |
| Make the browser half detect the desktop transport and stay inert | Leaves a row whose half silently does nothing, adds transport detection to browser code, and still needs the Host-side notification the watch-only row provides |
| Install the watch from the Host process as a library call | Same behavior with no composition record: the row would exist only as a call site inside an app package, invisible to the config tree and to the package's invariant companion |
| Carry an SSE-equivalent channel over the desktop byte pipes | A second streaming protocol, driven by browsers' reload driver, for a reload a window refresh already performs correctly |
| Poll artifacts in the Electron main process | Duplicates the module host's baseline and revision knowledge in a process that cannot see the composed graph; the Host already owns both |
| Rebuild automatically when files change (a bundler in the dev loop) | Couples the shell to one builder; `pnpm run dev:web` already is the repository's watcher, and the Host only needs to observe artifacts |

## Consequences

The desktop joins the browser in one development property: rebuilding a renderer artifact reaches the running application without a manual rebuild. The cost is a second public entry point in `dsh-client-hmr`, one extra row in the development composition, and a protocol event the shell must handle — the desktop wire protocol version moves to 4, so an installed Host and a shell from different releases still refuse each other loudly.

Two boundaries stay explicit. An installed application mounts no watch row and serves immutable bundles, so nothing polls the filesystem outside workspace development. Main-process code keeps its build-and-relaunch loop, because a window reload cannot reload the Electron process.

The generated configuration catalog enumerates package entry points, so the watch-only row's single field is documented in the package README rather than the catalog; the row's config is the same `pollIntervalMs` the entry point declares.

## Testing

`apps/desktop/tests/desktop-host-development-reload.spec.ts` pins the development patch layer and the artifact watcher: a rewritten shell document reports once and stops after dispose, a bundle rebuild reports through the subscription, and a throwing observer does not end the poll. `apps/desktop/tests/host-process.spec.ts` carries a `renderer-rebuilt` announcement over the real child-process IPC channel to the registered listener. `packages/client/hmr/tests/node-half.client.spec.ts` mounts the watch-only row against a context with no `webServer` service and proves it reports a rebuilt bundle and stops on disposal.
