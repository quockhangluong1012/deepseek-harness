import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import EvolutionBenchmark from '@deepseek-ai/dsh-evolution-benchmark'
import EvolutionFeedback from '@deepseek-ai/dsh-evolution-feedback'
import EvolutionGraph from '@deepseek-ai/dsh-evolution-graph'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import EvolutionMemoryStore from '@deepseek-ai/dsh-evolution-memory'
import EvolutionSkillTelemetry from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as evolutionMemoryContext from '../src/index.ts'
import {
  LESSONS_SKILLS_SECTION,
  MEMORY_SCOPE_SECTION,
  SESSION_SEARCH_SECTION,
  nudgeDue,
} from '../src/sections.ts'

/** Optional evolution stores a nudge test mounts; an omission is the unmounted case. */
type Store = 'feedback' | 'graph' | 'benchmark' | 'telemetry'

interface NudgeHarness {
  ctx: Context
  fiber: { dispose(): Promise<void> }
  scope: EvolutionScopeId
  session: Session
  sibling: Session
  disposeSession: (session: Session) => void
}

/**
 * Mount the prompt, the memory store, the sessions, and whichever sibling
 * evolution stores the test needs, plus the registry that makes the two
 * sessions one scope.
 */
async function nudgeHarness(options: {
  stores?: readonly Store[]
  config?: {
    memoryNudgeInterval?: number
    skillNudgeInterval?: number
    stagedWriteWaitMinutes?: number
  }
  skillTool?: boolean
} = {}): Promise<NudgeHarness> {
  const stores = new Set(options.stores ?? [])
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 65536 })
  await ctx.plugin(SessionStore)
  if (stores.has('feedback')) await ctx.plugin(EvolutionFeedback, {})
  if (stores.has('graph')) await ctx.plugin(EvolutionGraph, {})
  if (stores.has('benchmark')) await ctx.plugin(EvolutionBenchmark, {})
  if (stores.has('telemetry')) {
    ctx.provide('skills', { list: async () => [] } as never)
    await ctx.plugin(EvolutionSkillTelemetry, {})
  }
  const sessions = [
    ctx.sessions.create(SessionId('nudge-s1'), { meta: { cwd: '/work' } }),
    ctx.sessions.create(SessionId('nudge-s2'), { meta: { cwd: '/work' } }),
  ]
  const scope = EvolutionScopeId('test', 'ws-nudge')
  ctx.provide('workspaceRegistry', {
    list: () => [{
      id: WorkspaceId('ws-nudge'),
      title: 'Project',
      path: '/work',
      sessionIds: sessions.map(session => session.id),
    }],
    get: () => undefined,
  } as never)
  ctx.provide('tools', {
    get: (name: string) => name === 'skill_manage' && options.skillTool !== false ? {} : undefined,
  } as never)
  const fiber = await ctx.plugin(evolutionMemoryContext, { maxBytes: 8192, profile: 'test', ...options.config })
  return {
    ctx,
    fiber,
    scope,
    session: sessions[0] as Session,
    sibling: sessions[1] as Session,
    disposeSession: (session: Session) =>{  ctx.emit('session/disposed', session) },
  }
}

/** Count `turns` further observed turns, then render the prompt the assembly would send. */
async function nudgePrompt(ctx: Context, session: Session, turns = 0): Promise<string> {
  for (let turn = 0; turn < turns; turn += 1) {
    ctx.emit('session/event', session, { type: 'turn/start' } as never)
  }
  const agent = { id: String(session.id), session } as unknown as Agent
  return renderPrompt(await ctx.systemPrompt.assemble({ agent }))
}

/** Append one failing tool call and its result, as the feedback store observes them. */
function appendFailure(session: Session, turn: number, text: string): void {
  const callId = ToolCallId(`call-${String(session.id)}-${turn}`)
  session.append('turn/start', { turn })
  session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: true }),
  }, { surfaceOp: 'append' })
}

const SCOPE_FRAGMENT = 'Staged writes:'

