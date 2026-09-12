# Agent Note: Usage chart hover — column band and per-day totals bubble

Status: implemented

English | [中文](2026-09-11-usage-chart-hover-totals.zh.md)

## Problem

The all-sessions overlay's stacked daily chart ([split note](2026-09-10-dashboard-split-current-and-all-sessions.md)) encoded one figure per day — that day's input and output tokens — and read out none of them. The window cards above it total the whole range and the table below totals per model, so a day's own numbers existed only as bar height. The panel's insets were tight as well: sections, stat cards, range buttons, and table cells all sat at 10–12px, which the split's extra sections made read as cramped.

## Decision

Make each chart column a hover readout in `packages/client/ui-usage-dashboard/src/client/display.tsx` and widen the dashboard's shared padding in `UsageDashboard.module.css`:

- Every column is a hover target spanning the full chart height. The pointed column gets a translucent band behind its bars and an HTML bubble anchored to that column showing the bucket's `day` and its total input and output tokens.
- The band renders first, under the bar segments; transparent hit rects render last, above them, so the empty part of a short column is as hoverable as its drawn segments. Leaving the chart wrapper clears both.
- The bubble grows from the column's centre toward the nearer chart edge (`data-anchor` `start`/`end`) instead of centring on the column, so an end column's bubble stays inside the scroller; `pointer-events: none` keeps the bubble from holding the hover it reports.
- The bubble reuses the tooltip surface (`--dsw-alias-tooltip-bg` with `--dsw-static-neutral-bluish-00` text, muted day line) and the existing `chart.input`/`chart.output` dictionary keys, so no locale entry was added. The day renders as the ledger's own UTC+7 `YYYY-MM-DD` string, not a locale-formatted date.
- Padding moves in the shared module, so the right-Sidebar current-session body and the overlay body stay one design: sections 14px 16px, stat cards 10px 12px with a 10px gap, range buttons 4px 12px, table cells 6px 8px, loading/failure block 20px 16px.

## Alternatives considered

- **`Tooltip` from `ui-primitives` on each column.** Rejected: it wraps one anchor element and positions a fixed bubble from that anchor's rect, so a 31-day window would carry 31 anchors, handlers, and refs, and its label is fixed per anchor. The chart keeps one hovered index and one bubble instead.
- **SVG `<text>` inside the chart.** Rejected: the SVG holds a fixed 300×96 viewBox stretched to the pane width, so text would scale with the pane, and a two-row labeled bubble would need per-column width math inside the viewBox.
- **Native `<title>` per column.** Rejected: browsers delay it by about a second and render one plain-text line, which cannot carry the day and two labeled totals.
- **Per-day figures as a new table column.** Rejected: the table is one row per model over the whole window, so a per-day column does not fit its subject; the chart is where the per-day question is already asked.
- **Padding the right tab only.** Rejected: both bodies render the same sheet, and padding one of them would split the two surfaces apart for no contract reason.

## Consequences

The chart becomes its own per-day readout: pointing at a column answers what that day spent, at the cost of one tooltip surface in the module and the hover band's extra rects per day. The readout is pointer-only — no keyboard path and no touch gesture — and it is the only per-day copy: the cards total the window and the table totals per model, so no second surface can drift out of step with it. The bubble is a fixed 11px line at the chart's top, so a tall bar's tip sits behind it. Wider insets shrink the usable width in the narrow right rail, where the stat cards wrap into more rows.

## Testing

`tests/dashboard-action.client.spec.tsx` drives the real overlay through `DashboardAction`: it opens the dialog, points at each of the two fixture days, and pins the band's day, the bubble's key-echoed totals for that day, the switch to the other day, and the cleared band and bubble on leaving the chart.
