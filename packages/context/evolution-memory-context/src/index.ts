/**
 * Evolution memory brief injector. At each eligible pre-step the injector
 * compares the record's digest against the newest visible `user/message`
 * with an `evolution-memory` source and appends exactly one complete fresh
 * brief when they differ. It also owns the evolution nudge sections behind
 * the system prompt: each section carries the lines of the recorded
 * conditions that fired (`conditions.ts`) and renders nothing while none
 * holds, so the prompt gains a nudge only when a mounted store reports
 * something to act on. Capacity usage is reported only in the brief, never
 * interpolated into the system prompt, so a memory write never invalidates
 * the request's cached prefix on its own.
 * When `agent-context` is mounted, the injector also registers the rendered brief as a
 * required, untrusted memory source for compiler placements.
 * @module @deepseek-ai/dsh-evolution-memory-context
 */

import { realpath } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ContextItem } from '@deepseek-ai/dsh-agent-context'
import z from '@deepseek-ai/schemastery'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-evolution-memory'
import type {} from '@deepseek-ai/dsh-evolution-benchmark'
import type {} from '@deepseek-ai/dsh-evolution-feedback'
import type {} from '@deepseek-ai/dsh-evolution-graph'
import type {} from '@deepseek-ai/dsh-evolution-skill-telemetry'
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
  nudgeDue,
} from './sections.ts'
import {
  NUDGE_CONDITIONS,
  NUDGE_EVALUATORS,
  type NudgeDeps,
  type NudgeEvidence,
  type NudgeSection,
} from './conditions.ts'

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
  nudgeDue,
} from './sections.ts'
export {
  NUDGE_CONDITIONS,
  NUDGE_EVALUATORS,
  contradictedClaimLine,
  failureSignalLine,
  holdoutGapLine,
  skillTrustLine,
  stagedWriteLine,
  unevaluableLine,
} from './conditions.ts'
export type {
  NudgeCondition,
  NudgeConditionId,
  NudgeDeps,
  NudgeEvidence,
  NudgeEvaluator,
  NudgeSection,
} from './conditions.ts'

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
  /** Current briefs set this; older session entries may omit it. */
  supersedes?: true
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
  /** Ceiling on memory-condition nudges: a condition that fired stays quiet for this many further turns. */
  memoryNudgeInterval?: number
  /** Ceiling on skill-condition nudges: a condition that fired stays quiet for this many further turns. */
  skillNudgeInterval?: number
  /** Minutes a staged write may wait before the memory nudge names it. */
  stagedWriteWaitMinutes?: number
  /** Failure signals one nudge evaluation grades. */
  failureSignalScanLimit?: number
  /** Usage ratio at or above which the brief header warns to consolidate. */
  capacityWarnPct?: number
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  maxBytes: z.number().step(1).min(1).required(),
  profile: z.string().required(),
  memoryNudgeInterval: z.number().step(1).min(1).default(1),
  skillNudgeInterval: z.number().step(1).min(1).default(10),
  stagedWriteWaitMinutes: z.number().min(0).default(1440),
  failureSignalScanLimit: z.number().step(1).min(1).default(20),
  capacityWarnPct: z.number().min(0).max(1).default(0.8),
})

