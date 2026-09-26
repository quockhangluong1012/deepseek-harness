/**
 * Budget guard. It observes each turn's `turn/start`, dispatched tool calls,
 * and the kernel's durable run marker on `session/event` and evaluates the
 * configured ceilings on `agent/pre-step`; a reached ceiling records the
 * durable `budget/exceeded` event and rejects the proposed step without calling
 * `next()`, and the loop closes the turn with its existing `blocked` reason. A
 * step that claims a human message always enters, so a budget never discards
 * user input. Configuration and deferred work live in the package README;
 * rationale lives in the guard-budgets Agent Note.
 *
 * Billed spend is the token meter's own provider-reported accounting, read from
 * its `tokenUsage` session projection and differenced at each scope's origin;
 * context pressure is a different axis with its own ceiling. Neither is a bill:
 * see this package's README.
 *
 * @module @deepseek-ai/dsh-budgets
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: activates the `ctx.tokenMeter` Context declaration.
import type {} from '@deepseek-ai/dsh-token-meter'
// Type-only: activates the `ctx.sessionProjections` Context declaration and the
// meter's `tokenUsage` projection key that billed spend is read from.
import type {} from '@deepseek-ai/dsh-session-projection'
import z from '@deepseek-ai/schemastery'
import { CEILING_NAMES, CEILINGS } from './types.ts'
import type { BudgetExceededEventData, BudgetScope, CeilingMeasure, CeilingName, CeilingState } from './types.ts'
import { runMarkerOf } from './run-marker.ts'
import { costUsd, spendOf, spendSince } from './spend.ts'
import type { Spend } from './spend.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'budgets'

/** The services every ceiling reads: `ctx.tokenMeter` for pressure and `ctx.sessionProjections` for billed spend. */
export const inject = ['tokenMeter', 'sessionProjections']

/**
 * Plugin configuration. Every ceiling is optional, and an unset ceiling is
 * unbounded, so a plugin mounted with no configuration never rejects a step.
 * Misconfiguration fails loud at plugin load: a non-positive or non-finite
 * value throws instead of silently disabling the ceiling it names.
 */
export interface Config {
  /** Ceiling on the prompt tokens one turn is billed for: uncached input plus cache reads and writes. */
  maxInputTokens?: number
  /** Ceiling on the completion tokens one turn is billed for, reasoning included. */
  maxOutputTokens?: number
  /** Ceiling on all tokens one turn is billed for. */
  maxTotalTokens?: number
  /** Ceiling on tool calls dispatched in one turn, compared before the next step. */
  maxToolCalls?: number
  /** Ceiling on one turn's wall-clock duration in milliseconds, measured from its `turn/start`. */
  maxWallMs?: number
  /** Ceiling on all tokens one session is billed for, measured over the whole durable log. */
  maxSessionTokens?: number
  /** Ceiling on one session's priced billed spend in USD. */
  maxSessionCost?: number
  /** Ceiling on one session's wall-clock duration in milliseconds, measured from its creation. */
  maxSessionWallTime?: number
  /** Ceiling on all tokens one run is billed for, measured from the run marker that opened it. */
  maxRunTokens?: number
  /** Ceiling on one run's priced billed spend in USD. */
  maxRunCost?: number
  /** Ceiling on one run's wall-clock duration in milliseconds, measured from its run marker. */
  maxRunWallTime?: number
  /**
   * Ceiling on the measured context pressure of the next request,
   * `ctx.tokenMeter.measure(session).totalTokens`. This is the request rather
   * than the bill, and the only ceiling that reads pressure.
   */
  maxContextTokens?: number
  /** Ceiling on one turn's priced billed spend in USD. */
  maxCostUsd?: number
  /**
   * Flat price of one million billed tokens in USD. The harness owns no
   * per-route price data, so the deployment states what its models cost; a cost
   * ceiling without it stays present but unmeasurable instead of failing the
   * composition at load.
   */
  usdPerMillionTokens?: number
}

/** Runtime configuration schema for the budgets plugin. */
export const Config: z<Config> = z.object({
  maxInputTokens: z.number(),
  maxOutputTokens: z.number(),
  maxTotalTokens: z.number(),
  maxToolCalls: z.number(),
  maxWallMs: z.number(),
  maxSessionTokens: z.number(),
  maxSessionCost: z.number(),
  maxSessionWallTime: z.number(),
  maxRunTokens: z.number(),
  maxRunCost: z.number(),
  maxRunWallTime: z.number(),
  maxContextTokens: z.number(),
  maxCostUsd: z.number(),
  usdPerMillionTokens: z.number(),
})

/** One turn's observed activity: its number, when it started, its tool calls, and its spend when it opened. */
interface TurnFacts {
  /** Turn number taken from the `turn/start` this entry was created by. */
  turn: number
  /** Unix epoch milliseconds of that `turn/start` event. */
  startedAt: number
  /** Tool calls observed for this turn so far. */
  toolCalls: number
  /** Billed spend when the turn opened; undefined while no spend ceiling is configured. */
  spend: Spend | undefined
}

