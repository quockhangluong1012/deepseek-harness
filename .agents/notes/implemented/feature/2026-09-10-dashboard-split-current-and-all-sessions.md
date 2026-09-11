# Agent Note: Dashboard split — left-sidebar all-sessions overlay, right tab current-session only

Status: implemented

English | [中文](2026-09-10-dashboard-split-current-and-all-sessions.zh.md)

## Problem

The usage dashboard's single right-Sidebar tab mixed two audiences: the current session's live figures and the cross-session ledger totals shared one body, one filter, and one fetch lifecycle. Operators asking what one session spent had to look past window totals, charts, and model tables; operators asking what everything spent had no entry point outside the per-session right rail, which stays closed on the hero view and requires an open session to mount at all.

## Decision

Split the surface in `@deepseek-ai/dsh-client-ui-usage-dashboard`, keeping the ledger untouched ([prior note](2026-09-09-usage-dashboard.md)):

- The right-Sidebar `usage` tab keeps the current session only. Its body reads the session's `tokenUsage` and `sessionStats` projections into a live header plus cumulative stat cards, with no range filter and no Remote fetch.
- A `Dashboard` entry in `sidebar.footer.action` (wide row and 56px rail) opens a full-viewport overlay with the all-sessions figures: the today/7-day/30-day/all filter, window stat cards, the stacked UTC+7 daily chart, and the per-model table, read over the `usageDashboard` Remote namespace. The overlay dialog is a fixed-position descendant of the footer row (the Settings shell's precedent), so the change adds to the `sidebar.footer.action` list seat and keeps the keyed tab seat without replacing any occupant.
- Shared rendering (count formatting, bar geometry, summary cards/chart/table) lives in one `display.tsx` both bodies import; the dashboard store and generation-guarded face serve the overlay's single root-scoped bucket instead of per-tab session buckets.

## Alternatives considered

- **Center `conversation.view` tab for all sessions.** Rejected: a view tab is session-scoped and competes with Chat/Trajectory for the conversation header, while the all-sessions figures are session-independent. The overlay shows them with no session mounted.
- **`shell.overlay` seat for the dialog.** Rejected: the trigger and the dialog would be two registrations sharing one store across apply boundaries; the Settings precedent (modal as a fixed-position descendant of its own trigger) keeps trigger and dialog in one registration with component-local open state.
- **Right tab keeps the filter fixed to `all`.** Rejected: the filter selects a cross-session window, which is meaningless for cumulative single-session projections — removing the fetch removes the filter's only input.
- **One store handle for the session tab and the root overlay.** Rejected by the slot core's one-handle-one-scope rule; the session tab keeps no fetch state, so the handle serves the overlay alone.

## Consequences

Operators get both answers without navigating: per-session spend beside the conversation, totals behind one left-sidebar entry. The right tab costs no RPC; the overlay fetches one range per selection and reuses settled summaries on reopen. The trade is one more footer row and a modal layer over the frame while open.

## Testing

Client specs pin the session panel (live header, cumulative cards, no filter, no fetch) and the overlay (trigger wide/rail, open fetch, filter switch with settled reuse, empty frame, failure/retry beside settled data, close via button/mask/Escape, reopen without refetch). The apply spec pins both registrations and their disposal; the store, face, helper, and Host delegation specs are unchanged.
