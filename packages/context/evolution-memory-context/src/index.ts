/**
 * Evolution memory brief injector. At each eligible pre-step the injector
 * compares the record's digest against the newest visible `user/message`
 * with an `evolution-memory` source and appends exactly one complete fresh
 * brief when they differ. It also owns the evolution nudge sections behind
 * the system prompt; capacity usage is reported only in the brief (which
 * already varies with memory content), never interpolated into the system
 * prompt, so a memory write never invalidates the request's cached prefix.
 * @module @deepseek-ai/dsh-evolution-memory-context
 */

import { realpath } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-evolution-memory'
import { EvolutionScopeId, RECALL_LABEL_PREFIX } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionMemoryRecord } from '@deepseek-ai/dsh-evolution-memory'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import {
  evolutionBriefSections,
  renderEvolutionBrief,
  unavailableFileLine,
  type MaterializedContext,
} from './render.ts'
import {
  LESSONS_SKILLS_SECTION,
  MEMORY_SCOPE_SECTION,
  SESSION_SEARCH_SECTION,
  SKILL_MANAGE_TOOL,
  isNudgeTurn,
  lessonsSkillsText,
} from './sections.ts'

export {
  byteLength,
  evolutionBriefSections,
  renderEvolutionBrief,
  renderLessonLines,
  unavailableFileLine,
} from './render.ts'
export type { MaterializedContext } from './render.ts'
export {
  LESSONS_SKILLS_SECTION,
  MEMORY_SCOPE_SECTION,
  SESSION_SEARCH_SECTION,
  SKILL_MANAGE_TOOL,
  isNudgeTurn,
  lessonsSkillsText,
} from './sections.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'evolution-memory-context'

/**
 * Typed source carried by every injected brief. `form: 'snapshot'` presents
 * Instructions/Lessons/Profile/Context as distinct named parts instead of one
 * undifferentiated block, and `supersedes` declares what a brief is: the
 * scope's current state, so the loop replaces the previous brief with it on
 * the surface while the log keeps both. The alternative — every brief ever
 * injected staying in the model's context — would stack stale instructions
 * beside the current ones.
 */
export interface EvolutionMemorySource {
  kind: 'evolution-memory'
  form: 'snapshot'
  scopeId: EvolutionScopeId
  digest: string
  sections: readonly ContextSnapshotSection[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'evolution-memory': EvolutionMemorySource
  }
}

/** Plugin configuration: brief cap, scope namespace, and nudge cadence. */
export interface Config {
  /** Cap on the complete emitted text including the frame. */
  maxBytes: number
  /** Scope-identity namespace placed before the workspace key. Required: scopes never share a default namespace. */
  profile: string
  /** Turns between scope-narrowing nudges. */
  memoryNudgeInterval?: number
  /** Turns between lessons-to-skills nudges. */
  skillNudgeInterval?: number
  /** Usage ratio at or above which the brief header warns to consolidate. */
  capacityWarnPct?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().step(1).min(1).required(),
  profile: z.string().required(),
  memoryNudgeInterval: z.number().step(1).min(1).default(1),
  skillNudgeInterval: z.number().step(1).min(1).default(10),
  capacityWarnPct: z.number().min(0).max(1).default(0.8),
})

/** Plugin configuration with the optional nudge cadences resolved. */
export interface ResolvedConfig {
  /** Cap on the complete emitted text including the frame. */
  maxBytes: number
  /** Scope-identity namespace placed before the workspace key. */
  profile: string
  /** Turns between scope-narrowing nudges. */
  memoryNudgeInterval: number
  /** Turns between lessons-to-skills nudges. */
  skillNudgeInterval: number
  /** Usage ratio at or above which the brief header warns to consolidate. */
  capacityWarnPct: number
}

/**
 * Resolve the nudge cadence defaults before the injector registers anything.
 * The loader fills these defaults too; resolving here keeps one owner for the
 * values and keeps the registration path free of inline fallbacks.
 * @param config - validated plugin configuration.
 * @returns configuration with every field present.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    maxBytes: config.maxBytes,
    profile: config.profile,
    memoryNudgeInterval: config.memoryNudgeInterval ?? 1,
    skillNudgeInterval: config.skillNudgeInterval ?? 10,
    capacityWarnPct: config.capacityWarnPct ?? 0.8,
  }
}

/** Required host services. */
export const inject = ['workspaceRegistry', 'evolutionMemory']

/**
 * Validate the scope namespace loudly at load.
 * @param profile - configured namespace.
 */
