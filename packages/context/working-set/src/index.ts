/**
 * The working-set plugin: it selects the files the session's current objective
 * names, injects the selection once per change as a superseding durable
 * snapshot, and registers the same selection as a stable-core compiler source.
 *
 * Selection is the whole point. The set is a pure function of the index
 * fingerprint and the objective, the session keeps only the newest snapshot on
 * the surface, and a selection equal to the session's previous one injects
 * nothing, so a step whose objective and tree are unchanged sits behind a
 * byte-identical prefix. `maxBytes` bounds the text and the five file caps bound
 * the selection, and the plugin and its compiler registration share that same
 * `maxBytes`.
 * @module @deepseek-ai/dsh-working-set
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ContextItem } from '@deepseek-ai/dsh-agent-context'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { renderWorkingSet } from './render.ts'
import { selectWorkingSet } from './select.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'working-set': { kind: 'working-set' } & ContextFormed
  }
}

export { renderWorkingSet } from './render.ts'
export { selectWorkingSet } from './select.ts'
export type { WorkingSet, WorkingSetSelection } from './types.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'working-set'

/** The index service the selection reads. */
export const inject = ['repoIndex']

/** The selection's bounds; an invalid value fails plugin load. */
export interface Config {
  /** Maximum UTF-8 bytes of the complete injected selection text. */
  maxBytes?: number
  /** Maximum primary files the selection lists. */
  maxPrimaryFiles?: number
  /** Maximum dependency files the selection lists. */
  maxDependencyFiles?: number
  /** Maximum test files the selection lists. */
  maxTestFiles?: number
  /** Maximum configuration files the selection lists. */
  maxConfigFiles?: number
  /** Maximum documentation files the selection lists. */
  maxDocs?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().default(3072),
  maxPrimaryFiles: z.number().default(8),
  maxDependencyFiles: z.number().default(8),
  maxTestFiles: z.number().default(6),
  maxConfigFiles: z.number().default(4),
  maxDocs: z.number().default(3),
})

/** The shape after schemastery applied the defaults. */
type ResolvedConfig = Required<Config>

/** Reject a bound that would select nothing or behave non-deterministically. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`working-set: ${name} must be a positive safe integer, got ${String(value)}`)
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
 * The objective the selection reads: the newest user-authored text among the
 * session's surface and the messages this step claimed. Claimed messages are
 * not on the surface yet, so the step that opens a task selects by the task it
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
 * The text of the newest working-set snapshot among the messages one step
 * claims, when the step already carries one.
 * @param messages - the messages this step claimed.
 * @returns that snapshot's text, or undefined when the step claims none.
 */
function claimedSnapshotText(messages: readonly UserMessage[]): string | undefined {
  let text: string | undefined
  for (const message of messages) {
    if (message.source.kind === name) text = textOf(message)
  }
  return text
}

/**
 * Register the pre-step selection injection and its compiler source for the
 * lifetime of `ctx`.
 * @param ctx - plugin context; the listener and registration are disposed with it.
 * @param config - the byte and per-role file bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxBytes', resolved.maxBytes)
  assertPositiveInteger('maxPrimaryFiles', resolved.maxPrimaryFiles)
  assertPositiveInteger('maxDependencyFiles', resolved.maxDependencyFiles)
  assertPositiveInteger('maxTestFiles', resolved.maxTestFiles)
  assertPositiveInteger('maxConfigFiles', resolved.maxConfigFiles)
  assertPositiveInteger('maxDocs', resolved.maxDocs)
  const selection = {
    maxPrimaryFiles: resolved.maxPrimaryFiles,
    maxDependencyFiles: resolved.maxDependencyFiles,
    maxTestFiles: resolved.maxTestFiles,
    maxConfigFiles: resolved.maxConfigFiles,
    maxDocs: resolved.maxDocs,
  }
  // The newest selection text one live session rendered. The pre-step listener
  // refreshes it before the step's assembly, so the compiler registration reads
  // it instead of selecting a second time.
  const rendered = new WeakMap<Session, string>()

  const setTextFor = async (
    agent: Agent,
    signal?: AbortSignal,
    claimed: readonly UserMessage[] = [],
  ): Promise<string | undefined> => {
    const root = agent.session.header.cwd
    if (root === undefined) return undefined
    const snapshot = await ctx.repoIndex.ensure(root, signal)
    if (snapshot.symbols.length === 0) return undefined
    const text = renderWorkingSet(selectWorkingSet(snapshot, objectiveOf(agent.session, claimed), selection), resolved.maxBytes)
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
      const text = rendered.get(agent.session) ?? await setTextFor(agent, signal)
      return text === undefined ? [] : [{ id: 'set', text, relevance: 1 }]
    }))
  })

  ctx.on('agent/pre-step', async (input, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || input.signal.aborted) return decision
    const session = input.agent.session
    const text = await setTextFor(input.agent, input.signal, input.messages)
    if (text === undefined) {
      rendered.delete(session)
      return decision
    }
    // An unchanged selection injects nothing: the previous snapshot is still the
    // session's live one, so the request prefix stays byte-identical even when
    // the tree changed in a way the selection does not see.
    if (rendered.get(session) === text) return decision
    rendered.set(session, text)
    // A step that already claims this exact snapshot — a retry, or a session
    // resumed from the log by a fresh process — injects nothing: the message the
    // model is about to see already carries it.
    if (claimedSnapshotText(decision.messages) === text) return decision
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
