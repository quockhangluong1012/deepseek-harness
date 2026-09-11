---
description: "The right Sidebar's progress tab type for the dsh web client: the Session's standing task checklist and every file its Turns produced, revealed at the first sign of work."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-progress

English | [中文](README.zh.md)

## Summary

The right Sidebar's progress tab type: the Session's task checklist, then the files its Turns produced. It is a page type reached from the guide and claims no address, and it opens itself once per Session at the first sign of work — a standing checklist or a produced file — so progress is visible without hunting for the affordance.

## Table of Contents

- [What it registers](#what-it-registers)
- [The panel](#the-panel)
- [When it opens](#when-it-opens)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind `progress`, id `@deepseek-ai/dsh-client-ui-progress`, band `builtin`, no patterns, and one guide entry (order 30, titled from the `sidebarProgress` namespace) that opens the type.
- **The body** — the keyed `sidebar.right.pane.tab` seat under that id, with no store and no injected face: everything it draws arrives through the framework's Session hooks.

Six source files under `src/client/`: `definition.ts` (the type), `progress.ts` (what it reports, and how that is derived), `auto-open.ts` (when it reveals itself), `ProgressBody.tsx` (what it draws), `locales.ts` (what it says), and `index.ts` (the wiring).

<a id="the-panel"></a>
## The panel

Two sections, each rendered only while it has something to show; with neither, one line says the panel is waiting.

| Section | Source |
|---|---|
| Tasks | The host-computed `todos` projection: the standing plan, cleared when the next turn starts. The header counts finished items against the total, and every row carries its status as its accessible name. |
| Output | The `deliverables` Turn data `ui-deliverables` publishes: the arguments of successful `write`, `edit`, and mutating `str_replace_editor` calls, never the closing prose. |

A produced path is listed once, at the position it first appeared, so a file written and then edited again is one row. A row shows the path's last segment, keeps the whole path as its title and its accessible name, and opens the file through its own tab's `openResource`, landing in the pane holding the panel.

<a id="when-it-opens"></a>
## When it opens

The panel is not the right Sidebar's default: the column ships collapsed with the guide tab, and a reader opens what they need. Its one exception is live work. The reveal watches the Session on screen and remembers whether its agent ran while that Session was on screen; with a run behind it, the Session's first progress — a standing checklist or a produced file — opens and expands the panel.

Progress alone is not enough. Opening a Session loads whatever its history holds, so gating on progress by itself would open the column for an old Session's files and on every reload, against the column's documented collapsed default. The run latch is what tells live work apart from loaded records, and it lasts only while that Session is on screen: returning to a Session with history reveals nothing.

The reveal happens once per Session and stops there, so progress that arrives later cannot reopen a panel the reader collapsed again. Reveal state is memory-only: a reload starts every Session collapsed, and only the plugin's own lifetime holds the set of Sessions it has revealed.

<a id="model-experience"></a>
## Model Experience

None, as the panel reads the checklist and Turn data other packages publish and registers nothing model-facing.

#### KV Cache effect

None; the panel assembles no request and sends nothing to a provider.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **The loaded window is the vocabulary.** Produced files come from the Turns the Chat target has loaded, so files from older Turns appear only once that history is loaded; the checklist comes from the host projection and is complete regardless.
- **First-party mutation tools only.** A file a terminal command wrote is not listed, because the produced-file vocabulary belongs to `ui-deliverables` and covers the mutation tools' own `locations`.
- **No checklist without the todo tool.** A composition without `dsh-tool-todo` publishes no `todos` key, so the Tasks section stays empty and the panel reveals only for produced files.
- **Read-only and unfiltered.** No per-file action beyond opening it, no search, no grouping, and no collapse of either section.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The panel owns one memory-only value — the set of Sessions it has revealed — and its only other state is the subscription it releases with its own effect; there is no second observation of either to compare against.
