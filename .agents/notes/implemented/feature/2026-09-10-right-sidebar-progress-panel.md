# Agent Note: Right-Sidebar progress panel

Status: implemented

English | [中文](2026-09-10-right-sidebar-progress-panel.zh.md)

## Problem

A session's work state is scattered across surfaces that answer narrower questions. The checklist lives in a composer dock strip that starts collapsed and shows only a count header until the reader expands it; produced files appear under the closing message of each Turn that wrote one. "What is this session doing, and what has it produced so far" therefore costs scrolling, and the right Sidebar — the column built for exactly this kind of session-level view — ships collapsed with a guide page and offers no progress surface at all.

## Decision

A new browser plugin package, `@deepseek-ai/dsh-client-ui-progress`, contributes one right-Sidebar tab type (`kind: progress`, id `@deepseek-ai/dsh-client-ui-progress`) and the web-app bundle loads it beside `ui-sidebar-files`.

- **It publishes nothing.** The body reads two facts other packages already publish: the host-computed `todos` projection for the checklist, and the `deliverables` Turn data `ui-deliverables` publishes for every Turn that mutated files. No new session event, no new projection unit, no new Remote namespace, no store, and no injected face — the component receives everything through the framework's Session hooks.
- **It draws two sections.** Tasks first (each row carries its status as its accessible name; a check for finished, a dashed ring for pending, the same ring turning while in progress; the header counts finished against total), then Output: produced paths in first-seen order, once per path, each row showing the path's last segment and opening the file through the tab's own `openResource` with an address from `fileAddressFor`.
- **It reveals itself once per Session, while the agent works.** `auto-open.ts` watches `ctx.sessions.list`'s current selection and follows that Session's binding — its own lifecycle snapshot, its `todos` projection face, and its Chat target. The panel opens and expands at the first progress of a Session whose agent ran while that Session was on screen; the run is latched, so a fast turn that ends before its file reaches the client still reveals. The follow is released when the selection moves, and stops as soon as it has opened, so progress that arrives later cannot reopen a panel the reader collapsed again. The only memory is the set of revealed Sessions.
- **It occupies existing slots.** No `SlotMap` key is added: the body registers into the keyed `sidebar.right.pane.tab` seat under the type's id, and the guide entry (order 30) gives the type a manual open path beside the shipped ones.

## Alternatives considered

- **Duplicate the mutation vocabulary in the new package.** Rejected: `write`/`edit`/mutating `str_replace_editor` argument parsing and its result correlation already exist in `ui-deliverables`, and a second definition would drift. The export-discipline rule forbids one feature plugin importing another's runtime values, so the panel reads the Turn data that plugin publishes — a type-only merge of `ConversationTurnDataMap`.
- **A new host projection for produced files.** Rejected: the vocabulary is client-side and per-Turn by design (the web layer derives it from raw call/result events, never from the closing prose); a host unit would duplicate that parsing, add a wire key, a schema, and a version, and buy only the aggregate this panel computes from the window it already has.
- **Auto-open on send.** Rejected: the right column takes a large share of the viewport, and opening it before the session has anything to report shows an empty panel on every new conversation.
- **Revealing on progress alone, without the run.** Rejected: opening a Session loads whatever its history holds, so the column would open by itself on every reload and every return to an old Session — the right Sidebar's documented default is that a reload starts every Session collapsed. Gating on a run that happened while the Session was on screen tells live work apart from loaded records without a persisted flag.
- **A hidden always-mounted sentinel component in an existing seat to trigger the reveal.** Rejected: it would occupy a seat that means something else (header actions, composer dock) to run a side effect; the same facts are reachable from the apply world through the services that own them.
- **Seeding `progress` as a pane's default tab instead of the guide.** Rejected: it changes the default surface of every Session and every other tab type to serve one panel.
- **Rendering the reveal from the tab body.** Rejected outright: a tab body only exists while its tab is open, so it cannot be what opens the tab.

## Consequences

The panel adds no model-visible input: no prompt section, no tool schema, no session event, so it has no token or KV-cache effect and no durable or wire format change. It costs the composition one plugin row and one guide entry.

Two limits follow from where the facts come from. The Output list covers the Turns the Chat target has loaded, so older history appears only once it is loaded; and following the Chat target activates it for that Session, which means the Chat target builds for Sessions the reader visits even when they watch another view (the documented route for a second consumer of a target). Both are recorded in the package README.

The reveal's memory is the plugin's own: a reload starts every Session collapsed, a Session whose checklist stays empty and whose Turns produce nothing never opens the panel, and a Session the reader collapsed again stays collapsed.

## Testing

Client specs pin the two derivations (Turn-order gathering, first-seen dedupe, absent Turn data and rows), the reveal policy (once per Session, latched per run, released on selection change, retried while a binding is not live, inert without a selection, released on dispose), the registrations and the reveal wiring against a real tab registry, and the panel's rendering, counts, file addresses, and open call.

`apps/web/tests/progress-panel.e2e.ts` drives the recorded workspace-write conversation in a real Chromium and asserts the shipped behavior end to end: the column is closed while the conversation runs, the write opens it by itself on a Progress tab, the row carries the produced path, and clicking it lands in the Sidebar's text preview with the file's contents. `apps/web/tests/sidebar-right.e2e.ts` (the column's own acceptance) passes unchanged, which is the check that loaded history and in-process Session seeding do not open the column.
