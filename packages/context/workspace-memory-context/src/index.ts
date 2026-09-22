/**
 * Workspace memory brief injector. At each eligible pre-step the injector
 * compares the record's digest against the newest visible `user/message`
 * with a `workspace-memory` source and appends exactly one complete fresh
 * brief when they differ.
 * @module @deepseek-ai/dsh-workspace-memory-context
 */

import { realpath } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
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

function isWorkspaceMemoryMessage(message: UserMessage): boolean {
  return (message.source as { kind?: string }).kind === 'workspace-memory'
}

function newestVisibleDigest(agent: Agent, claimed: readonly UserMessage[]): string | undefined {
  for (const message of [...claimed].reverse()) {
    if (!isWorkspaceMemoryMessage(message)) continue
    const source = message.source as unknown as WorkspaceMemorySource
    if (typeof source.digest === 'string') return source.digest
  }
  // The committed transcript is already the maintained surface projection, and
  // each derived message carries the source its producing event recorded, so
  // the newest committed brief's digest is reachable without a historical read.
  for (const message of [...agent.session.deriveMessages()].reverse()) {
    const source = message.source
    if (source.kind !== 'workspace-memory') continue
    if (typeof source.digest === 'string') return source.digest
  }
  return undefined
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
 * Register the pre-step brief injector for the lifetime of `ctx`.
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
    const visible = newestVisibleDigest(agent, decision.messages)
    if (visible === digest) return decision
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
