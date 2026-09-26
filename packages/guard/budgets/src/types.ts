/**
 * Durable budget vocabulary: the ceiling table the guard and the
 * `budget/exceeded` payload share, plus the payload itself. No behavior —
 * `index.ts` owns the guard.
 * @module @deepseek-ai/dsh-budgets/types
 */

/** Which budget a ceiling bounds. */
export type BudgetScope = 'turn' | 'context' | 'session' | 'run'

/** How one ceiling is measured. */
export type CeilingMeasure = 'calls' | 'clock' | 'tokens' | 'cost' | 'pressure'

/**
 * Every ceiling, in the order the guard evaluates them: the counters and clocks
 * first, then billed spend, then the context measurement, so a step already over
 * a cheaper ceiling never pays for a replay of its log.
 *
 * `clock`, `tokens`, and `cost` ceilings come in turn, session, and run scopes;
 * `calls` and `pressure` bound one turn. A cost ceiling prices billed spend, so
 * it is unmeasurable until the deployment states a price.
 */
export const CEILINGS = {
  maxToolCalls: { scope: 'turn', measure: 'calls' },
  maxWallMs: { scope: 'turn', measure: 'clock' },
  maxSessionWallTime: { scope: 'session', measure: 'clock' },
  maxRunWallTime: { scope: 'run', measure: 'clock' },
  maxInputTokens: { scope: 'turn', measure: 'tokens' },
  maxOutputTokens: { scope: 'turn', measure: 'tokens' },
  maxTotalTokens: { scope: 'turn', measure: 'tokens' },
  maxCostUsd: { scope: 'turn', measure: 'cost' },
  maxSessionTokens: { scope: 'session', measure: 'tokens' },
  maxSessionCost: { scope: 'session', measure: 'cost' },
  maxRunTokens: { scope: 'run', measure: 'tokens' },
  maxRunCost: { scope: 'run', measure: 'cost' },
  maxContextTokens: { scope: 'context', measure: 'pressure' },
} as const satisfies Record<string, { readonly scope: BudgetScope; readonly measure: CeilingMeasure }>

/** One ceiling a deployment can configure, named by its `Config` field. */
export type CeilingName = keyof typeof CEILINGS

/** Every ceiling name, in {@link CEILINGS} order. */
export const CEILING_NAMES = Object.keys(CEILINGS) as readonly CeilingName[]

/**
 * How one ceiling reads in a `budget/exceeded` record: the configured limit, or
 * the literal state it has instead — `'unbounded'` when the deployment left it
 * unset, `'unmeasurable'` when no price resolves for it.
 */
export type CeilingState = number | 'unbounded' | 'unmeasurable'

/** Durable payload of one `budget/exceeded` event. */
export interface BudgetExceededEventData {
  /** The budget the reached ceiling bounds: one turn, the session, one run, or the context. */
  scope: BudgetScope
  /** The reached ceiling's configuration field name. */
  name: CeilingName
  /** The value the guard compared, which reached {@link limit}. */
  observed: number
  /** The configured limit {@link observed} reached. */
  limit: number
  /**
   * Every ceiling as this deployment configured it, so a reader can tell a
   * bound that was met from one that was never set (`'unbounded'`) or could not
   * be measured (`'unmeasurable'`).
   */
  ceilings: Readonly<Record<CeilingName, CeilingState>>
  /** The turn whose proposed step the guard rejected. */
  turn: number
  /** The rejected step's number within {@link turn}. */
  step: number
  /** Run the reached ceiling belongs to; present exactly when {@link scope} is `'run'`. */
  runId?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One rejected step at a reached ceiling, written immediately before the
     * rejection. Log-only (never model surface): the cut is still visible as
     * the turn's `blocked` end, so this event only adds what that reason and
     * the host warning cannot carry into the log — the budget and ceiling, the
     * observed value, the limit, and every other ceiling's configured state.
     */
    'budget/exceeded': BudgetExceededEventData
  }
}
