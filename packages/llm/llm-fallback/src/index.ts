/**
 * Provider route fallback on the agent loop's request recovery extension
 * point. When downstream recovery declines a failed attempt, the plugin
 * switches the next attempt to the next healthy configured route and records
 * the durable `llm/fallback` event first. Route switching rides the
 * `agent/request` replacement contract the loop re-emits per attempt, so the
 * loop itself is unchanged.
 *
 * Breaker state is process-local: each observed failure counts against its
 * route, and a route that reaches the failure threshold stays out of rotation
 * until its cooldown elapses or a later success on that route clears it. A
 * stashed switch serves only the step that opened it. The key rotation hook
 * runs before the switch; a throwing hook warns and the switch proceeds.
 * @module @deepseek-ai/dsh-llm-fallback
 */

import { randomUUID } from 'node:crypto'
import type { Context, Events } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { DEFAULT_RETRYABLE_CODES } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { FallbackId } from './brand.ts'
import type { LlmFallbackEventData } from './types.ts'

export type { LlmFallbackEventData } from './types.ts'
export { FallbackId } from './brand.ts'

export const name = 'llm-fallback'
export const inject: string[] = []

/** One provider route available for fallback recovery. */
export interface LlmRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/**
 * Deployment-owned credential rotation before a route switch. Runs after the
 * route is selected and before the fallback event appends; a throw warns and
 * the switch proceeds, so rotation never blocks recovery.
 */
export type KeyRotationHook = (route: LlmRoute, failure: LlmFailure) => Promise<void> | void

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Optional deployment-owned credential rotation for fallback switches.
     * Absent by default; install it before the tree mounts when rotated keys
     * must precede the switched attempt.
     */
    llmFallbackKeyRotation?: KeyRotationHook
  }
}

/** Deployment choices for provider route fallback. */
export interface Config {
  /** Recovery routes in rotation order; empty disables fallback. */
  fallbackRoutes?: LlmRoute[]
  /** Breaker that rests a repeatedly failing route. */
  breaker?: {
    /** Consecutive observed failures that open one route. */
    failureThreshold?: number
    /** Milliseconds an open route stays out of rotation. */
    coolMs?: number
  }
  /** Failure codes eligible for fallback; omission admits the transient codes `DEFAULT_RETRYABLE_CODES`. */
  eligibleCodes?: string[]
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  fallbackRoutes: z.array(z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  })).default([]),
  breaker: z.object({
    failureThreshold: z.number().step(1).min(1).default(3),
    coolMs: z.number().min(0).default(60000),
  }),
  eligibleCodes: z.array(z.string()),
})

/** Normalized configuration used by the fallback. */
export interface ResolvedConfig {
  fallbackRoutes: LlmRoute[]
  failureThreshold: number
  coolMs: number
  /** Failure codes eligible for fallback; the resolved default admits transient codes only. */
  eligibleCodes: string[]
}

/**
 * Resolve defaults for optional fields. Validation here mirrors the schema
 * so programmatic `apply` fails loudly without going through the loader.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const {
    fallbackRoutes = [],
    breaker: { failureThreshold = 3, coolMs = 60000 } = {},
    eligibleCodes = [...DEFAULT_RETRYABLE_CODES],
  } = config
  for (const route of fallbackRoutes) {
    if (route.provider.length === 0 || route.model.length === 0) {
      throw new Error('llm-fallback: fallbackRoutes entries need a non-empty provider and model')
    }
  }
  if (!Number.isInteger(failureThreshold) || failureThreshold < 1) {
    throw new Error(`llm-fallback: breaker.failureThreshold must be a positive integer, got ${failureThreshold}`)
  }
  if (!Number.isFinite(coolMs) || coolMs < 0) {
    throw new Error(`llm-fallback: breaker.coolMs must be a finite non-negative number, got ${coolMs}`)
  }
  return {
    fallbackRoutes: fallbackRoutes.map(route => ({ provider: route.provider, model: route.model })),
    failureThreshold,
    coolMs,
    eligibleCodes: [...eligibleCodes],
  }
}

/** Pending route switch stashed for the step's next request attempt. */
interface PendingRoute {
  provider: string
  model: string
  fallbackId: FallbackId
  attempt: number
}

/** Breaker ledger for one route: observed failures and the open window. */
interface BreakerEntry {
  failures: number
  openUntilMs: number
}