/** One observed run: its identity, when its marker appeared, and the spend the session already had then. */
interface RunFacts {
  /** Stable run identity the marker carried. */
  runId: string
  /** Unix epoch milliseconds of the marker event. */
  startedAt: number
  /** Billed spend when the marker arrived; undefined while no spend ceiling is configured. */
  spend: Spend | undefined
}

/** One ceiling a step has reached, with the observed value and the configured limit. */
interface ReachedCeiling {
  name: CeilingName
  observed: number
  limit: number
  scope: BudgetScope
  /** Run identity for a run-scope ceiling; empty for every other scope. */
  runId: string
}

/**
 * Reject any configured ceiling that a comparison could never reach. A value
 * that is not a positive finite number would silently disable its ceiling, so it
 * fails plugin load instead. Cost ceilings without a price are a supported
 * state, not a misconfiguration: they load, warn once, and read as unmeasurable.
 * @param ctx - plugin context, used for the one warning.
 * @param config - validated plugin configuration.
 */
function validateCeilings(ctx: Context, config: Config): void {
  for (const ceiling of CEILING_NAMES) {
    const value = config[ceiling]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`budgets: ${ceiling} must be a positive finite number, got ${String(value)}`)
    }
  }
  const price = config.usdPerMillionTokens
  if (price !== undefined && (!Number.isFinite(price) || price <= 0)) {
    throw new Error(`budgets: usdPerMillionTokens must be a positive finite number, got ${String(price)}`)
  }
  if (price !== undefined) return
  const unpriced = CEILING_NAMES
    .filter(ceiling => CEILINGS[ceiling].measure === 'cost' && config[ceiling] !== undefined)
  if (unpriced.length > 0) {
    ctx.logger.warn(
      `budgets: ${unpriced.join(', ')} cannot be measured: the harness owns no price source, `
      + 'so set usdPerMillionTokens (USD per million billed tokens) or the cost ceilings stay inert',
    )
  }
}

/** Whether any ceiling of one measure is configured, so an unset axis costs nothing. */
function configured(config: Config, measure: CeilingMeasure): boolean {
  for (const ceiling of CEILING_NAMES) {
    if (CEILINGS[ceiling].measure === measure && config[ceiling] !== undefined) return true
  }
  return false
}

/** The session's billed spend so far, as the token meter's `tokenUsage` projection reports it. */
function sessionSpend(ctx: Context, session: Session): Spend | undefined {
  return spendOf(ctx.sessionProjections.snapshot(session, ['tokenUsage']).values.tokenUsage)
}

/** Every ceiling as this deployment configured it: its limit, `'unbounded'`, or `'unmeasurable'`. */
function ceilingStates(config: Config): Readonly<Record<CeilingName, CeilingState>> {
  const state = (ceiling: CeilingName): CeilingState => {
    const limit = config[ceiling]
    if (limit === undefined) return 'unbounded'
    return CEILINGS[ceiling].measure === 'cost' && config.usdPerMillionTokens === undefined ? 'unmeasurable' : limit
  }
  return {
    maxToolCalls: state('maxToolCalls'),
    maxWallMs: state('maxWallMs'),
    maxSessionWallTime: state('maxSessionWallTime'),
    maxRunWallTime: state('maxRunWallTime'),
    maxInputTokens: state('maxInputTokens'),
    maxOutputTokens: state('maxOutputTokens'),
    maxTotalTokens: state('maxTotalTokens'),
    maxCostUsd: state('maxCostUsd'),
    maxSessionTokens: state('maxSessionTokens'),
    maxSessionCost: state('maxSessionCost'),
    maxRunTokens: state('maxRunTokens'),
    maxRunCost: state('maxRunCost'),
    maxContextTokens: state('maxContextTokens'),
  }
}

/** The budget a cut is reported under, named for the log line the guard writes. */
function scopeLabel(reached: ReachedCeiling, turn: number): string {
  switch (reached.scope) {
    case 'turn': return `turn ${turn}`
    case 'context': return `turn ${turn} context`
    case 'session': return 'session'
    case 'run': return `run ${JSON.stringify(reached.runId)}`
  }
}

/**
 * The first configured ceiling this step has reached, or undefined when no
 * ceiling is configured, none is reached, or the axis that would be compared is
 * unmeasurable. Counters and clocks come first, then the session's billed spend
 * from one projection read, then the context measurement, so a step already over
 * a cheaper ceiling never pays for a replay of its log.
 * @param ctx - plugin context providing the projection and the meter.
 * @param config - validated plugin configuration.
 * @param session - session whose spend and pressure the ceilings compare.
 * @param facts - the turn's observed activity.
 * @param run - the observed run, or undefined when no run marker was seen.
 * @returns the reached ceiling with its observed value and limit, or undefined.
 */
