/**
 * Session metric intake: the OpenTelemetry counters and histograms a
 * deployment's already-logged session events imply.
 *
 * Tokens and cost reuse `dsh-usage-ledger`'s normalize, route, and price rules,
 * so a metric sample bills exactly as the usage dashboard bills the same event.
 * Tool latency spans the durable `tool/call` → `tool/result` pair, and
 * approvals count the audit pair the approval service already logs. Attribute
 * values stay bounded — routes, tool names, token types, and the closed
 * approval outcome vocabulary — so no session id, path, prompt, or tool
 * argument reaches the collector.
 *
 * @module @deepseek-ai/dsh-host-product-telemetry-otel/src/metrics
 */

import type { Counter, Histogram, Meter } from '@opentelemetry/api'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmModelCost, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: loads the `approval/asked` and `approval/decided` event payloads.
import type {} from '@deepseek-ai/dsh-user-approval/types'
// The ledger module itself owns the route sentinel as well as the sample and
// price rules: the package root re-exports the rules but not `UNKNOWN_ROUTE`.
import {
  UNKNOWN_ROUTE,
  messageRoute,
  normalizeSample,
  priceSample,
  sampleOfAttempt,
  sampleOfMessage,
} from '@deepseek-ai/dsh-usage-ledger/src/aggregate.ts'

/** Provider/model route one sample or one call ran under. */
interface Route {
  /** Registered provider route, or {@link UNKNOWN_ROUTE} when the log resolved none. */
  provider: string
  /** Provider-owned model id, or {@link UNKNOWN_ROUTE} when the log resolved none. */
  model: string
}

/** Separator inside a price-cache key (neither a provider nor a model id carries NUL). */
const ROUTE_KEY_SEPARATOR = '\u0000'

/** One `tool/call` awaiting its `tool/result`, for the latency span. */
interface PendingCall {
  /** Name the call was logged under. */
  name: string
  /** Commit time of the `tool/call` event, in epoch milliseconds. */
  startedAt: number
}

/**
 * The metric instruments one session's events feed: token and cost counters
 * priced by `dsh-usage-ledger`, a tool-latency histogram, and approval counters.
 */
export class SessionMetrics {
  private readonly tokens: Counter
  private readonly cost: Counter
  private readonly toolDuration: Histogram
  private readonly approvalsRequested: Counter
  private readonly approvalsDecided: Counter
  /** Catalog price per route; a route the deployment cannot price is cached as unpriced. */
  private readonly prices = new Map<string, Promise<LlmModelCost | undefined>>()
  /** Open tool calls per session, keyed by the session so disposal cannot leak them. */
  private readonly calls = new WeakMap<Session, Map<string, PendingCall>>()

  /**
   * @param ctx - host context that may carry the LLM service.
   * @param meter - meter the instruments are created on.
   */
  constructor(private readonly ctx: Context, meter: Meter) {
    this.tokens = meter.createCounter('dsh.tokens', {
      description: 'Billed model tokens by type',
      unit: '{token}',
    })
    this.cost = meter.createCounter('dsh.cost_usd', {
      description: 'Estimated billed model cost',
      unit: 'USD',
    })
    this.toolDuration = meter.createHistogram('dsh.tool.duration', {
      description: 'Elapsed time from one tool call to its result',
      unit: 'ms',
    })
    this.approvalsRequested = meter.createCounter('dsh.approvals.requested', {
      description: 'Approval questions put to the answerer chain',
    })
    this.approvalsDecided = meter.createCounter('dsh.approvals.decided', {
      description: 'Approval answers by outcome',
    })
  }

  /**
   * Fold one committed session event into the instruments it implies.
   * @param session - the session that committed the event.
   * @param event - the committed event.
   */
  observe(session: Session, event: SessionEvent): void {
    switch (event.type) {
      case 'assistant/message':
        this.recordUsage(session, event, sampleOfMessage(event))
        break
      case 'assistant/attempt':
        this.recordUsage(session, event, sampleOfAttempt(event))
        break
      case 'tool/call':
        this.openCalls(session).set(String(event.data.callId), { name: event.data.name, startedAt: event.time })
        break
      case 'tool/result': {
        // A result without an observed call (the session predates this mount, or
        // the log was repaired) has no span to record.
        const callId = String(event.data.message.source.callId)
        const call = this.openCalls(session).get(callId)
        if (call === undefined) break
        this.openCalls(session).delete(callId)
        this.toolDuration.record(event.time - call.startedAt, {
          'tool.name': call.name,
          'tool.outcome': event.data.message.isError === true ? 'error' : 'ok',
        })
        break
      }
      case 'approval/asked':
        this.approvalsRequested.add(1, { 'tool.name': event.data.toolName })
        break
      case 'approval/decided':
        this.approvalsDecided.add(1, { outcome: event.data.outcome })
        break
      // Every other event carries no metric this plugin exports. The event map
      // is merge-extensible, so unknown types fall through here.
      default:
        break
    }
  }

  /** Open calls of one session, created on first use. */
  private openCalls(session: Session): Map<string, PendingCall> {
    let calls = this.calls.get(session)
    if (calls === undefined) {
      calls = new Map()
      this.calls.set(session, calls)
    }
    return calls
  }

  /**
   * Record one usage sample's tokens and, once its route price resolves, cost.
   * Samples the token meter cannot prove (`normalizeSample`) are dropped, as
   * the ledger drops them.
   */
  private recordUsage(session: Session, event: SessionEvent, usage: TokenUsage | undefined): void {
    if (usage === undefined) return
    const sample = normalizeSample(usage)
    if (sample === undefined) return
    const route = this.routeOf(session, event)
    const attributes = { provider: route.provider, model: route.model }
    this.tokens.add(sample.inputTokens, { ...attributes, 'token.type': 'input' })
    this.tokens.add(sample.outputTokens, { ...attributes, 'token.type': 'output' })
    this.tokens.add(sample.cacheReadTokens, { ...attributes, 'token.type': 'cache_read' })
    void this.priceOf(route).then((cost) => {
      if (cost === undefined) return
      this.cost.add(priceSample(sample, cost), attributes)
    })
  }

  /** The route one usage sample ran under: the settled message's own route, else the request in force. */
  private routeOf(session: Session, event: SessionEvent): Route {
    if (event.type === 'assistant/message') {
      const route = messageRoute(event.data.message)
      if (route !== undefined) return route
    }
    const context = session.requestContext()
    return { provider: context?.provider ?? UNKNOWN_ROUTE, model: context?.model ?? UNKNOWN_ROUTE }
  }

  /**
   * Resolve one route's catalog price through the mounted LLM service, once per
   * route. A deployment without that service, or a route its catalog cannot
   * resolve, is unpriced — never free.
   */
  private priceOf(route: Route): Promise<LlmModelCost | undefined> {
    const key = `${route.provider}${ROUTE_KEY_SEPARATOR}${route.model}`
    let price = this.prices.get(key)
    if (price === undefined) {
      const llm = this.ctx.get('llm')
      price = llm === undefined
        ? Promise.resolve(undefined)
        : llm.resolveModelInfo(route.provider, route.model)
          .then(info => info.cost)
          // An unregistered route or a failed catalog read contributes no price.
          .catch(() => undefined)
      this.prices.set(key, price)
    }
    return price
  }
}
