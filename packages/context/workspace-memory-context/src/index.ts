/**
 * Workspace memory brief injector. At each eligible pre-step the injector
 * compares the record's digest against the newest visible `user/message`
 * with a `workspace-memory` source and appends exactly one complete fresh
 * brief when they differ.
 * A mounted `agent-context` also records the visible brief as a required, untrusted memory source.
 * @module @deepseek-ai/dsh-workspace-memory-context
 */

import { realpath } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ContextItem } from '@deepseek-ai/dsh-agent-context'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace-memory'
import {
  renderWorkspaceMemoryBrief,
  unavailableFileLine,
  type MaterializedContext,
} from './render.ts'

export { byteLength, escapeFrameBody, renderWorkspaceMemoryBrief, truncateUtf8, unavailableFileLine } from './render.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'workspace-memory-context'

/** Typed source carried by every injected brief. */
export interface WorkspaceMemorySource {
  kind: 'workspace-memory'
  form: 'instructions'
  workspaceId: WorkspaceId
  digest: string
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** @persistenceAttribution */
    'workspace-memory': WorkspaceMemorySource
  }
}

/** Plugin configuration: cap on the complete injected brief. */
export interface Config {
  /** Cap on the complete emitted text including the frame. */
  maxBytes: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().step(1).min(1).required(),
})

/** Required host services. */
export const inject = ['workspaceRegistry', 'workspaceMemory']

function workspaceMemoryDigest(message: UserMessage): string | undefined {
  const source = message.source as { kind?: string; digest?: unknown } | undefined
  return source?.kind === 'workspace-memory' && typeof source.digest === 'string' ? source.digest : undefined
}

function newestVisibleBrief(agent: Agent, claimed: readonly UserMessage[]): UserMessage | undefined {
  for (let index = claimed.length - 1; index >= 0; index -= 1) {
    const message = claimed[index]
    if (message !== undefined && workspaceMemoryDigest(message) !== undefined) return message
  }
  const messages = agent.session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && workspaceMemoryDigest(message) !== undefined) return message
  }
  return undefined
}

function textOfUserMessage(message: UserMessage): string {
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text') text += (block as { text: string }).text
  }
  return text
}

async function canonicalPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path)
  } catch {
    return undefined
  }
}

async function readFileText(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return await readFile(path, 'utf8')
}

/**
 * Register pre-step brief injection and its optional compiler source for the
 * lifetime of `ctx`.
 * @param ctx - plugin context; the listener is disposed with it.
 * @param config - byte cap on the complete brief.
 */
export function apply(ctx: Context, config: Config): void {
  const maxBytes = config.maxBytes
  const workspaceBySession = new Map<string, WorkspaceId | null>()
  ctx.on('session/disposed', (session: Session) => {
    workspaceBySession.delete(String(session.id))
  })
  ctx.effect(() => () => { workspaceBySession.clear() }, 'workspace-memory-context.cache')

  const resolveWorkspace = async (session: Session): Promise<{ id: WorkspaceId; title: string; path: string } | undefined> => {
    const key = String(session.id)
    const cached = workspaceBySession.get(key)
    if (cached !== undefined) {
      if (cached === null) return undefined
      const workspace = ctx.workspaceRegistry.get(cached)
      if (workspace !== undefined) return { id: workspace.id, title: workspace.title, path: workspace.path }
      workspaceBySession.delete(key)
    }
    for (const workspace of ctx.workspaceRegistry.list()) {
      if ((workspace.sessionIds).includes(session.id)) {
        workspaceBySession.set(key, workspace.id)
        return { id: workspace.id, title: workspace.title, path: workspace.path }
      }
    }
    const cwd = session.header.cwd
    if (cwd !== undefined) {
      const canonical = await canonicalPath(cwd)
      if (canonical !== undefined) {
        for (const workspace of ctx.workspaceRegistry.list()) {
          if (workspace.path === canonical) {
            workspaceBySession.set(key, workspace.id)
            return { id: workspace.id, title: workspace.title, path: workspace.path }
          }
        }
      }
    }
    workspaceBySession.set(key, null)
    return undefined
  }

  ctx.inject(['agentContext'], (compilerCtx) => {
    compilerCtx.effect(() => compilerCtx.agentContext.register({
      producer: 'workspace-memory',
      kind: 'memory',
      trust: 'untrusted',
      placement: 'stable-core',
      maxBytes,
    }, (agent, signal): Promise<readonly ContextItem[]> => {
      signal.throwIfAborted()
      const brief = newestVisibleBrief(agent, [])
      return Promise.resolve(brief === undefined ? [] : [{ id: 'brief', text: textOfUserMessage(brief), relevance: 1 }])
    }))
  })

  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    const membership = await resolveWorkspace(agent.session)
    if (membership === undefined) return decision
    const record = ctx.workspaceMemory.read(membership.id)
    // An absent record digests as 'empty' and carries no sections, so the
    // content check below subsumes both: nothing to inject either way.
    if (record === undefined) return decision
    const digest = ctx.workspaceMemory.digest(membership.id)
    const visible = newestVisibleBrief(agent, decision.messages)
    if (visible !== undefined && workspaceMemoryDigest(visible) === digest) return decision
    const hasContent = record.instructions.length > 0 || record.memory.length > 0 || record.contextItems.length > 0
    if (!hasContent) return decision

    const materialized: MaterializedContext[] = []
    const fileSystem = ctx.get('fs')
    for (const item of record.contextItems) {
      if (item.kind === 'text') {
        materialized.push({ label: item.label, content: item.text })
        continue
      }
      let content: string | undefined
      try {
        if (fileSystem !== undefined) {
          const target = await fileSystem.resolve(item.path)
          content = await fileSystem.readText(target, signal)
        } else {
          content = await readFileText(item.path, signal)
        }
      } catch {
        content = undefined
      }
      if (content === undefined) {
        materialized.push({ label: item.label, content: unavailableFileLine(item.label, item.path) })
      } else {
        materialized.push({ label: item.label, content })
      }
    }

    const text = renderWorkspaceMemoryBrief(
      {
        title: membership.title,
        path: membership.path,
        instructions: record.instructions,
        memory: record.memory,
        context: materialized,
      },
      maxBytes,
    )
    // Rendered text is empty exactly when every section is empty, which
    // hasContent above already excludes: reaching here always injects.
    const brief = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'workspace-memory', form: 'instructions', workspaceId: membership.id, digest },
    })
    return { ...decision, messages: [...decision.messages, brief] }
  })
}
