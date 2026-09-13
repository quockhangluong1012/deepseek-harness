# Agent Note: Workspace page top inset

Status: implemented

English | [中文](2026-09-12-workspace-page-top-inset.zh.md)

## Problem

[The composer band decision](2026-09-10-workspace-page-composer-band.md) gave the docked composer seat `padding-top: 24px` so the page's identity row cleared the input card and the card's 0.5px elevation ring stayed inside the seat's box. On the shipped page that pad is the bulk of the strip between the description and the preset row: the identity row already ends 40px above the band (its own 16px bottom pad plus the page's 24px gap), so the pad doubles the space above the composer and the strip reads as an empty hole in the page rather than as spacing.

The same page had no inset of its own. `.page` opens at the center track's top edge, so the Workspace name sat against the frame's top edge; the frame's page layer states no page geometry, and nothing above the identity row supplied one.

## Decision

The page owns its own top inset, and the docked seat carries none.

- **`.page` takes the inset.** `padding-top: 20px` with `box-sizing: border-box`. The border-box is required, not cosmetic: the page is `height: 100%` inside the page layer, which clips at the track's height, so content-box padding would draw the page 20px taller than the track and clip the floor of the body and the rail.
- **The docked seat drops its pad.** `.root[data-page-occupied] .composerSeat` no longer sets `padding-top`. The seat's box top stays level with `[data-page-band]`: the page publishes the band's own `offsetTop`, so an inset above the identity row moves the band and the seat down together, and the page's band height still reads back the seat's exact height.
- **The card's ring keeps no reserved margin.** The band's strip is transparent in the page's layout and the seat's ancestors carry no clipping box at its top edge, so the 0.5px ring the card draws outside its box stays visible; while the preset seat is filled — as every shipped composition fills it — the band's first row keeps the card 36px below the seat's top edge.

## Alternatives considered

- **Keep the pad and drop the page's 24px gap between the identity row and the columns.** Rejected: that gap also separates the identity row from the rail's first card, which the seat's pad never touched, so the rail would move up while the composer stayed put.
- **Move the inset onto `.introRow`.** Same pixels from one property and no `box-sizing` question. Rejected: the page's frame inset would live on its first row instead of on the page, and a later page opening with a different row would restate it.
- **Keep a hairline-sized pad on the seat (1–2px).** Rejected: the strip is transparent, so a pad that small buys no clip protection while leaving a measured box the page's band offsets must carry.

## Consequences

The page's first paint clears the track's top edge by 20px, and the composer follows the band. The strip between the description and the preset row is the page's own spacing — the identity row's 16px bottom pad plus the page's 24px gap, 40px — instead of that spacing plus a pad the seat added on top of it. The seat's painted box shrinks by the pad's height, which is the height the page reads back for the band.

The cost is the ring's explicit reservation: the seat keeps no margin above the card, so a composition that leaves `conversation.hero.agentPreset` empty and paints an opaque region at the band's top edge would have to give the ring its own clearance again.

## Testing

`apps/web/tests/workspace-memory-page.e2e.ts` opens the page over the real wire and measures the boxes in chromium: the identity row's heading clears the page box by the inset, the seat's box lands level with `[data-page-band]`, and the input card sits above the Outputs region with a band-to-card distance that fits the preset row and the stack gap, not a pad.
