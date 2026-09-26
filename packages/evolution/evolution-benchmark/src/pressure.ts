/**
 * Context pressure of one recorded session: how much of the model's context
 * window the session's own requests occupied. The occupancy is read from the
 * token meter's own projection (`contextPressure`), folded event by event, so
 * this module never re-derives occupancy from raw message text and a
 * compaction the session recorded is accounted for exactly as the projection
 * accounts for it. The fold reports the highest occupancy the session reached,
 * because a long-horizon run's risk is the ceiling it approached rather than
 * the level it happened to end on.
 * @module @deepseek-ai/dsh-evolution-benchmark/pressure
 */

import { contextPressureProjectionDefinition } from '@deepseek-ai/dsh-token-meter'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The read path every context-pressure reading cites. */
export const CONTEXT_PRESSURE_INPUT =
  'contextPressureProjectionDefinition (@deepseek-ai/dsh-token-meter) folded over the session\'s events'

/** The context occupancy one session reached. */
export interface ContextPressure {
  /**
   * Highest prompt-side tokens any of the session's requests occupied, cache
   * traffic included, as the projection projected it for the next request.
   */
  peakTokens: number
  /** Newest context window the session's requests reported; null when none did. */
  contextWindow: number | null
}

/**
 * Fold one session's events into the context occupancy it reached.
 * @param events - the session's events, in log order.
 * @returns the peak occupancy, or undefined when no request reported usage.
 */
export function contextPressureOf(events: readonly SessionEvent[]): ContextPressure | undefined {
  let state = contextPressureProjectionDefinition.init()
  let peakTokens: number | undefined
  let contextWindow: number | null = null
  for (const event of events) {
    state = contextPressureProjectionDefinition.apply(state, event)
    const view = contextPressureProjectionDefinition.wire.view(state)
    if (view.contextWindow !== undefined) contextWindow = view.contextWindow
    const tokens = view.projectedTokens ?? view.pressureTokens
    if (tokens === undefined) continue
    if (peakTokens === undefined || tokens > peakTokens) peakTokens = tokens
  }
  return peakTokens === undefined ? undefined : { peakTokens, contextWindow }
}
