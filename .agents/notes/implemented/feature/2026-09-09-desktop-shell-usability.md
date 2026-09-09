# Agent Note: Desktop shell usability round

Status: implemented

English | [中文](2026-09-09-desktop-shell-usability.zh.md)

## Problem

The Electron shell opened every session with an application menu containing only Plugins, Check for Updates, and Quit, so chat input had no Edit, View, or Window affordances and the plugin window was the only surface that knew about updates yet exposed none of the update operations its own preload already carried. Plugin updates went through a blocking `window.prompt`, a missing locale key crashed the whole renderer, development builds showed an enabled install form that could only fail, and a 64 KB pnpm diagnostic reached the status line verbatim. Update downloads ran with no progress, a development check reported "already latest", and every backend restart surfaced as a bare `backend unavailable` 503.

## Decision

The shell builds its menu from `apps/desktop/src/menu.ts`: the application menu keeps the packaged-only plugin entry and the update check, while Edit (undo through select-all), View (reload, zoom, development-only devtools), and Window (minimize, close) use Electron roles so labels stay platform-owned and only the top-level menus consume shell locale copy. The plugin manager edits versions in an inline row editor with exact-version validation, confirms removals with a locale-owned dialog, disables its form in development with a read-only notice, guards missing locale keys, and renders transaction contention plus truncated first-line pnpm errors. The same window gains an Updates section driven by the existing update IPC plus a new `updates-version` channel: current version, manual check, install on available, and live download percentage from the coordinator's `download-progress` subscription. Backend-absent `dsh-app://app` traffic answers 503 with `retry-after: 1` and a locale-owned restarting body, and manual checks in development report the packaged-only message instead of "already latest".

## Alternatives considered

**Fork the Web client into a desktop-only chat UI.** Rejected because the Desktop Host already composes the matching client graph over the versioned pipe transport; a fork would split the release identity the packaging note qualifies as one combination.

**Return richer update state (channel origin, byte counts) in this round.** Rejected because the feed origin is a packaging-time artifact and byte totals arrive only inside progress events; the state carries an optional download percentage now and origin display stays deferred.

**Queue or cancel package transactions from the renderer.** Rejected because the project manager serializes through its lock file and pnpm owns its child lifecycle; the renderer maps contention to a wait-and-retry message instead of pretending to schedule.

**Serve Web assets through the shell protocol handler.** Rejected because `serveShellAsset` owns only the shell renderer directory while the installed Host streams the Web composition; the MIME table stays scoped to shell assets.

## Consequences

Chat input gains standard editing, zoom, and window controls with no new copy outside the shell dictionaries, and the plugin window becomes the single desktop-owned surface for plugins and updates. Version edits no longer block the event loop on a native prompt, development builds fail visibly before invoking pnpm, and long downloads report progress instead of silence. The offline seed, shard, signing, and store-merge pipeline is untouched by this change and remains the next round.

## Testing

`desktop-menu.spec.ts` pins the four top-level menus, role membership, packaged-only plugin state, and dev-only devtools; `plugin-manager-ui.spec.ts` pins prompt absence, locale-key resolution, and element-id presence; `update-coordinator.spec.ts` gains install-without-availability rejection and download-progress publication. `verify-client-ui-i18n` passes over the rewritten renderer, the desktop package builds, and the full `apps/desktop` plus `apps/desktop-host` suites pass.
