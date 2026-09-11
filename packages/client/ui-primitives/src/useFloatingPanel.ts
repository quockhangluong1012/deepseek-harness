/**
 * Placement for the composer's floating panels — the command popup and the
 * slash menu.
 *
 * Both render into `conversation.input.overlay`, which sits inside the
 * composer card, and the conversation's column is isolated beneath the frame's
 * page layer: a panel drawn in place is covered by any page occupying the
 * centre track the moment it leaves the composer's own band. Both views
 * therefore portal their panel to the document body, and this hook owns the
 * geometry that costs them once portaled — hang the panel from whichever side
 * of the composer card has the room, clamp its height to that side, and keep
 * it inside the viewport as the composer grows, the window resizes, or the
 * page scrolls.
 *
 * The panel is fixed rather than measured: above the anchor it is bottom-
 * anchored, below it top-anchored, so the panel's own height never feeds back
 * into its placement. Only the height cap depends on the chosen side.
 * @module @deepseek-ai/dsh-client-ui-primitives/useFloatingPanel
 */

import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** Gap kept between the panel and the composer card. */
const GAP = 4

/** Safe distance kept between the panel and every viewport edge (mirrors the Menu portal margin). */
const MARGIN = 12

/** Side the panel hangs from: above the composer card when that side has the room, below it otherwise. */
export type FloatingPanelSide = 'above' | 'below'

/** One placement: the chosen side and the fixed-position style to spread on the portaled panel. */
export interface FloatingPanelPlacement {
  /** Chosen side; the panel's own CSS may key its surface on it. */
  side: FloatingPanelSide
  /** `left`, `width`, the vertical anchor, and the height cap, all in px. */
  style: CSSProperties
}

/** Inputs for {@link useFloatingPanel}. */
export interface FloatingPanelOptions {
  /** Whether the panel is mounted and should track its anchor. */
  open: boolean
  /** The composer card the panel hangs from. */
  anchorRef: RefObject<HTMLElement | null>
  /** Design maximum height in px; the clamp never exceeds it. */
  cap: number
  /** Re-measure trigger: pass the panel's render state so anchor moves (composer growth) re-fit. */
  signal: unknown
}

/**
 * Place the composer's portaled panel against its anchor.
 * @param options - open state, the composer card's ref, the height cap, and the re-measure signal.
 * @returns the placement while open, or `null` before the first measurement.
 */
export function useFloatingPanel(options: FloatingPanelOptions): FloatingPanelPlacement | null {
  const { open, anchorRef, cap, signal } = options
  const [placement, setPlacement] = useState<FloatingPanelPlacement | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null)
      return
    }
    const place = () => {
      /* v8 ignore start -- geometry read from real layout: jsdom reports zero
         offset sizes, so the placement arms are exercised by browser scenarios
         rather than unit tests. */
      const anchor = anchorRef.current?.getBoundingClientRect()
      if (anchor === undefined) return
      const roomAbove = anchor.top - GAP - MARGIN
      const roomBelow = window.innerHeight - anchor.bottom - GAP - MARGIN
      const side: FloatingPanelSide = roomBelow > roomAbove ? 'below' : 'above'
      const room = Math.max(0, Math.min(cap, side === 'above' ? roomAbove : roomBelow))
      const width = anchor.width
      const left = Math.min(
        Math.max(anchor.left, MARGIN),
        Math.max(MARGIN, window.innerWidth - width - MARGIN),
      )
      setPlacement({
        side,
        style: side === 'above'
          ? { left, width, bottom: window.innerHeight - anchor.top + GAP, maxHeight: room }
          : { left, width, top: anchor.bottom + GAP, maxHeight: room },
      })
      /* v8 ignore stop */
    }
    // The first run measures in the same commit that opened the panel, so the
    // cap is already right before anything paints.
    place()
    // Capture phase: scrollers nested inside the page are caught too.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, anchorRef, cap, signal])
  return placement
}
