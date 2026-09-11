# Agent Note: Composer overlays portal out and flip sides

Status: implemented

English | [中文](2026-09-10-composer-overlay-portal-and-flip.zh.md)

## Problem

The composer's two floating panels — the trigger menu (`ui-input-trigger`'s slash/`@` candidates) and the command popup (`ui-commands`' popupSelect) — rendered *inside* the composer card, in the `conversation.input.overlay` mount point, positioned by CSS against that card: `position: absolute; bottom: calc(100% + 4px)`. `useAnchoredMaxHeight` clamped their design cap to the space between the panel and the viewport top, so they always grew upward.

Two things break that under a center-track page. The page layer sits above the conversation's column — the column is deliberately isolated so a page wins the stacking order with a rank of one — so a panel drawn in place is covered by the page the moment it leaves the composer's band; the Workspace page's composer sits directly under the page header, and its dropdown appeared above the header and was gone. And a panel that opens upward from a card near the viewport top has almost no room: the clamp collapsed it to a sliver.

## Decision

Both composers' panels portal to the document body and pick their side from the room around the card.

- **Portal to the body.** Each view renders its panel through `createPortal(panel, document.body)`, so the panel is no longer inside the isolated column and no page can cover it. Dismissal moves with it: the trigger menu checks `anchorRef.current` (the composer card) instead of looking up a `[data-composer-card]` ancestor, which a portaled panel does not have.
- **The anchor arrives as an owner prop.** `conversation.input.overlay` now declares `owner: ComposerOverlayOwnerProps` — `anchorRef`, the composer card — and `InputBar` passes its own card ref. The panel is placed against that card rather than against the zero-height mount strip, which says nothing about where the panel should land.
- **One hook owns the placement.** `useFloatingPanel` replaces `useAnchoredMaxHeight` in `ui-primitives`: it hangs the panel from whichever side of the anchor has the room (below only when the space above is the smaller one), pins it with `left`/`width` so it matches the card, bottom-anchors it when it opens above and top-anchors it below, and clamps the height to the chosen side. It re-places on the caller's signal (the store state), on scroll, and on resize.
- **The fallback stays inside the viewport.** The panel's side is exposed as `data-side` and its surface keeps the design cap in CSS; the runtime clamp never exceeds it.

## Alternatives considered

- **Keep the in-place panel and clamp it harder.** Rejected: the page layer covers it wherever it lands outside the composer band, and a card with no room above has nothing to clamp to.
- **Raise the composer above the page layer.** Rejected: that means un-isolating the conversation's column and giving the page layer a rank ahead of the conversation's own z-indexes (up to 1100 for its dialogs) — the fragility the center-track page seat deliberately removed.
- **Measure only the room, not the side.** Rejected: this is exactly the case that failed — a sliver of a panel is worse than one below the card.
- **Give each view its own placement code.** Rejected: both panels share the anchor, the gap, the margin, and the cap, and they already shared the clamp hook.

## Consequences

The dropdown is usable from any composer position: it opens above when there is room, below when there is not, and never hides behind an occupying page. Two costs follow the portal: a panel is no longer in the composer's subtree, so anything that resolves an ancestor from it must be reachable through props (the dismissal check above), and its geometry is now fixed-position arithmetic rather than flow layout, which is what `useFloatingPanel` exists to own.

## Testing

`ui-input-trigger` and `ui-commands` render their views against a stubbed anchor rect and assert the chosen side, the fixed offsets, the viewport clamp, and the re-placement on resize; `apps/web/tests/workspace-memory-page.e2e.ts` opens the composer's command menu over the real page and asserts it lands below the card, inside the viewport, and outside the page's own subtree.