describe('evolution nudge sections', () => {
  const harnesses: { fiber: { dispose(): Promise<void> } }[] = []
  afterEach(async () => {
    for (const harness of harnesses.splice(0)) await harness.fiber.dispose()
  })
  const keep = <T extends { fiber: { dispose(): Promise<void> } }>(harness: T): T => {
    harnesses.push(harness)
    return harness
  }

  it('pins the registered names and orders', () => {
    expect(LESSONS_SKILLS_SECTION.name).toBe('evolution-lessons-skills')
    expect(MEMORY_SCOPE_SECTION.name).toBe('evolution-memory-scope')
    expect(SESSION_SEARCH_SECTION.name).toBe('evolution-session-search')
    expect(new Set([
      LESSONS_SKILLS_SECTION.order,
      MEMORY_SCOPE_SECTION.order,
      SESSION_SEARCH_SECTION.order,
    ]).size).toBe(3)
  })

  it('caps a fired condition at its interval and repeats within one turn', () => {
    expect(nudgeDue(undefined, 0, 5)).toBe(true)
    expect(nudgeDue(4, 4, 5)).toBe(true)
    expect(nudgeDue(4, 5, 5)).toBe(false)
    expect(nudgeDue(4, 9, 5)).toBe(true)
    expect(nudgeDue(4, 10, 1)).toBe(true)
  })

  it('resolves the shipped cadence and threshold defaults', () => {
    expect(evolutionMemoryContext.resolveConfig({ maxBytes: 8, profile: 'p' })).toEqual({
      maxBytes: 8,
      profile: 'p',
      memoryNudgeInterval: 1,
      skillNudgeInterval: 10,
      stagedWriteWaitMinutes: 1440,
      failureSignalScanLimit: 20,
      capacityWarnPct: 0.8,
    })
    expect(evolutionMemoryContext.resolveConfig({
      maxBytes: 9,
      profile: 'q',
      memoryNudgeInterval: 2,
      skillNudgeInterval: 3,
      stagedWriteWaitMinutes: 5,
      failureSignalScanLimit: 6,
      capacityWarnPct: 0.4,
    })).toEqual({
      maxBytes: 9,
      profile: 'q',
      memoryNudgeInterval: 2,
      skillNudgeInterval: 3,
      stagedWriteWaitMinutes: 5,
      failureSignalScanLimit: 6,
      capacityWarnPct: 0.4,
    })
  })

  it('renders nothing while no recorded condition holds', async () => {
    const h = keep(await nudgeHarness({ stores: ['feedback', 'graph', 'benchmark', 'telemetry'] }))
    const prompt = await nudgePrompt(h.ctx, h.session)
    expect(prompt).toContain(SESSION_SEARCH_SECTION.text)
    expect(prompt).not.toContain(SCOPE_FRAGMENT)
    expect(prompt).not.toContain('Contradicted claims:')
    expect(prompt).not.toContain('Skill trust:')
    expect(prompt).not.toContain('Failure signals:')
    expect(prompt).not.toContain('Benchmark holdouts:')
  })

  it('names the condition each mounted store reports', async () => {
    const h = keep(await nudgeHarness({
      stores: ['feedback', 'graph', 'benchmark', 'telemetry'],
      config: { stagedWriteWaitMinutes: 0 },
    }))
    await h.ctx.evolutionMemory.stageWrite({
      scopeId: h.scope,
      kind: 'memory',
      op: 'setInstructions',
      payload: { text: 'rules' },
      originSessionId: String(h.session.id),
      gist: 'rules from the reviewer',
    })
    await h.ctx.evolutionGraph.recordClaims(h.scope, [{
      statement: 'the cache is warm',
      contradictedBy: [{ source: 'session-9' }],
    }])
    await h.ctx.evolutionBenchmark.admit([
      { capability: 'writer', task: 'patch the writer', gists: ['boom'], sourceSessions: ['s1'] },
    ])
    await h.ctx.evolutionSkillTelemetry.markUsed('catalog', 'user-dsh', String(h.session.id))
    await h.ctx.evolutionSkillTelemetry.recordTrustObservation('catalog', 'failure', String(h.session.id))
    appendFailure(h.session, 1, 'command not found')
    appendFailure(h.sibling, 1, 'command not found')
    await vi.waitFor(() => {
      expect(h.ctx.evolutionFeedback.signals([String(h.session.id), String(h.sibling.id)], 20)
        .filter(signal => signal.actionability === 'trigger_review')).toHaveLength(1)
    })

    const prompt = await nudgePrompt(h.ctx, h.session)
    expect(prompt).toContain('Staged writes: 1 pending')
    expect(prompt).toContain('run /memory pending.')
    expect(prompt).toContain('Contradicted claims: 1 active claim with contradicting evidence; run /claims.')
    expect(prompt).toContain('Benchmark holdouts: 1 under evaluation with no holdout task; run /benchmark.')
    expect(prompt).toContain('Skill trust: 1 provisional after a recorded failure; run /curator status.')
    expect(prompt).toContain('Failure signals: 1 at the review threshold')
    expect(prompt).toContain('record the durable lesson with skill_manage.')
  })

  it('names an unmounted store and keeps the mounted conditions working', async () => {
    const h = keep(await nudgeHarness({ stores: ['benchmark'], config: { stagedWriteWaitMinutes: 0 } }))
    await h.ctx.evolutionMemory.stageWrite({
      scopeId: h.scope,
      kind: 'memory',
      op: 'setInstructions',
      payload: { text: 'rules' },
      originSessionId: String(h.session.id),
      gist: 'rules',
    })
    await h.ctx.evolutionBenchmark.admit([
      { capability: 'reader', task: 'read a file', gists: [], sourceSessions: [] },
    ])
    const prompt = await nudgePrompt(h.ctx, h.session)
    expect(prompt).toContain('contradicted claims cannot be checked: the evolutionGraph store is not mounted.')
    expect(prompt).toContain('skill trust cannot be checked: the evolutionSkillTelemetry store is not mounted.')
    expect(prompt).toContain('failure signals cannot be checked: the evolutionFeedback store is not mounted.')
    expect(prompt).toContain(SCOPE_FRAGMENT)
    expect(prompt).toContain('Benchmark holdouts: 1 under evaluation')
  })

  it('keeps a standing condition quiet for the interval and fires again after it', async () => {
    const h = keep(await nudgeHarness({
      stores: ['benchmark'],
      config: { memoryNudgeInterval: 3, stagedWriteWaitMinutes: 0 },
    }))
    await h.ctx.evolutionMemory.stageWrite({
      scopeId: h.scope,
      kind: 'memory',
      op: 'setInstructions',
      payload: { text: 'rules' },
      originSessionId: String(h.session.id),
      gist: 'rules',
    })
    // The same turn's assemblies agree: the condition fired for the turn.
    expect(await nudgePrompt(h.ctx, h.session, 1)).toContain(SCOPE_FRAGMENT)
    expect(await nudgePrompt(h.ctx, h.session)).toContain(SCOPE_FRAGMENT)
    expect(await nudgePrompt(h.ctx, h.session, 1)).not.toContain(SCOPE_FRAGMENT)
    expect(await nudgePrompt(h.ctx, h.session, 1)).not.toContain(SCOPE_FRAGMENT)
    expect(await nudgePrompt(h.ctx, h.session, 1)).toContain(SCOPE_FRAGMENT)

    // A sibling session runs its own cadence, and disposing one leaves the other alone.
    expect(await nudgePrompt(h.ctx, h.sibling, 2)).toContain(SCOPE_FRAGMENT)
    h.disposeSession(h.sibling)
    expect(await nudgePrompt(h.ctx, h.session, 1)).not.toContain(SCOPE_FRAGMENT)
    expect(await nudgePrompt(h.ctx, h.session, 2)).toContain(SCOPE_FRAGMENT)
  })

  it('drops the skill conditions while the skill tool is invisible', async () => {
    const hidden = keep(await nudgeHarness({ stores: ['benchmark'], skillTool: false }))
    await hidden.ctx.evolutionBenchmark.admit([
      { capability: 'writer', task: 'patch the writer', gists: [], sourceSessions: [] },
    ])
    const hiddenPrompt = await nudgePrompt(hidden.ctx, hidden.session)
    expect(hiddenPrompt).not.toContain('Benchmark holdouts:')
    expect(hiddenPrompt).not.toContain('skill_manage')

    const visible = keep(await nudgeHarness({ stores: ['benchmark'] }))
    await visible.ctx.evolutionBenchmark.admit([
      { capability: 'writer', task: 'patch the writer', gists: [], sourceSessions: [] },
    ])
    expect(await nudgePrompt(visible.ctx, visible.session)).toContain('Benchmark holdouts: 1 under evaluation')
  })

  it('leaves a session outside every workspace without scope conditions', async () => {
    const h = keep(await nudgeHarness({
      stores: ['graph', 'benchmark'],
      config: { stagedWriteWaitMinutes: 0 },
    }))
    await h.ctx.evolutionMemory.stageWrite({
      scopeId: h.scope,
      kind: 'memory',
      op: 'setInstructions',
      payload: { text: 'rules' },
      originSessionId: String(h.session.id),
      gist: 'rules',
    })
    await h.ctx.evolutionGraph.recordClaims(h.scope, [{
      statement: 'the cache is warm',
      contradictedBy: [{ source: 'session-9' }],
    }])
    await h.ctx.evolutionBenchmark.admit([
      { capability: 'reader', task: 'read a file', gists: [], sourceSessions: [] },
    ])
    const outsider = h.ctx.sessions.create(SessionId('nudge-outside'), { meta: { cwd: '/elsewhere' } })
    const prompt = await nudgePrompt(h.ctx, outsider)
    expect(prompt).not.toContain(SCOPE_FRAGMENT)
    expect(prompt).not.toContain('Contradicted claims:')
    expect(prompt).toContain('Benchmark holdouts: 1 under evaluation')
  })

  it('assembles without a session and keeps the fixed hint', async () => {
    const h = keep(await nudgeHarness({ stores: ['benchmark'] }))
    await h.ctx.evolutionBenchmark.admit([
      { capability: 'writer', task: 'patch the writer', gists: [], sourceSessions: [] },
    ])
    const assembly = await h.ctx.systemPrompt.assemble({})
    expect(assembly.sections.map(section => section.name)).toContain('evolution-session-search')
    const prompt = renderPrompt(assembly)
    expect(prompt).toContain(SESSION_SEARCH_SECTION.text)
    expect(prompt).not.toContain('Benchmark holdouts:')
    expect(prompt).not.toContain('skill_manage')
  })

  it('keeps the system prompt byte-identical across a memory write (cache-prefix stability)', async () => {
    const h = keep(await nudgeHarness({ stores: ['feedback', 'graph', 'benchmark', 'telemetry'] }))
    const before = await nudgePrompt(h.ctx, h.session)
    // A memory write changes usage (0 -> 5 bytes charged) but the system
    // prompt must not reflect it: usage belongs to the brief, not this tier.
    await h.ctx.evolutionMemory.setInstructions(h.scope, 'rules')
    const after = await nudgePrompt(h.ctx, h.session)
    expect(after).toBe(before)
    expect(after).not.toMatch(/usage/)
  })
})
