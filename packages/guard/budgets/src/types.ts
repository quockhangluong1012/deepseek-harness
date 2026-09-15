/**
 * Durable budget vocabulary: the `budget/exceeded` session event recorded when
 * a turn reaches a configured ceiling, plus the ceiling names the guard and the
 * payload share. No behavior — `index.ts` owns the guard.
 * @module @deepseek-ai/dsh-budgets/types
 */

/** Every ceiling name, in the order the guard evaluates them. */
export const CEILINGS = ['maxTotalTokens', 'maxToolCalls', 'maxWallMs', 'maxCostUsd'] as const

/** One ceiling a deployment can configure, named by its `Config` field. */
export type CeilingName = typeof CEILINGS[number]

/** Durable payload of one `budget/exceeded` event: the ceiling that stopped a turn, the value it compared, and the step it rejected. */
export interface BudgetExceededEventData {
  /** The reached ceiling's configuration field name. */
  name: CeilingName
  /** The value the guard compared, which reached {@link limit}. */
  observed: number
  /** The configured limit {@link observed} reached. */
  limit: number
  /** The turn whose proposed step the guard rejected. */
  turn: number
  /** The rejected step's number within {@link turn}. */
  step: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One rejected step of a turn at a reached ceiling, written immediately
     * before the rejection. Log-only (never model surface): the cut is still
     * visible as the turn's `blocked` end, so this event only adds what that
     * reason and the host warning cannot carry into the log — the ceiling, the
     * observed value, and the limit.
     */
    'budget/exceeded': BudgetExceededEventData
  }
}
