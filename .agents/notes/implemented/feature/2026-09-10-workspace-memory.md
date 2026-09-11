# Agent Note: Workspace Memory — Instructions / Memory / Context

Status: implemented

English | [中文](2026-09-10-workspace-memory.zh.md)

## Problem

Sessions in one directory shared nothing durable: author-written project rules lived in scattered `AGENTS.md` files with no per-Workspace home, model-learned knowledge evaporated at Session end, and attached files had to be re-pasted every turn. Workspaces were navigation only — invisible to models, with no prompt cost and no page of their own.

## Decision

Ship four packages per [`specs/workspace-memory.md`](../../../../specs/workspace-memory.md), split on dependency policy and compiler faces:

- `@deepseek-ai/dsh-workspace-memory` (workspace group) owns the durable record on the `workspace_memory` domain (`per-record`, version 1, fail-loud on corrupt records): description, instructions, memory with `memoryUpdatedAt`, newest-last context items, newest-first outputs capped by `maxOutputs`, and `lastExtraction` provenance. Reads are synchronous; `capacityBytes` is required; every other cap is a validated `Config` field. Capacity charges instructions plus memory plus item sizes; the digest covers only those three, so description and output writes never re-inject.
- `@deepseek-ai/dsh-workspace-memory-llm` (workspace group) owns derivation behind `ctx.workspaceMemoryExtractor`: always-on output indexing from `turn/end` tool calls, gated per-turn extraction on a per-Workspace promise chain, and on-demand `rebuild` over the newest sessions via `sessionQuery.filterEvents`. Calls are deterministic (`temperature: 0`, `purpose: 'workspace-memory'` with reasoning disabled) and fail-soft into a warning.
- `@deepseek-ai/dsh-workspace-memory-context` (context group) renders the single `<system-reminder>` brief and splices it into `agent/pre-step`, replacing on digest change within the `maxBytes` budget (context drops first, then memory, then instructions).
- `@deepseek-ai/dsh-client-ui-workspace-memory` (client group) owns the Host `workspaceMemory` Remote namespace and the browser Workspace page in the frame's center-track `shell.page` seat ([decision](../architecture/2026-09-10-center-track-page-seat.md)), plus the `workspacePage` opener that `ui-workspace` consumes optionally — the sidebar name opens the page while the disclosure button keeps the toggle. Page-relative output directories compare both separators alike, so a Windows Workspace (`C:\proj`) still matches backslash output paths.

`GenerateOptions.purpose` gains `'workspace-memory'` beside `'compaction'` and `'session-title'`, with reasoning disabled in `dsh-llm-deepseek` as for session titles. Composition rows land in the `web-app` bundle only, so headless, sdk, and acp Sessions never carry a brief and recorded-session snapshots stay byte-identical.

## Alternatives considered

- **One package holding store, extraction, injection, and UI.** Rejected by the client/host dependency policy and compiler faces: the store needs storage-domain, the extractor needs the LLM seam, the injector needs the agent loop, and the page needs the browser face. Four packages keep each dependency edge classifiable.
- **A new session event for the brief.** Rejected: the brief rides the existing durable `user/message` with a typed `workspace-memory` source, so replay, compaction, and `model-visible ⟺ logged` hold with no format change.
- **Per-entry memory with provenance and history.** Rejected for v1: a single capped markdown document needs no second storage tier and stays directly editable; the card, `setMemory`, and extractor merge are the only touch points for a future array form.
- **Storing records inside the project directory.** Rejected: machine-local storage under `$DSH_HOME` needs no project write permission; a future committable form keeps the store API and swaps the domain.
- **Leaving the row click as toggle with a context-menu entry.** Rejected: the requested gesture is name-opens-page with a dedicated disclosure button, at the cost of the recorded test and snapshot churn.

## Consequences

Every Session in a Workspace inherits shared knowledge at a deployment-chosen per-request cost, and the Workspace gains a page (description, outputs, chats/activity, three cards). Costs: one more storage domain, one background LLM call per gated turn, and a replacement brief per edit accumulating superseded messages in the log. File context is re-read per request and its recorded size is a snapshot.

## Testing

Store specs pin caps, capacity, digest coverage, output idempotence, and no-reference-leak reads over the real storage/domain stack. Render specs pin the byte cap, drop order, notice line, and frame escaping. Extractor specs pin config pairing, JSON framing, route precedence, and silence after teardown. The page spec pins closed-render-nothing, three cards open, busy regenerate, and `too-large` card copy; the sidebar change keeps `treeitem`/`aria-expanded` with the toggle moved to the disclosure button, and every registering package drops its pre-step listener, slot entry, or Remote namespace on disposal. `snapshots/web/workspace-memory` replays the real page over the wire and diffs its aria golden, while headless recorded sessions stay byte-identical.