/**
 * Install provider route fallback: an `agent/request` override serving
 * stashed switches, and an outer `agent/request-error` wrapper that always
 * delegates downstream first and only then switches.
 * @param ctx - plugin context that owns the listeners.
 * @param config - recovery routes, breaker, and eligible codes.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const pending = new Map<string, PendingRoute>()
  const breaker = new Map<string, BreakerEntry>()
  const lifetime = new AbortController()
  const active = new Set<Promise<RequestErrorAction>>()

  function track(operation: Promise<RequestErrorAction>): Promise<RequestErrorAction> {
    const tracked = operation.finally(() => {
      active.delete(tracked)
    })
    active.add(tracked)
    return tracked
  }

  function stepKey(session: Session, turn: number, step: number): string {
    return `${session.id}:${turn}:${step}`
  }

  function breakerKey(provider: string): string {
    return provider
  }

  function isRouteOpen(provider: string, now: number): boolean {
    const entry = breaker.get(breakerKey(provider))
    return entry !== undefined && now < entry.openUntilMs
  }

  function recordFailure(provider: string, now: number): void {
    const key = breakerKey(provider)
    const entry = breaker.get(key) ?? { failures: 0, openUntilMs: 0 }
    const failures = entry.failures + 1
    breaker.set(key, {
      failures,
      openUntilMs: failures >= resolved.failureThreshold ? now + resolved.coolMs : entry.openUntilMs,
    })
  }

  const disposeRequest = ctx.on('agent/request', async (payload, next): Promise<LlmCallConfig> => {
    const settled = await next()
    const stashed = pending.get(stepKey(payload.agent.session, payload.turn, payload.step))
    if (stashed === undefined) return settled
    // A different adapter may reject inherited effort knobs, so the switch
    // carries only the route; adapter defaults fill the rest per attempt.
    const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = settled
    return { ...withoutInheritedEffort, provider: stashed.provider, model: stashed.model }
  })

  async function recover(
    payload: Parameters<Events['agent/request-error']>[0],
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    // A throwing downstream listener rejects the waterfall: recovery bugs
    // propagate instead of masking behind a switch.
    const downstream = await next()
    if (payload.signal.aborted) return downstream
    if (downstream?.kind === 'retry') return downstream
    const { agent, turn, step, provider, failure } = payload
    if (!resolved.eligibleCodes.includes(failure.code)) return downstream
    const now = Date.now()
    recordFailure(provider, now)
    const route = pickRoute(provider, now)
    if (route === undefined) return downstream
    try {
      await ctx.get('llmFallbackKeyRotation')?.(route, failure)
    } catch (error: unknown) {
      ctx.logger.warn(`llm-fallback: key rotation for provider "${route.provider}" failed, continuing with the route switch: ${String(error)}`)
    }
    // No second abort check: an abort landing inside the hook still meets the
    // loop's post-waterfall throwIfAborted, so at most one stray event lands
    // on a dying turn. A check here would be untestable without warping the
    // hook signature around cancellation.
    const key = stepKey(agent.session, turn, step)
    const previous = pending.get(key)
    const attempt = (previous?.attempt ?? 0) + 1
    const fallbackId = previous?.fallbackId ?? FallbackId(randomUUID())
    const eventData: LlmFallbackEventData = {
      fallbackId,
      turn,
      step,
      fromProvider: provider,
      toProvider: route.provider,
      toModel: route.model,
      failure,
      attempt,
    }
    agent.session.append('llm/fallback', eventData)
    pending.set(key, { provider: route.provider, model: route.model, fallbackId, attempt })
    return { kind: 'retry' }
  }

  function pickRoute(fromProvider: string, now: number): LlmRoute | undefined {
    return resolved.fallbackRoutes.find(route => route.provider !== fromProvider && !isRouteOpen(route.provider, now))
  }

  const disposeError = ctx.on('agent/request-error', (payload, next: () => Promise<RequestErrorAction>) => {
    if (lifetime.signal.aborted) return Promise.resolve<RequestErrorAction>(undefined)
    return track(recover(payload, next))
  })

  // Step close ends the stash's life: a switch serves only the attempts of the
  // step that opened it, so a later turn or agent that reuses the same session,
  // turn, and step starts from its own route. A committed assistant message
  // proves the route that produced it answered, so it clears that route's
  // failures; an interrupted message carries its delivered prefix, and a turn
  // cancellation is no route fault.
  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    if (event.type === 'step/end') {
      pending.delete(stepKey(session, event.data.turn, event.data.step))
      return
    }
    if (event.type !== 'assistant/message') return
    breaker.delete(breakerKey(event.data.message.source.provider))
  })

  ctx.effect(() => async () => {
    disposeRequest()
    disposeError()
    disposeSessionEvents()
    lifetime.abort(new Error('llm-fallback plugin disposed'))
    pending.clear()
    await Promise.allSettled([...active])
  }, 'llm-fallback: abort and drain active recovery')
}
