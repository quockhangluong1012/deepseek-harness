/**
 * Route prices for the trace projection: the provider/model routes a committed
 * log recorded and the catalog rates the deployment's LLM service resolves for
 * them. Pricing itself stays with `dsh-usage-ledger`, whose own normalize and
 * price functions the projection applies, so a trace costs a step exactly as
 * `/cost` costs the same sample.
 * @module @deepseek-ai/dsh-evolution-trace/src/prices
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelCost } from '@deepseek-ai/dsh-llm'
import { messageRoute } from '@deepseek-ai/dsh-usage-ledger'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One provider/model route a committed log recorded. */
export interface TraceRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** Separator inside a route key (neither a provider nor a model id carries NUL). */
const ROUTE_KEY_SEPARATOR = '\u0000'

/**
 * Composite key of one route in a price map.
 * @param provider - registered provider route.
 * @param model - provider-owned model id.
 * @returns the map key.
 */
export function routeKey(provider: string, model: string): string {
  return `${provider}${ROUTE_KEY_SEPARATOR}${model}`
}

/**
 * Every route the committed events ran a step under, in first-use order: the
 * `request/context` snapshots the log recorded, plus the route of every settled
 * assistant message.
 * @param events - committed events in sequence order.
 * @returns the distinct routes.
 */
export function routesOf(events: readonly SessionEvent[]): readonly TraceRoute[] {
  const seen = new Set<string>()
  const routes: TraceRoute[] = []
  const add = (provider: string, model: string): void => {
    const key = routeKey(provider, model)
    if (seen.has(key)) return
    seen.add(key)
    routes.push({ provider, model })
  }
  for (const event of events) {
    if (event.type === 'request/context') add(event.data.provider, event.data.model)
    else if (event.type === 'assistant/message') {
      const route = messageRoute(event.data.message)
      if (route !== undefined) add(route.provider, route.model)
    }
  }
  return routes
}

/**
 * Resolve the catalog price of every route a log recorded through the mounted
 * LLM service. A deployment without that service, or a route whose adapter
 * declares no price or is not registered, contributes no entry: callers read
 * the absence as unpriced, never as free.
 * @param ctx - host context that may carry the LLM service.
 * @param events - committed events in sequence order.
 * @returns the price of each priced route, keyed by {@link routeKey}.
 */
export async function routePrices(
  ctx: Context,
  events: readonly SessionEvent[],
): Promise<ReadonlyMap<string, LlmModelCost>> {
  const prices = new Map<string, LlmModelCost>()
  const llm = ctx.get('llm')
  if (llm === undefined) return prices
  for (const route of routesOf(events)) {
    let cost: LlmModelCost | undefined
    try {
      cost = (await llm.resolveModelInfo(route.provider, route.model)).cost
    } catch {
      // A route this deployment does not register, or whose catalog lookup
      // failed, is unpriced here; the recorded run predates or postdates the
      // catalog, which is not a misconfiguration of this read.
      continue
    }
    if (cost !== undefined) prices.set(routeKey(route.provider, route.model), cost)
  }
  return prices
}
