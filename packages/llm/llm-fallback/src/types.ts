/**
 * Durable fallback vocabulary: the `llm/fallback` session event recorded
 * before one provider route switch. Types only — no runtime code.
 * @module @deepseek-ai/dsh-llm-fallback/types
 */

import type { LlmFailure } from '@deepseek-ai/dsh-llm'
import type { FallbackId } from './brand.ts'

/** Durable, non-surface record of one provider route switch after a failed request attempt. */
export interface LlmFallbackEventData {
  /** Stable identity shared by every switch in one step chain. */
  fallbackId: FallbackId
  /** Turn holding the failed attempt. */
  turn: number
  /** Step holding the failed attempt. */
  step: number
  /** Provider that served the failed attempt. */
  fromProvider: string
  /** Provider selected for the next attempt. */
  toProvider: string
  /** Model selected for the next attempt. */
  toModel: string
  /** Facts normalized at the final adapter boundary for the failed attempt. */
  failure: LlmFailure
  /** One-based switch count in this step chain. */
  attempt: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One provider route switch before a recovery retry. Log-only (never
     * model surface); the switched attempt logs its own `request/header`
     * with a change reason, so the route is reconstructable without reading
     * this event.
     */
    'llm/fallback': LlmFallbackEventData
  }
}