/** Plugin configuration with the optional nudge cadences resolved. */
export interface ResolvedConfig {
  /** Cap on the complete emitted text including the frame. */
  maxBytes: number
  /** Scope-identity namespace placed before the workspace key. */
  profile: string
  /** Ceiling on memory-condition nudges, in turns. */
  memoryNudgeInterval: number
  /** Ceiling on skill-condition nudges, in turns. */
  skillNudgeInterval: number
  /** Minutes a staged write may wait before the memory nudge names it. */
  stagedWriteWaitMinutes: number
  /** Failure signals one nudge evaluation grades. */
  failureSignalScanLimit: number
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
    stagedWriteWaitMinutes: config.stagedWriteWaitMinutes ?? 1440,
    failureSignalScanLimit: config.failureSignalScanLimit ?? 20,
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

function evolutionMemoryDigest(message: UserMessage): string | undefined {
  const source = message.source as { kind?: string; digest?: unknown } | undefined
  return source?.kind === 'evolution-memory' && typeof source.digest === 'string' ? source.digest : undefined
}

function evolutionMemoryScope(message: UserMessage): string | undefined {
  const source = message.source as { kind?: string; scopeId?: unknown } | undefined
  return source?.kind === 'evolution-memory' && typeof source.scopeId === 'string' ? source.scopeId : undefined
}

function textOfUserMessage(message: UserMessage): string {
  let text = ''
  for (const block of message.content) {
    if (block.type === 'text') text += (block as { text: string }).text
  }
  return text
}

function claimedBrief(claimed: readonly UserMessage[]): UserMessage | undefined {
  for (let index = claimed.length - 1; index >= 0; index -= 1) {
    const message = claimed[index]
    if (message !== undefined && evolutionMemoryDigest(message) !== undefined) return message
  }
  return undefined
}

/** The registry's view of the workspace a session belongs to. */
interface Membership {
  id: WorkspaceId
  title: string
  path: string
  /** Sessions the workspace owns, which scope the failure evidence a nudge reads. */
  sessionIds: readonly SessionId[]
}

interface RenderedBrief {
  readonly scope: EvolutionScopeId
  readonly digest: string
  readonly text: string
  readonly sections: readonly ContextSnapshotSection[]
}

/**
 * Register pre-step brief injection, its optional compiler source, and the
 * nudge sections for the lifetime of `ctx`.
 * @param ctx - plugin context; listeners dispose with it.
 * @param config - byte cap on the complete brief and scope namespace.
 */
export function apply(ctx: Context, config: Config): void {
  const {
    maxBytes,
    profile,
    memoryNudgeInterval,
    skillNudgeInterval,
    stagedWriteWaitMinutes,
    failureSignalScanLimit,
    capacityWarnPct,
  } = resolveConfig(config)
  checkProfile(profile)
  const workspaceBySession = new Map<string, WorkspaceId | null>()
  const injectedDigests = new Map<string, string>()
  const renderedBriefs = new Map<string, RenderedBrief>()
  const turnsBySession = new Map<string, number>()
  const nudgeFiredTurns = new Map<string, number>()
  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    if (event.type !== 'turn/start') return
    const key = String(session.id)
    turnsBySession.set(key, (turnsBySession.get(key) ?? 0) + 1)
  })
  ctx.on('session/disposed', (session: Session) => {
    const key = String(session.id)
    workspaceBySession.delete(key)
    injectedDigests.delete(key)
    renderedBriefs.delete(key)
    turnsBySession.delete(key)
    for (const nudgeKey of [...nudgeFiredTurns.keys()]) {
      if (nudgeKey.startsWith(`${key}\u0000`)) nudgeFiredTurns.delete(nudgeKey)
    }
  })
  ctx.effect(() => () => {
    workspaceBySession.clear()
    injectedDigests.clear()
    turnsBySession.clear()
    nudgeFiredTurns.clear()
    renderedBriefs.clear()
  }, 'evolution-memory-context.cache')

  const scopeOf = (workspaceId: WorkspaceId): EvolutionScopeId => EvolutionScopeId(profile, String(workspaceId))

  const toMembership = (
    workspace: { id: WorkspaceId; title: string; path: string; sessionIds: readonly SessionId[] },
  ): Membership => ({
    id: workspace.id,
    title: workspace.title,
    path: workspace.path,
    sessionIds: workspace.sessionIds,
  })

  const memberBySession = (session: Session): Membership | undefined => {
    const key = String(session.id)
    const cached = workspaceBySession.get(key)
    if (cached === null) return undefined
    if (cached !== undefined) {
      const workspace = ctx.workspaceRegistry.get(cached)
      if (workspace !== undefined) return toMembership(workspace)
      workspaceBySession.delete(key)
    }
    const found = ctx.workspaceRegistry.list().find(entry => entry.sessionIds.includes(session.id))
    if (found === undefined) return undefined
    workspaceBySession.set(key, found.id)
    return toMembership(found)
  }

  const resolveWorkspace = async (session: Session): Promise<Membership | undefined> => {
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
    return toMembership(match)
  }

  const newestLoggedBrief = async (session: Session): Promise<UserMessage | undefined> => {
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
      const message = event.data as UserMessage
      if (evolutionMemoryDigest(message) !== undefined) return message
    }
    return undefined
  }

  /**
   * Evaluate one section's recorded conditions for this assembly and join the
   * lines that fired. Each condition renders at most once per configured
   * interval — the turn it fired on is remembered — and a store that is not
   * mounted renders its own notice instead of leaving its condition quietly
   * absent.
   */
  const sectionText = (section: NudgeSection, context: AssembleContext): string => {
    const session = context.agent?.session
    if (session === undefined) return ''
    const member = memberBySession(session)
    const evidence: NudgeEvidence = {
      scope: member === undefined ? undefined : scopeOf(member.id),
      sessionIds: member?.sessionIds.map(String) ?? [],
      now: Date.now(),
    }
    const deps: NudgeDeps = {
      record: evidence.scope === undefined ? undefined : ctx.evolutionMemory.read(evidence.scope),
      graph: ctx.get('evolutionGraph'),
      feedback: ctx.get('evolutionFeedback'),
      telemetry: ctx.get('evolutionSkillTelemetry'),
      benchmark: ctx.get('evolutionBenchmark'),
      stagedWriteWaitMinutes,
      failureSignalScanLimit,
    }
    const sessionKey = String(session.id)
    const turn = turnsBySession.get(sessionKey) ?? 0
    const interval = section === 'memory' ? memoryNudgeInterval : skillNudgeInterval
    const lines: string[] = []
    for (const condition of NUDGE_CONDITIONS) {
      if (condition.section !== section) continue
      const key = `${sessionKey}\u0000${condition.id}`
      if (!nudgeDue(nudgeFiredTurns.get(key), turn, interval)) continue
      const line = NUDGE_EVALUATORS[condition.id](condition, evidence, deps)
      if (line === undefined) continue
      nudgeFiredTurns.set(key, turn)
      lines.push(line)
    }
    return lines.join(' ')
  }

  const prompt = ctx.get('systemPrompt')
  if (prompt !== undefined) {
    const tools = ctx.get('tools')
    const sections = [
      {
        def: LESSONS_SKILLS_SECTION,
        text: (context: AssembleContext) => tools?.get(SKILL_MANAGE_TOOL, context.scope) === undefined
          ? ''
          : sectionText('skills', context),
      },
      { def: MEMORY_SCOPE_SECTION, text: (context: AssembleContext) => sectionText('memory', context) },
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

  const renderBrief = async (
    session: Session,
    member: Membership,
    signal: AbortSignal,
  ): Promise<RenderedBrief | undefined> => {
    const sessionKey = String(session.id)
    const scope = scopeOf(member.id)
    const record = ctx.evolutionMemory.read(scope)
    if (record === undefined) {
      renderedBriefs.delete(sessionKey)
      injectedDigests.delete(sessionKey)
      return undefined
    }
    const digest = ctx.evolutionMemory.digest(scope)
    const cached = renderedBriefs.get(sessionKey)
    if (cached?.scope === scope && cached.digest === digest) return cached

    const hasContent = record.instructions.length > 0
      || record.agentLessons.length > 0
      || record.userProfile.length > 0
      || record.contextItems.length > 0
    if (!hasContent) {
      renderedBriefs.delete(sessionKey)
      injectedDigests.delete(sessionKey)
      return undefined
    }

    const logged = await newestLoggedBrief(session)
    if (logged !== undefined
      && evolutionMemoryDigest(logged) === digest
      && evolutionMemoryScope(logged) === String(scope)) {
      const brief: RenderedBrief = { scope, digest, text: textOfUserMessage(logged), sections: [] }
      renderedBriefs.set(sessionKey, brief)
      injectedDigests.set(sessionKey, digest)
      return brief
    }

    const materialized = await materializeContext(record, signal)
    const usage = ctx.evolutionMemory.usage(scope)
    const briefInput = {
      title: member.title,
      path: member.path,
      usage: { usedBytes: usage.usedBytes, capacityBytes: usage.capacityBytes },
      capacityWarnPct,
      instructions: record.instructions,
      lessons: record.agentLessons,
      profile: record.userProfile,
      context: materialized,
    }
    const brief: RenderedBrief = {
      scope,
      digest,
      text: renderEvolutionBrief(briefInput, maxBytes),
      sections: evolutionBriefSections(briefInput, maxBytes),
    }
    renderedBriefs.set(sessionKey, brief)
    return brief
  }

  ctx.inject(['agentContext'], agentContextCtx => {
    agentContextCtx.effect(() => agentContextCtx.agentContext.register({
      producer: 'evolution-memory',
      kind: 'memory',
      trust: 'untrusted',
      placement: 'stable-core',
      maxBytes,
    }, async (agent, signal): Promise<readonly ContextItem[]> => {
      const member = await resolveWorkspace(agent.session)
      if (member === undefined) {
        const key = String(agent.session.id)
        renderedBriefs.delete(key)
        injectedDigests.delete(key)
        return []
      }
      const brief = await renderBrief(agent.session, member, signal)
      return brief === undefined ? [] : [{ id: 'brief', text: brief.text, relevance: 1 }]
    }))
  })

  /** Decide whether the admitted batch needs a fresh brief and append it. */
  const injectBrief = async (
    session: Session,
    member: Membership,
    decision: Extract<PreStepDecision, { kind: 'enter' }>,
    signal: AbortSignal,
  ): Promise<PreStepDecision> => {
    const sessionKey = String(session.id)
    const rendered = await renderBrief(session, member, signal)
    if (rendered === undefined) return decision
    const { scope, digest } = rendered
    if (injectedDigests.get(sessionKey) === digest) return decision
    const claimed = claimedBrief(decision.messages)
    if (claimed !== undefined
      && evolutionMemoryDigest(claimed) === digest
      && evolutionMemoryScope(claimed) === String(scope)) {
      renderedBriefs.set(sessionKey, { ...rendered, text: textOfUserMessage(claimed) })
      injectedDigests.set(sessionKey, digest)
      return decision
    }
    const brief = createUserMessage({
      content: [{ type: 'text', text: rendered.text }],
      source: { kind: 'evolution-memory', form: 'snapshot', scopeId: scope, digest, sections: rendered.sections, supersedes: true },
    })
    injectedDigests.set(sessionKey, digest)
    return { ...decision, messages: [...decision.messages, brief] }
  }

  ctx.on('agent/pre-step', async (input, next): Promise<PreStepDecision> => {
    const decision = await next()
    const membership = decision.kind === 'reject' || input.signal.aborted
      ? undefined
      : await resolveWorkspace(input.agent.session)
    if (decision.kind === 'reject') return decision
    if (membership === undefined) {
      const key = String(input.agent.session.id)
      renderedBriefs.delete(key)
      injectedDigests.delete(key)
      return decision
    }
    return injectBrief(input.agent.session, membership, decision, input.signal)
  })
}
