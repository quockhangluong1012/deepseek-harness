# Agent Note: Workspace memory card and dialog UI

Status: implemented

English | [中文](2026-09-13-workspace-memory-card-and-dialog-ui.zh.md)

## Problem

The Workspace page's Instructions and Memory cards render their document through `.preview`, whose `-webkit-line-clamp` box reserves six lines of height even when the stored document is empty, leaving a blank band in the card. The edit and preview dialogs used the shared `Modal`'s default 380px card with an unbounded `resize: vertical` textarea: once a real instructions or memory document exists, the editor grows past the viewport, the clipped dialog pushes Save/Cancel out of reach, and the user can drag the handle to break the card further.

## Decision

An empty (or not-yet-loaded) document renders the card's localized empty label (`instructions.empty`, `memory.empty`) instead of an empty clamp box; a non-empty document keeps the six-line preview.

The three text-document dialogs (instructions edit, memory edit, memory markdown preview) pass owner-local classes to the shared `Modal`: `textDialog` widens the card to `min(680px, 100%)` and caps it at `calc(100dvh - 48px)` (with a `100vh` fallback), and `textDialogContent` makes the content region the scroll container (`min-height: 0; overflow-y: auto`) under the pinned footer, rebinding the l2 scrollbar thumb pair per the ui-theme rebinding contract. Inside those dialogs the editor adds `dialogEditor` on top of the page `editor` class: `field-sizing: content` with a `50vh` floor, no manual resize handle — matching the feedback dialog's field treatment. The in-page description and context-text editors keep their own sizing and `resize: vertical`.

No change to `ui-primitives` `Modal`: the primitive stays at its figma dialog geometry, and each owner overrides through the existing `className`/`contentClassName` seats, the same mechanism `RiskConfirmation` uses.

## Alternatives considered

**Move the width/scroll rules into the shared `Modal`.** Rejected because the 380px card is the design's dialog family for short forms (rename, create workspace, confirmation); every dialog becoming a scrollable wide card would regress those.

**Render the preview clamp only for non-empty documents without an empty label.** Rejected because the card then shows nothing between its head and foot for an empty document, which reads as a loading defect rather than an empty state; the page already labels every other empty section.

**Keep the resize handle inside the dialog.** Rejected because the handle lets the editor grow beyond the dialog's clipped box, which is how the broken layout was reproduced; growth belongs to `field-sizing`, scrolling to the content region.

## Consequences

The rail cards always state their content state, and long documents open in a readable-width dialog whose actions stay reachable. Empty-label keys join both locale dictionaries, so copy remains locale-owned. `field-sizing` degrades to the `50vh` floor plus inner scroll in engines without it.

## Verification

The [page specs](../../../../packages/client/ui-workspace-memory/tests/page.client.spec.tsx) cover the empty labels for blank documents, the verbatim preview for loaded ones, and the dialog card/content/editor class wiring through the rendered DOM. `pnpm run test:gui` runs them; browser replay owns the visible layout.