function reachedCeiling(
  ctx: Context,
  config: Config,
  session: Session,
  facts: TurnFacts,
  run: RunFacts | undefined,
): ReachedCeiling | undefined {
  const at = Date.now()
  const reached = (ceiling: CeilingName, observed: number | undefined, runId = ''): ReachedCeiling | undefined => {
    const limit = config[ceiling]
    if (limit === undefined || observed === undefined || observed < limit) return undefined
    return { name: ceiling, observed, limit, scope: CEILINGS[ceiling].scope, runId }
  }
  const calls = reached('maxToolCalls', facts.toolCalls)
  if (calls !== undefined) return calls
  const turnClock = reached('maxWallMs', at - facts.startedAt)
  if (turnClock !== undefined) return turnClock
  const sessionClock = reached('maxSessionWallTime', at - session.header.createdAt)
  if (sessionClock !== undefined) return sessionClock
  const runClock = run === undefined ? undefined : reached('maxRunWallTime', at - run.startedAt, run.runId)
  if (runClock !== undefined) return runClock
  if (configured(config, 'tokens') || configured(config, 'cost')) {
    const now = sessionSpend(ctx, session)
    const turn = spendSince(now, facts.spend)
    const runSpend = run === undefined ? undefined : spendSince(now, run.spend)
    const price = config.usdPerMillionTokens
    const input = reached('maxInputTokens', turn?.inputTokens)
    if (input !== undefined) return input
    const output = reached('maxOutputTokens', turn?.outputTokens)
    if (output !== undefined) return output
    const total = reached('maxTotalTokens', turn?.totalTokens)
    if (total !== undefined) return total
    const turnCost = reached('maxCostUsd', costUsd(turn, price))
    if (turnCost !== undefined) return turnCost
    const sessionTokens = reached('maxSessionTokens', now?.totalTokens)
    if (sessionTokens !== undefined) return sessionTokens
    const sessionCost = reached('maxSessionCost', costUsd(now, price))
    if (sessionCost !== undefined) return sessionCost
    if (run !== undefined) {
      const runTokens = reached('maxRunTokens', runSpend?.totalTokens, run.runId)
      if (runTokens !== undefined) return runTokens
      const runCost = reached('maxRunCost', costUsd(runSpend, price), run.runId)
      if (runCost !== undefined) return runCost
    }
  }
  if (config.maxContextTokens !== undefined) {
    const measured = ctx.tokenMeter.measure(session).totalTokens
    if (measured >= config.maxContextTokens) {
      return { name: 'maxContextTokens', observed: measured, limit: config.maxContextTokens, scope: 'context', runId: '' }
    }
  }
  return undefined
}

/**
 * Install the guard's listeners. Per-turn and per-run facts live in WeakMaps
 * keyed by session: a turn is observed only from its own `turn/start`, and a run
 * only from the durable marker the kernel writes when it opens one, so work
 * already in flight when this plugin loads is never cut.
 * @param ctx - plugin context; listeners are scoped to it and disposed with it.
 * @param config - validated plugin configuration; every ceiling is re-checked fail-loud here.
 */
export function apply(ctx: Context, config: Config = {}): void {
  validateCeilings(ctx, config)
  const tracksSpend = configured(config, 'tokens') || configured(config, 'cost')
  const turns = new WeakMap<Session, TurnFacts>()
  const runs = new WeakMap<Session, RunFacts>()

  ctx.on('session/event', (session, event: SessionEvent) => {
    const marker = runMarkerOf(event)
    if (marker !== undefined) {
      runs.set(session, {
        runId: marker.runId,
        startedAt: marker.at,
        spend: tracksSpend ? sessionSpend(ctx, session) : undefined,
      })
    }
    if (event.type === 'turn/start') {
      turns.set(session, {
        turn: event.data.turn,
        startedAt: event.time,
        toolCalls: 0,
        spend: tracksSpend ? sessionSpend(ctx, session) : undefined,
      })
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
    const reached = reachedCeiling(ctx, config, agent.session, facts, runs.get(agent.session))
    if (reached === undefined) return next()
    ctx.logger.warn(
      `budgets: agent "${agent.id}" ${scopeLabel(reached, turn)}: ${reached.name} ceiling reached `
      + `(observed ${reached.observed} >= limit ${reached.limit})`,
    )
    const exceeded: BudgetExceededEventData = {
      scope: reached.scope,
      name: reached.name,
      observed: reached.observed,
      limit: reached.limit,
      ceilings: ceilingStates(config),
      turn,
      step,
      ...reached.scope === 'run' ? { runId: reached.runId } : {},
    }
    agent.session.append('budget/exceeded', exceeded)
    return Promise.resolve({ kind: 'reject' })
  })
}

// Billed-spend arithmetic is shared by every consumer that prices a run, so it
// is part of this package's surface rather than a deep `src/spend.ts` import.
export { costUsd, spendOf, spendSince } from './spend.ts'
export type { BilledUsage, Spend } from './spend.ts'
