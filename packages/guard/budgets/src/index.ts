/**
 * Per-turn budget guard. It observes each turn's `turn/start` and dispatched
 * tool calls on `session/event` and evaluates the configured ceilings on
 * `agent/pre-step`; a reached ceiling records the durable `budget/exceeded`
 * event and rejects the proposed step without calling `next()`, and the loop
 * closes the turn with its existing `blocked` reason. A step that claims a
 * human message always enters, so a budget never discards user input.
 * Configuration and deferred work live in the package README; rationale lives
 * in the guard-budgets Agent Note.
 *
 * @module @deepseek-ai/dsh-budgets
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: activates the `ctx.tokenMeter` Context declaration.
import type {} from '@deepseek-ai/dsh-token-meter'
import z from '@deepseek-ai/schemastery'
import { CEILINGS } from './types.ts'
import type { BudgetExceededEventData, CeilingName } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'budgets'

/** The token-measurement service (`ctx.tokenMeter`) that the token ceiling reads. */
export const inject = ['tokenMeter']

/**
 * Plugin configuration. Every ceiling is optional, and an unset ceiling is
 * off, so a plugin mounted with no configuration never rejects a step.
 * Misconfiguration fails loud at plugin load: a non-positive or non-finite
 * value throws instead of silently disabling the ceiling it names.
 */
export interface Config {
  /** Ceiling on the measured request pressure of one step, compared before that step. */
  maxTotalTokens?: number
  /** Ceiling on tool calls dispatched in one turn, compared before the next step. */
  maxToolCalls?: number
  /** Ceiling on one turn's wall-clock duration in milliseconds, measured from its `turn/start`. */
  maxWallMs?: number
  /**
   * Ceiling on one turn's measured cost in USD, compared before that step.
   * Priced at `usdPerMillionTokens`, which must be set alongside it.
   */
  maxCostUsd?: number
  /**
   * Deployment price of one million measured tokens in USD. The harness has
   * no pricing source of its own, so the deployment names what its model
   * costs; without a cost ceiling it is inert.
   */
  usdPerMillionTokens?: number
}

/** Runtime configuration schema for the budgets plugin. */
export const Config: z<Config> = z.object({
  maxTotalTokens: z.number(),
  maxToolCalls: z.number(),
  maxWallMs: z.number(),
  maxCostUsd: z.number(),
  usdPerMillionTokens: z.number(),
})

/** One turn's observed activity: its number, when it started, and how many tool calls it dispatched. */
interface TurnFacts {
  /** Turn number taken from the `turn/start` this entry was created by. */
  turn: number
  /** Unix epoch milliseconds of that `turn/start` event. */
  startedAt: number
  /** Tool calls observed for this turn so far. */
  toolCalls: number
}

/** One ceiling a turn has reached, with the observed value and the configured limit. */
interface ReachedCeiling {
  name: CeilingName
  observed: number
  limit: number
}

/**
 * Reject any configured ceiling that a comparison could never reach. A value
 * that is not a positive finite number would silently disable its ceiling, so
 * it fails plugin load instead.
 * @param config - validated plugin configuration.
 */
function validateCeilings(config: Config): void {
  for (const key of CEILINGS) {
    const value = config[key]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`budgets: ${key} must be a positive finite number, got ${String(value)}`)
    }
  }
  const { maxCostUsd, usdPerMillionTokens } = config
  if (maxCostUsd !== undefined && usdPerMillionTokens === undefined) {
    throw new Error('budgets: maxCostUsd needs usdPerMillionTokens, the deployment price of one million measured tokens')
  }
  if (usdPerMillionTokens !== undefined && (!Number.isFinite(usdPerMillionTokens) || usdPerMillionTokens <= 0)) {
    throw new Error(`budgets: usdPerMillionTokens must be a positive finite number, got ${String(usdPerMillionTokens)}`)
  }
}

/**
 * The first configured ceiling this turn has reached, or undefined when no
 * ceiling is configured or none is reached. Tool calls and wall clock are
 * compared before the token measurement so a turn already over a cheaper
 * ceiling never pays for a replay of its log. The token and cost ceilings read
 * the meter's request measurement, which is context pressure rather than
 * settled spend; see this package's README.
 * @param ctx - plugin context providing `tokenMeter`.
 * @param config - validated plugin configuration.
 * @param session - session whose measured pressure the token ceiling compares.
 * @param facts - the turn's observed activity.
 * @returns the reached ceiling with its observed value and limit, or undefined.
 */
function reachedCeiling(
  ctx: Context,
  config: Config,
  session: Session,
  facts: TurnFacts,
): ReachedCeiling | undefined {
  const { maxToolCalls, maxWallMs, maxTotalTokens, maxCostUsd, usdPerMillionTokens } = config
  if (maxToolCalls !== undefined && facts.toolCalls >= maxToolCalls) {
    return { name: 'maxToolCalls', observed: facts.toolCalls, limit: maxToolCalls }
  }
  if (maxWallMs !== undefined) {
    const elapsed = Date.now() - facts.startedAt
    if (elapsed >= maxWallMs) return { name: 'maxWallMs', observed: elapsed, limit: maxWallMs }
  }
  if (maxTotalTokens !== undefined || maxCostUsd !== undefined) {
    const measured = ctx.tokenMeter.measure(session).totalTokens
    if (maxTotalTokens !== undefined && measured >= maxTotalTokens) {
      return { name: 'maxTotalTokens', observed: measured, limit: maxTotalTokens }
    }
    // `validateCeilings` rejects this ceiling without a price at load, so the
    // price is defined whenever this branch runs.
    if (maxCostUsd !== undefined && usdPerMillionTokens !== undefined) {
      const cost = (measured * usdPerMillionTokens) / 1_000_000
      if (cost >= maxCostUsd) return { name: 'maxCostUsd', observed: cost, limit: maxCostUsd }
    }
  }
  return undefined
}

/**
 * Install the guard's listeners. Per-turn facts live in a WeakMap keyed by
 * session and exist only for turns observed from their own `turn/start`, so a
 * turn already open when this plugin loads is never cut.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated plugin configuration; every ceiling is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config = {}): void {
  validateCeilings(config)
  const turns = new WeakMap<Session, TurnFacts>()

  ctx.on('session/event', (session, event: SessionEvent) => {
    if (event.type === 'turn/start') {
      turns.set(session, { turn: event.data.turn, startedAt: event.time, toolCalls: 0 })
      return
    }
    if (event.type === 'tool/call') {
      const facts = turns.get(session)
      if (facts !== undefined) facts.toolCalls += 1
    }
  })

  ctx.on('agent/pre-step', ({ agent, messages, turn, step }, next): Promise<PreStepDecision> => {
    const facts = turns.get(agent.session)
    if (facts === undefined || facts.turn !== turn) return next()
    // A claimed user message owns this step: rejecting here would drop it from
    // the inbox, so human input outranks every ceiling.
    if (messages.some(message => message.source.kind === 'user')) return next()
    const reached = reachedCeiling(ctx, config, agent.session, facts)
    if (reached === undefined) return next()
    ctx.logger.warn(
      `budgets: agent "${agent.id}" turn ${turn}: ${reached.name} ceiling reached `
      + `(observed ${reached.observed} >= limit ${reached.limit})`,
    )
    const exceeded: BudgetExceededEventData = { ...reached, turn, step }
    agent.session.append('budget/exceeded', exceeded)
    return Promise.resolve({ kind: 'reject' })
  })
}
