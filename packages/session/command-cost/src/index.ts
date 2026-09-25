/** Human-facing `/cost` command for provider-priced session usage. */
import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { LlmModelCost, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  messageRoute,
  normalizeSample,
  priceSample,
  sampleOfAttempt,
  sampleOfMessage,
} from '@deepseek-ai/dsh-usage-ledger'
import type { NormalizedSample } from '@deepseek-ai/dsh-usage-ledger'
import type { SessionLogSnapshot } from '@deepseek-ai/dsh-session-query'
import type { SubagentDescendantListEntry } from '@deepseek-ai/dsh-subagent'

const USAGE = 'Usage: /cost'
export const name = 'command-cost'
export const inject = ['commands', 'llm', 'sessionQuery', 'subagents']

interface CostSessionInput {
  readonly label: string
  readonly depth: number
  readonly snapshot: SessionLogSnapshot
  /** Events before this count are inherited from the parent and already priced there. */
  readonly ownedFrom: number
}

interface SessionCost {
  readonly label: string
  readonly depth: number
  readonly usd: number
  readonly pricedAttempts: number
  readonly unknownAttempts: number
}

interface CostReport {
  readonly sessions: readonly SessionCost[]
  readonly usd: number
  readonly pricedAttempts: number
  readonly unknownAttempts: number
  readonly unknownRoutes: readonly string[]
  readonly unavailableSessions: number
}

interface MutableSessionCost {
  label: string
  depth: number
  usd: number
  pricedAttempts: number
  unknownAttempts: number
}

type CostResolver = (provider: string, model: string, signal: AbortSignal) => Promise<LlmModelCost | undefined>

/** Add each settled usage sample in one session, excluding inherited child events. */
async function buildCostReport(
  inputs: readonly CostSessionInput[],
  resolveCost: CostResolver,
  signal: AbortSignal,
  unavailableSessions: number,
): Promise<CostReport> {
  const routePrices = new Map<string, Promise<LlmModelCost | undefined>>()
  const unknownRoutes = new Set<string>()
  const sessions: MutableSessionCost[] = []

  for (const input of inputs) {
    signal.throwIfAborted()
    const result: MutableSessionCost = {
      label: input.label,
      depth: input.depth,
      usd: 0,
      pricedAttempts: 0,
      unknownAttempts: 0,
    }
    let activeRoute: { readonly provider: string; readonly model: string } | undefined

    for (let index = 0; index < input.snapshot.events.length; index += 1) {
      signal.throwIfAborted()
      const event = input.snapshot.events[index]
      if (event === undefined) continue
      if (event.type === 'request/context') {
        activeRoute = { provider: event.data.provider, model: event.data.model }
        continue
      }
      if (index < input.ownedFrom) continue

      let usage: TokenUsage | undefined
      let route = activeRoute
      if (event.type === 'assistant/attempt') {
        usage = sampleOfAttempt(event)
      } else if (event.type === 'assistant/message') {
        usage = sampleOfMessage(event)
        route = messageRoute(event.data.message) ?? activeRoute
        if (route !== undefined) activeRoute = route
      } else {
        continue
      }
      if (usage === undefined) continue

      const sample: NormalizedSample | undefined = normalizeSample(usage)
      if (sample === undefined || route === undefined) {
        result.unknownAttempts += 1
        unknownRoutes.add(route === undefined ? 'unknown route' : `${route.provider}/${route.model}`)
        continue
      }

      const routeKey = `${route.provider}\u0000${route.model}`
      let price = routePrices.get(routeKey)
      if (price === undefined) {
        price = resolveCost(route.provider, route.model, signal).catch(() => {
          signal.throwIfAborted()
          return undefined
        })
        routePrices.set(routeKey, price)
      }
      const rates = await price
      signal.throwIfAborted()
      if (rates === undefined) {
        result.unknownAttempts += 1
        unknownRoutes.add(`${route.provider}/${route.model}`)
      } else {
        result.usd += priceSample(sample, rates)
        result.pricedAttempts += 1
      }
    }
    sessions.push(result)
  }

  const pricedAttempts = sessions.reduce((total, session) => total + session.pricedAttempts, 0)
  const unknownAttempts = sessions.reduce((total, session) => total + session.unknownAttempts, 0)
  return {
    sessions,
    usd: sessions.reduce((total, session) => total + session.usd, 0),
    pricedAttempts,
    unknownAttempts,
    unknownRoutes: [...unknownRoutes],
    unavailableSessions,
  }
}

/** Format an estimated USD total without rounding small requests to zero. */
function formatMoney(usd: number): string {
  return `$${usd.toFixed(8)}`
}

/** Render the session tree's priced spend and routes without known prices. */
function formatReport(report: CostReport): string {
  if (report.pricedAttempts === 0 && report.unknownAttempts === 0) {
    return report.unavailableSessions === 0
      ? 'No billed usage samples are recorded for this session tree.'
      : `No billed usage samples are recorded. ${report.unavailableSessions} subagent session(s) could not be read.`
  }
  const lines = [
    'Cost estimate in USD; provider catalog rates may differ from your invoice.',
    `Priced total: ${formatMoney(report.usd)}`,
    ...report.sessions.map(session => `${'  '.repeat(session.depth)}${session.label}: ${formatMoney(session.usd)}`
      + ` (${session.pricedAttempts} priced, ${session.unknownAttempts} unknown)`),
  ]
  if (report.unknownAttempts > 0) {
    lines.push(`Unknown-priced attempts: ${report.unknownAttempts}`)
    for (const route of report.unknownRoutes) lines.push(`  ${route}`)
  }
  if (report.unavailableSessions > 0) {
    lines.push(`Unreadable subagent sessions: ${report.unavailableSessions}`)
  }
  return lines.join('\n')
}

/** Read and price the invoking Agent's owned usage plus every descendant session. */
async function runCost(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  if (invocation.rawInput.trim().length > 0) return { kind: 'error', text: USAGE }
  const rootId = invocation.agent.session.id
  const rootRead: Promise<SessionLogSnapshot> = ctx.sessionQuery.readSession(rootId)
  const descendantsRead: Promise<SubagentDescendantListEntry[]> = ctx.subagents.listDescendants(rootId, invocation.signal)
  const [root, descendants] = await Promise.all([rootRead, descendantsRead])
  invocation.signal.throwIfAborted()

  const inputs: CostSessionInput[] = [{ label: 'This agent', depth: 0, snapshot: root, ownedFrom: 0 }]
  let unavailableSessions = 0
  for (const descendant of descendants) {
    invocation.signal.throwIfAborted()
    if (descendant.kind === 'diagnostic') {
      unavailableSessions += 1
      continue
    }
    try {
      const snapshot = await ctx.sessionQuery.readSession(descendant.id)
      const label = (descendant.label ?? String(descendant.id)).replace(/[\r\n\t]/gu, ' ').trim()
      inputs.push({ label: label.length > 0 ? label : String(descendant.id), depth: descendant.depth, snapshot, ownedFrom: snapshot.inheritedEventCount })
    } catch {
      invocation.signal.throwIfAborted()
      unavailableSessions += 1
    }
  }

  const report = await buildCostReport(
    inputs,
    async (provider, model, signal) => (await ctx.llm.resolveModelInfo(provider, model, signal)).cost,
    invocation.signal,
    unavailableSessions,
  )
  return { kind: 'success', text: formatReport(report) }
}

/** Register `/cost` for interactive command adapters. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-cost'),
    name: 'cost',
    description: 'Show estimated USD usage for this agent and its subagents',
    handler: invocation => runCost(ctx, invocation),
  })
}
