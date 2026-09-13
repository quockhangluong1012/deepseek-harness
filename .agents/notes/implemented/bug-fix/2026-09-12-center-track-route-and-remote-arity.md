# Agent Note: one center-track route and Remote calls that match their Host contract

Status: implemented

English | [中文](2026-09-12-center-track-route-and-remote-arity.zh.md)

## Problem

Two defects surfaced when the [evolution journey page](../feature/2026-09-12-evolution-client-ui.md) ran against the real Host instead of the client fixture.

The page's hand-written Remote face declared a trailing `AbortSignal` on `evolution/timeline` and `evolutionCurator/status` that neither Host method takes. The Client API counts arguments against the generated Host contract before it sends anything, so both calls failed at the call site — `client api: evolutionCurator/status expected 0 argument(s), got 1`, and the same failure for `evolution/timeline`, whose one-argument Host method received two. The page keeps one error slot, so the reader saw only the last of the two, and the timeline card fell back to the empty state that reads as "no recorded activity" rather than "the read never ran".

The journey panel and the Workspace page also claimed the center track at once. The journey page registers additively in the `main` seat (a `sidebar.panellist` row plus its keyed entry), while the Workspace page occupies `shell.page`, which the frame paints as an overlay above the center column. Neither route knew about the other: selecting the journey panel left an open Workspace page drawn on top of it, and opening the Workspace page left a selected panel beneath a page that also hides the composer band the page expects the conversation to dock.

## Decision

**A hand-written client face mirrors its generated namespace exactly, cancellation included.** `packages/client/ui-evolution/src/client/rpc.ts` declares the five `evolution` verbs and `evolutionCurator/status` at the Host's own arity, and the page issues them without a caller signal. Cancellation belongs to the Host's declaration: the TypeScript face is written by hand, so nothing but the contract itself rejects an argument the Host never accepted.

**The center track shows one route at a time.** Both directions of that rule live on the navigation faces rather than in the frame:

- `UiWorkspace.showPanel(panelId)` closes the Workspace page before selecting the panel, as `openSession` and `startSession` already vacate it. The sidebar's panel rows reach it through the `uiWorkspace` face they already inject.
- The Workspace page opener — `ui-workspace`'s browser injection over the `workspacePage` seam — clears the panel selection with `ctx.layout.selectPanel(null)` before the page takes the track.

## Alternatives considered

**Add the trailing `signal` to the Host's `timeline` and `status` methods.** Rejected: neither method aborts anything — `timeline` folds the recorded scope synchronously and `status` reads the curator's ledger — so the parameter would be decorative, and the generated face, not the caller, is the contract.

**Interrupt the Workspace page from `AppFrame` while a global panel is selected.** Rejected: the page's open state lives in the `workspacePage` seam, so hiding the page layer would leave that state claiming a route the frame refuses to draw; returning to the Conversation would resurrect a page the reader never reopened, and the page's controller state would be discarded on every panel visit.

**Give the journey page its own `shell.page` seat.** Rejected: `shell.page` is single-occupancy and the Workspace page owns it, so a second conditional occupant collides with the sibling's own registration path (recorded in the [journey page note](../feature/2026-09-12-evolution-client-ui.md)).

**Move the exclusivity rule into the layout service.** Rejected: `shell.page` occupancy is page-plugin state reached through the `workspacePage` seam, and the layout service exposes panel actions rather than a panel-selection observable, so the shell would need a new read API to satisfy one feature route.

## Consequences

Selecting any global panel now closes an open Workspace page, and any other route into the center — the Workspace name, a Session row, New Session — clears the selected panel. The two seats agree on which route the track shows: the sidebar highlight follows the panel, and a page that loses the track is closed rather than merely hidden.

The journey page no longer opens a cancellation channel the Host does not honor. A read still in flight when the reader switches Scope completes and is dropped by the page's own generation guard.

The rule is enforced at the navigation writers rather than at the seats, so a future caller of `ctx.layout.selectPanel` outside `uiWorkspace.showPanel` — or a page opener that bypasses `ui-workspace`'s browser injection — would reintroduce the overlay. Those writers are the sidebar's panel rows and the Workspace browser today.

## Testing

`packages/client/ui-evolution/tests/rpc.client.spec.ts` pins every bound verb's request shape at the Host's arity. `packages/client/ui-workspace/tests/workspaces-service.client.spec.ts` pins that `showPanel` closes the page before selecting the panel and that a composition without the page plugin still selects it. `packages/client/ui-workspace/tests/workspace-page-opener.client.spec.tsx` pins the panel vacate on the Workspace-name gesture.
