# Agent Note: Workspace page composer band

Status: implemented

English | [中文](2026-09-10-workspace-page-composer-band.zh.md)

## Problem

[The live-composer decision](2026-09-10-workspace-page-live-composer.md) gave the Workspace page the conversation's resident composer instead of a hand-rolled ask box, and [the center-track page seat](2026-09-10-center-track-page-seat.md) put that composer at the column floor: the frame's page layer reserved the seat's published height at its own bottom edge, so the page read name/description → Outputs → chats → composer.

That is not where the composer belongs on this page. The page is modeled on a project page whose one editor is the hero: the name and description, then the composer, then the Workspace's outputs and its chats/activity list. The docked bar also lost the input card's top border: the card's stroke is its elevation hairline, drawn 0.5px *outside* the card's box, while the reserved band measured the seat's border box — so the page painted over the top row of the ring and left the card looking open-ended.

## Decision

The occupying page owns the composer band.

- **The identity row opens the content area.** The Workspace name, its canonical path, and the description form a content-sized row above the page's content columns on the same max-width and side pad as those columns, so a reader meets them above both the composer band and the rail, the free height belongs to the columns below, and the page has no separate header band and no control of its own to leave through — the sidebar's chats and Workspaces own that. The rail's first card opens on the composer's line.
- **The hero card is the page's column.** A page-occupied seat keeps no side clearance, so the input card and the preset chip above it carry the same left and right edges as the Outputs and Chats cards under them and the page reads as one column.
- **The page holds the band open.** `ui-workspace-memory` renders identity row → band → scrolling body. The band is `height: var(--dsh-composer-height)` — the seat's live height, already published by `ui-conversation` — so the body starts below the card and follows it as the draft grows.
- **The page publishes the band's box.** The band's top offset and its horizontal insets to the main column travel to `document.documentElement` as `--dsh-page-composer-top`, `--dsh-page-composer-left`, and `--dsh-page-composer-right`, the channel `--dsh-composer-height` already uses: the page and the conversation share only the document root. The offsets are measured against the body's content box, which reserves the same scrollbar gutter the conversation's scrollport does, so the seat lands exactly on the column the outputs and the chats fill. A `ResizeObserver` over the identity row, the main column, and the page re-publishes them, because the description wraps, the rail wraps under the column, and the frame resizes.
- **The seat docks into the band.** `.root[data-page-occupied] .composerSeat` takes the published top and side offsets as its margins and `margin-bottom: auto`, so the seat lands in the band, no wider than the main column, instead of absorbing the column's free space at the floor.
- **The seat reserves its own hairline and the band's top pad.** That same rule adds `padding-top: 24px`: the card clears the identity row, and the 0.5px ring the card draws outside its box sits inside the seat, so the page's identity row — or any future band edge — cannot clip it.
- **The band keeps the preset chip.** The page band is the blank-session hero's position, so `ConversationRoot` renders `conversation.hero.agentPreset` there, above the bar: the chip that stages the next session's composition. The Workspace picker stays a hero-only seat, because the page names its own Workspace in its identity row.
- **The frame's layer states no page geometry.** `.pageLayer` drops its bottom inset and stops forcing `pointer-events: auto` on its occupant. The page paints only the identity row and the body, leaves the band transparent and its own root click-through, and opts its two painted regions back in — which is what lets the composer painted underneath receive clicks in the band. The `shell.page` JSDoc states those obligations for every future occupant.

## Alternatives considered

- **Dock the bar at the top of the column and inset the layer from the top.** Two rules, no measurement. Rejected: the page's own identity row — Workspace name, path, description — would then sit below the composer, and the layout this page follows reads name/description → composer → body.
- **Keep the layer's bottom inset and reorder only the page's sections.** Rejected: the composer stays a footer, which is the complaint.
- **Render the composer into the page.** A slot key has one declarer, so a page can never render `conversation.composer.bar`; re-declaring that bar and its seven child holes under a page-owned key is the cost the live-composer note already refused.
- **Measure the identity row's height instead of the band's offset.** Equivalent today (nothing sits between them), but the band's own offset survives any later insertion above it without another measurement.

## Consequences

The page reads name/description → composer → body, and the composer keeps every seat — model, permission, mode, attachments, queue — because it is still the conversation's own editor driving the Workspace's blank Session.

The cost is a second cross-subtree measurement and a wider `shell.page` contract: an occupant that wants the composer must hold the band open, publish its top offset, keep the band transparent, and opt its own regions back into pointer events. An occupant that wants no composer simply paints its whole surface, as before. The band is a fixed strip: the page's body scrolls under it, and the composer never moves with that scroll, which is what keeps the seat aligned with the band at every scroll position.

## Testing

`apps/web/tests/workspace-memory-page.e2e.ts` opens the page over the real wire and asserts the seat's box lands level with the page's `[data-page-band]`, above the Outputs region and below the identity row, with no blank-session hero chrome on the page. `ui-conversation`'s occupied-track case keeps pinning the dropped hero chrome and the still-mounted seat; `ui-workspace-memory`'s page cases cover the identity row, band, and body as they render.