function checkProfile(profile: string): void {
  if (profile.length === 0) throw new Error('evolution-memory-context: profile must be non-empty')
  if (profile.includes(':')) {
    throw new Error(`evolution-memory-context: profile must not contain ':', got ${JSON.stringify(profile)}`)
  }
}

function isEvolutionMemoryMessage(message: UserMessage): boolean {
  return (message.source as { kind?: string }).kind === 'evolution-memory'
}

/**
 * Read the digest off the newest claimed evolution brief that carries one.
 * @param claimed - messages claimed for this step.
 * @returns the digest, or undefined when none carries one.
 */
function claimedDigest(claimed: readonly UserMessage[]): string | undefined {
  const digests = claimed
    .filter(isEvolutionMemoryMessage)
    .map(message => (message.source as unknown as EvolutionMemorySource).digest)
    .filter((digest): digest is string => typeof digest === 'string')
  return digests.at(-1)
}

/**
 * Register the pre-step brief injector plus the nudge sections for the
 * lifetime of `ctx`.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - byte cap on the complete brief and scope namespace.
 */
export function apply(ctx: Context, config: Config): void {
  const { maxBytes, profile, memoryNudgeInterval, skillNudgeInterval, capacityWarnPct } = resolveConfig(config)
  checkProfile(profile)
  const workspaceBySession = new Map<string, WorkspaceId | null>()
  const injectedDigests = new Map<string, string>()
  const turnsBySession = new Map<string, number>()
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/start') return
    const key = String(session.id)
    turnsBySession.set(key, (turnsBySession.get(key) ?? 0) + 1)
  })
  ctx.on('session/disposed', (session: Session) => {
    const key = String(session.id)
    workspaceBySession.delete(key)
    injectedDigests.delete(key)
    turnsBySession.delete(key)
  })
  ctx.effect(() => () => {
    workspaceBySession.clear()
    injectedDigests.clear()
    turnsBySession.clear()
  }, 'evolution-memory-context.cache')

  const scopeOf = (workspaceId: WorkspaceId): EvolutionScopeId => EvolutionScopeId(profile, String(workspaceId))

  const memberBySession = (session: Session): { id: WorkspaceId; title: string; path: string } | undefined => {
    const key = String(session.id)
    const cached = workspaceBySession.get(key)
    if (cached === null) return undefined
    if (cached !== undefined) {
      const workspace = ctx.workspaceRegistry.get(cached)
      if (workspace !== undefined) return { id: workspace.id, title: workspace.title, path: workspace.path }
      workspaceBySession.delete(key)
    }
    const found = ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(session.id))
    if (found === undefined) return undefined
    workspaceBySession.set(key, found.id)
    return { id: found.id, title: found.title, path: found.path }
  }

  const resolveWorkspace = async (session: Session): Promise<{ id: WorkspaceId; title: string; path: string } | undefined> => {
    const key = String(session.id)
    const direct = memberBySession(session)
    if (direct !== undefined) return direct
    const cwd = session.header.cwd
    const canonical = cwd === undefined ? undefined : await realpath(cwd).catch(() => undefined)
    if (canonical === undefined) {
      workspaceBySession.set(key, null)
      return undefined
    }
    const match = ctx.workspaceRegistry.list().find(entry => entry.path === canonical)
    if (match === undefined) {
      workspaceBySession.set(key, null)
      return undefined
    }
    workspaceBySession.set(key, match.id)
    return { id: match.id, title: match.title, path: match.path }
  }

  const newestLoggedDigest = async (session: Session): Promise<string | undefined> => {
    const sessionQuery = ctx.get('sessionQuery')
    if (sessionQuery?.readSurface === undefined) return undefined
    let surface: { events: readonly SessionEvent[] }
    try {
      surface = await sessionQuery.readSurface(session.id)
    } catch {
      return undefined
    }
    const events = [...surface.events].reverse()
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const source = (event.data as { source?: { kind?: string; digest?: unknown } }).source
      if (source?.kind === 'evolution-memory' && typeof source.digest === 'string') return source.digest
    }
    return undefined
  }

  const prompt = ctx.get('systemPrompt')
  if (prompt !== undefined) {
    const tools = ctx.get('tools')
    const turnsOf = (context: AssembleContext): number => {
      const session = context.agent?.session
      if (session === undefined) return 0
      return turnsBySession.get(String(session.id)) ?? 0
    }
    const sections = [
      {
        def: LESSONS_SKILLS_SECTION,
        text: (context: AssembleContext) => isNudgeTurn(turnsOf(context), skillNudgeInterval)
          ? lessonsSkillsText(tools?.get(SKILL_MANAGE_TOOL, context.scope))
          : '',
      },
      {
        def: MEMORY_SCOPE_SECTION,
        text: (context: AssembleContext) => isNudgeTurn(turnsOf(context), memoryNudgeInterval)
          ? MEMORY_SCOPE_SECTION.text
          : '',
      },
      { def: SESSION_SEARCH_SECTION, text: () => SESSION_SEARCH_SECTION.text },
    ]
    for (const section of sections) {
      const { def, text } = section
      ctx.effect(
        () => prompt.section({ name: def.name, order: def.order, text }),
        `evolution-memory-context.${def.name}`,
      )
    }
  }

  /**
   * Materialize every context item to display text, degrading unreadable
   * files to a one-line notice so the step proceeds. Recalled items render
   * last, because the brief drops trailing context first and recalled
   * material outranks nothing the user attached.
   */
  const materializeContext = async (
    record: EvolutionMemoryRecord,
    signal: AbortSignal,
  ): Promise<MaterializedContext[]> => {
    const fileSystem = ctx.get('fs')
    const materialized = await Promise.all(record.contextItems.map(async (item) => {
      if (item.kind === 'text') return { label: item.label, content: item.text }
      let content: string | undefined
      try {
        if (fileSystem !== undefined) {
          const target = await fileSystem.resolve(item.path)
          content = await fileSystem.readText(target, signal)
        } else {
          signal.throwIfAborted()
          content = await readFile(item.path, 'utf8')
        }
      } catch {
        content = undefined
      }
      return { label: item.label, content: content ?? unavailableFileLine(item.label, item.path) }
    }))
    const recalled = materialized.filter(item => item.label.startsWith(RECALL_LABEL_PREFIX))
    return [...materialized.filter(item => !item.label.startsWith(RECALL_LABEL_PREFIX)), ...recalled]
  }

  /** Decide whether the admitted batch needs a fresh brief and append it. */
  const injectBrief = async (
    session: Session,
    membership: { id: WorkspaceId; title: string; path: string },
    decision: Extract<PreStepDecision, { kind: 'enter' }>,
    signal: AbortSignal,
  ): Promise<PreStepDecision> => {
    const scope = scopeOf(membership.id)
    const record = ctx.evolutionMemory.read(scope)
    // An absent record digests as 'empty' and carries no sections, so the
    // content check below subsumes both: nothing to inject either way.
    if (record === undefined) return decision
    const digest = ctx.evolutionMemory.digest(scope)
    const sessionKey = String(session.id)
    if (injectedDigests.get(sessionKey) === digest) return decision
    const claimed = claimedDigest(decision.messages)
    if (claimed === digest) {
      injectedDigests.set(sessionKey, digest)
      return decision
    }
    if (claimed === undefined && await newestLoggedDigest(session) === digest) {
      injectedDigests.set(sessionKey, digest)
      return decision
    }
    const hasContent = record.instructions.length > 0
      || record.agentLessons.length > 0
      || record.userProfile.length > 0
      || record.contextItems.length > 0
    if (!hasContent) return decision

    const materialized = await materializeContext(record, signal)
    const usage = ctx.evolutionMemory.usage(scope)
    const briefInput = {
      title: membership.title,
      path: membership.path,
      usage: { usedBytes: usage.usedBytes, capacityBytes: usage.capacityBytes },
      capacityWarnPct,
      instructions: record.instructions,
      lessons: record.agentLessons,
      profile: record.userProfile,
      context: materialized,
    }
    const text = renderEvolutionBrief(briefInput, maxBytes)
    const sections = evolutionBriefSections(briefInput, maxBytes)
    // Rendered text is empty exactly when every section is empty, which
    // hasContent above already excludes: reaching here always injects.
    const brief = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'evolution-memory', form: 'snapshot', scopeId: scope, digest, sections, supersedes: true },
    })
    injectedDigests.set(sessionKey, digest)
    return { ...decision, messages: [...decision.messages, brief] }
  }

  ctx.on('agent/pre-step', async (input, next): Promise<PreStepDecision> => {
    const decision = await next()
    const membership = decision.kind === 'reject' || input.signal.aborted
      ? undefined
      : await resolveWorkspace(input.agent.session)
    if (decision.kind === 'reject' || membership === undefined) return decision
    return injectBrief(input.agent.session, membership, decision, input.signal)
  })
}
