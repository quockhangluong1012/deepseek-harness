/**
 * The repository map plugin: it ranks the repository index against the
 * session's current objective and injects the compact map once per changed
 * map, as a superseding durable snapshot.
 *
 * Stability is the whole point of the injection. The map is a pure function of
 * the index fingerprint and the objective, the session keeps only the newest
 * snapshot on the surface, and an unchanged map injects nothing, so a step
 * whose objective and tree are unchanged sits behind a byte-identical prefix.
 * `maxBytes` bounds the text, `maxNodes` and `maxEdgesPerNode` bound the
 * ranking, and both the plugin and its compiler registration share the
 * `maxBytes` that truncates it.
 * @module @deepseek-ai/dsh-repo-map
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContextItem } from '@deepseek-ai/dsh-agent-context'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { rankRepositoryMap } from './rank.ts'
import { renderRepositoryMap } from './render.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'repo-map': { kind: 'repo-map' } & ContextFormed
  }
}

export { objectiveTerms, rankRepositoryMap } from './rank.ts'
export { renderRepositoryMap } from './render.ts'
export type { RepoMapCounts, RepoMapNode, RepoMapSelection } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'repo-map'

/** The index service the map ranks. */
export const inject = ['repoIndex']

/** The map's bounds; an invalid value fails plugin load. */
export interface Config {
  /** Maximum UTF-8 bytes of the complete injected map text. */
  maxBytes?: number
  /** Maximum symbols the map lists. */
  maxNodes?: number
  /** Maximum references the map lists beneath one symbol. */
  maxEdgesPerNode?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().default(4096),
  maxNodes: z.number().default(24),
  maxEdgesPerNode: z.number().default(4),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Reject a bound that would render nothing or behave non-deterministically. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`repo-map: ${name} must be a positive safe integer, got ${String(value)}`)
  }
}

/** The text of one user message's text blocks, ignoring every other block kind. */
function textOf(message: UserMessage): string {
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/**
 * The objective the ranking reads: the newest user-authored text among the
 * session's surface and the messages this step claimed. Claimed messages are
 * not on the surface yet, so the step that opens a task ranks by the task it
 * just claimed rather than by the previous turn's.
 */
function objectiveOf(session: Session, claimed: readonly UserMessage[]): string {
  let objective = ''
  for (const message of session.deriveMessages()) {
    if (message.role !== 'user' || message.source.kind !== 'user') continue
    objective = textOf(message)
  }
  for (const message of claimed) {
    if (message.source.kind !== 'user') continue
    objective = textOf(message)
  }
  return objective
}

/**
 * Register the pre-step map injection and its optional compiler source for the
 * lifetime of `ctx`.
 * @param ctx - plugin context; the listener and registration are disposed with it.
 * @param config - the byte, node, and reference bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxBytes', resolved.maxBytes)
  assertPositiveInteger('maxNodes', resolved.maxNodes)
  assertPositiveInteger('maxEdgesPerNode', resolved.maxEdgesPerNode)
  // The newest map text one live session rendered. The pre-step listener
  // refreshes it before the step's assembly, so the compiler registration
  // reads it instead of walking the tree a second time.
  const rendered = new WeakMap<Session, string>()

  const mapTextFor = async (
    agent: Agent,
    signal?: AbortSignal,
    claimed: readonly UserMessage[] = [],
  ): Promise<string | undefined> => {
    const root = agent.session.header.cwd
    if (root === undefined) return undefined
    const snapshot = await ctx.repoIndex.ensure(root, signal)
    if (snapshot.symbols.length === 0) return undefined
    const text = renderRepositoryMap(
      rankRepositoryMap(snapshot, objectiveOf(agent.session, claimed), {
        maxNodes: resolved.maxNodes,
        maxEdgesPerNode: resolved.maxEdgesPerNode,
      }),
      { symbols: snapshot.symbols.length, indexed: snapshot.stats.indexed },
      resolved.maxBytes,
    )
    return text.length === 0 ? undefined : text
  }

  ctx.inject(['agentContext'], (compilerCtx) => {
    compilerCtx.effect(() => compilerCtx.agentContext.register({
      producer: name,
      kind: 'artifact',
      trust: 'untrusted',
      placement: 'stable-core',
      maxBytes: resolved.maxBytes,
    }, async (agent, signal): Promise<readonly ContextItem[]> => {
      signal.throwIfAborted()
      const text = rendered.get(agent.session) ?? await mapTextFor(agent, signal)
      return text === undefined ? [] : [{ id: 'map', text, relevance: 1 }]
    }))
  })

  ctx.on('agent/pre-step', async (input, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || input.signal.aborted) return decision
    const session = input.agent.session
    const text = await mapTextFor(input.agent, input.signal, input.messages)
    if (text === undefined) {
      rendered.delete(session)
      return decision
    }
    // An unchanged map injects nothing: the previous snapshot is still the
    // session's live one, so the request prefix stays byte-identical.
    if (rendered.get(session) === text) return decision
    rendered.set(session, text)
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: name, form: 'snapshot', sections: [{ name, text }], supersedes: true },
        }),
      ],
    }
  })
}
