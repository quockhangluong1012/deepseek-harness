import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { EvolutionScopeId, type LessonArtifactInput } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionScopeId as ScopeId } from '@deepseek-ai/dsh-evolution-memory/types'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as evolutionMemoryContext from '../src/index.ts'

const SIGNAL = new AbortController().signal

/** One lesson artifact candidate for the store's addArtifact write. */
function lessonInput(statement: string): LessonArtifactInput {
  return { statement, source: 's1', conditions: '', evidence: 'fact', confidence: 0.9, scope: 'project' }
}

interface Harness {
  ctx: Context
  fiber: { dispose(): Promise<void> }
  workspaces: Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>
  dir: string
  scope: (name: string) => ScopeId
}

async function harness(config: { maxBytes: number } = { maxBytes: 8192 }): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'evc-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const { default: EvolutionMemoryStore } = await import('@deepseek-ai/dsh-evolution-memory')
  await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 65536 })
  await ctx.plugin(SessionStore)
  const workspaces = new Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>()
  ctx.provide('workspaceRegistry', {
    list: () => [...workspaces.values()],
    get: (id: WorkspaceId) => workspaces.get(String(id)),
  } as never)
  const fiber = await ctx.plugin(evolutionMemoryContext, { ...config, profile: 'test' })
  return { ctx, fiber, workspaces, dir, scope: (name: string) => EvolutionScopeId('test', name) }
}

function sessionIn(ctx: Context, dir: string, name: string): Session {
  return ctx.sessions.create(SessionId(name), { meta: { cwd: dir } })
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as Agent
}

function briefsOf(messages: readonly UserMessage[]): UserMessage[] {
  return messages.filter(message => (message.source as { kind?: string }).kind === 'evolution-memory')
}

function textOf(message: UserMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
}

async function preStep(ctx: Context, agent: Agent, messages: UserMessage[] = []) {
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [...messages] }),
  )
}

describe('evolution-memory-context injector', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('rejects a malformed profile at load', async () => {
    const loadMessage = async (profile?: string): Promise<string> => {
      const ctx = new Context()
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      ctx.provide('evolutionMemory', {} as never)
      // The final cast simulates schema-external input: the schema itself
      // rejects an omitted profile before apply runs.
      const config = profile === undefined
        ? { maxBytes: 8 }
        : { maxBytes: 8, profile }
      try {
        await ctx.plugin(evolutionMemoryContext, config as { maxBytes: number; profile: string })
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      return 'loaded'
    }
    expect(await loadMessage('')).toContain('profile must be non-empty')
    expect(await loadMessage('a:b')).toContain("must not contain ':'")
    expect(await loadMessage()).not.toBe('loaded')
    expect(await loadMessage('ok')).toBe('loaded')
  })

  it('rejects out-of-range nudge configuration at load', async () => {
    const loadMessage = async (config: {
      memoryNudgeInterval?: number
      skillNudgeInterval?: number
      stagedWriteWaitMinutes?: number
      failureSignalScanLimit?: number
      capacityWarnPct?: number
    }): Promise<string> => {
      const ctx = new Context()
      ctx.provide('workspaceRegistry', { list: () => [] } as never)
      ctx.provide('evolutionMemory', {} as never)
      try {
        await ctx.plugin(evolutionMemoryContext, { maxBytes: 8, profile: 'ok', ...config })
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
      return 'loaded'
    }
    expect(await loadMessage({ memoryNudgeInterval: 0 })).toMatch(/memoryNudgeInterval expected number >= 1/)
    expect(await loadMessage({ skillNudgeInterval: 0 })).toMatch(/skillNudgeInterval expected number >= 1/)
    expect(await loadMessage({ memoryNudgeInterval: -4 })).toMatch(/memoryNudgeInterval expected number >= 1/)
    expect(await loadMessage({ memoryNudgeInterval: 1, skillNudgeInterval: 10 })).toBe('loaded')
    expect(await loadMessage({ failureSignalScanLimit: 0 })).toMatch(/failureSignalScanLimit expected number >= 1/)
    expect(await loadMessage({ failureSignalScanLimit: 2.5 })).toMatch(/failureSignalScanLimit/)
    expect(await loadMessage({ stagedWriteWaitMinutes: -1 })).toMatch(/stagedWriteWaitMinutes/)
    expect(await loadMessage({ stagedWriteWaitMinutes: 0, failureSignalScanLimit: 5 })).toBe('loaded')
    expect(await loadMessage({ capacityWarnPct: 1.5 })).toMatch(/capacityWarnPct/)
    expect(await loadMessage({ capacityWarnPct: -0.1 })).toMatch(/capacityWarnPct/)
    expect(await loadMessage({ capacityWarnPct: 0.5 })).toBe('loaded')
  })

  it('injects one brief, skips the unchanged turn, and replaces on change', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'follow the guide')
      await ctx.evolutionMemory.addArtifact(id, lessonInput('the project is green'))
      await ctx.evolutionMemory.setUserProfile(id, 'likes brevity')

      const first = await preStep(ctx, fakeAgent(session))
      expect(first.kind).toBe('enter')
      const briefs = briefsOf(first.kind === 'enter' ? first.messages : [])
      expect(briefs).toHaveLength(1)
      const digest = (briefs[0]?.source as { digest: string }).digest
      const text = textOf(briefs[0] as UserMessage)
      expect(text).toContain('follow the guide')
      expect(text).toContain('the project is green')
      expect(text).toContain('likes brevity')
      expect(text).toContain('Memory usage: ')
      expect(ctx.evolutionMemory.digest(id)).toBe(digest)
      // Presented as distinct named parts, not one undifferentiated block.
      const source = briefs[0]?.source as unknown as { form: string; sections: { name: string; text: string }[] }
      expect(source.form).toBe('snapshot')
      expect(source.sections.map(section => section.name)).toEqual([
        'Overview', 'Instructions', 'Lessons', 'User profile',
      ])
      expect(source.sections.find(section => section.name === 'Instructions')?.text).toBe('follow the guide')
      session.append('user/message', briefs[0] as UserMessage, { surfaceOp: 'append' })

      const second = await preStep(ctx, fakeAgent(session))
      expect(second.kind).toBe('enter')
      expect(briefsOf(second.kind === 'enter' ? second.messages : [])).toHaveLength(0)

      await ctx.evolutionMemory.setInstructions(id, 'follow the new guide')
      const third = await preStep(ctx, fakeAgent(session))
      const replaced = briefsOf(third.kind === 'enter' ? third.messages : [])
      expect(replaced).toHaveLength(1)
      expect(textOf(replaced[0] as UserMessage)).toContain('follow the new guide')
      expect((replaced[0]?.source as { digest: string }).digest).not.toBe(digest)
    } finally {
      await fiber.dispose()
    }
  })

  it('skips the logged brief through the session query seam', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'follow the guide')
      const digest = ctx.evolutionMemory.digest(id)
      const logged = createUserMessage({
        content: [{ type: 'text', text: 'older brief' }],
        source: { kind: 'evolution-memory', form: 'snapshot', scopeId: id, digest, sections: [] },
      })
      let surface: { events: readonly { type: string; data: unknown }[] } | Error = {
        events: [{ type: 'user/message', data: { content: logged.content, source: logged.source } }],
      }
      ctx.provide('sessionQuery', {
        readSurface: async () => {
          if (surface instanceof Error) throw surface
          return { session: {}, inheritedEventCount: 0, capturedThroughSeq: 1, events: surface.events }
        },
      } as never)
      const decision = await preStep(ctx, fakeAgent(session))
      expect(decision.kind).toBe('enter')
      expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)

      // A surface with no current brief falls through to injecting.
      surface = {
        events: [
          { type: 'assistant/message', data: {} },
          { type: 'user/message', data: { content: [], source: { kind: 'user' } } },
          {
            type: 'user/message',
            data: { content: [], source: { kind: 'evolution-memory', form: 'instructions', scopeId: id } },
          },
        ],
      }
      const otherSession = sessionIn(ctx, dir, 's9')
      const missed = await preStep(ctx, fakeAgent(otherSession))
      expect(briefsOf(missed.kind === 'enter' ? missed.messages : [])).toHaveLength(1)

      // A failing surface read degrades to injecting.
      surface = new Error('surface offline')
      const other = sessionIn(ctx, dir, 's2')
      workspaces.set('ws-2', { id: WorkspaceId('ws-2'), title: 'Other', path: dir, sessionIds: [other.id] })
      await ctx.evolutionMemory.setInstructions(scope('ws-2'), 'other rules')
      const injected = await preStep(ctx, fakeAgent(other))
      expect(briefsOf(injected.kind === 'enter' ? injected.messages : [])).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('ignores claimed messages that are not the brief', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      const prompt = createUserMessage({
        content: [{ type: 'text', text: 'ordinary prompt' }],
        source: { kind: 'user' },
      })
      const decision = await agentEvents(ctx, fakeAgent(session)).waterfall(
        'agent/pre-step',
        { messages: [prompt], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [prompt] }),
      )
      expect(decision.kind).toBe('enter')
      expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('spreads the downstream decision, including startsRequestSeries', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      const decision = await agentEvents(ctx, fakeAgent(session)).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [], startsRequestSeries: true }),
      )
      expect(decision).toMatchObject({ kind: 'enter', startsRequestSeries: true })
      expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('leaves rejections, aborted signals, empty records, and outside sessions alone', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })

      const rejected = await agentEvents(ctx, fakeAgent(session)).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'reject' as const, reason: 'no' }),
      )
      expect(rejected.kind).toBe('reject')

      const aborted = new AbortController()
      aborted.abort()
      const cancelled = await agentEvents(ctx, fakeAgent(session)).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: aborted.signal },
        () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
      )
      expect(briefsOf(cancelled.kind === 'enter' ? cancelled.messages : [])).toHaveLength(0)

      // Empty record: nothing to inject.
      const empty = await preStep(ctx, fakeAgent(session))
      expect(briefsOf(empty.kind === 'enter' ? empty.messages : [])).toHaveLength(0)

      // Seeded-but-contentless record: outputs alone never inject.
      await ctx.evolutionMemory.recordOutputs(id, [
        { path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' },
      ])
      const outputsOnly = await preStep(ctx, fakeAgent(session))
      expect(briefsOf(outputsOnly.kind === 'enter' ? outputsOnly.messages : [])).toHaveLength(0)

      // Absent record: nothing to inject.
      const lone = sessionIn(ctx, dir, 'lone')
      const outside = await preStep(ctx, fakeAgent(lone))
      expect(briefsOf(outside.kind === 'enter' ? outside.messages : [])).toHaveLength(0)
      ctx.emit('session/disposed', lone)
    } finally {
      await fiber.dispose()
    }
  })

  it('falls back to a canonical-path match and forgets removed workspaces', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      // No sessionIds account: membership resolves through the session cwd.
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [] })
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      const first = await preStep(ctx, fakeAgent(session))
      expect(briefsOf(first.kind === 'enter' ? first.messages : [])).toHaveLength(1)

      // The cached workspace is gone: the next turn resolves to nothing.
      workspaces.clear()
      const second = await preStep(ctx, fakeAgent(session))
      expect(briefsOf(second.kind === 'enter' ? second.messages : [])).toHaveLength(0)

      // An unresolvable cwd never matches.
      const lost = sessionIn(ctx, join(dir, 'missing'), 'lost')
      const third = await preStep(ctx, fakeAgent(lost))
      expect(briefsOf(third.kind === 'enter' ? third.messages : [])).toHaveLength(0)

      // A resolvable cwd outside every workspace never matches either, as
      // does a session with no working directory at all.
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [] })
      const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'evc-else-')))
      dirs.push(elsewhere)
      const outsider = sessionIn(ctx, elsewhere, 'outsider')
      const fourth = await preStep(ctx, fakeAgent(outsider))
      expect(briefsOf(fourth.kind === 'enter' ? fourth.messages : [])).toHaveLength(0)
      const homeless = ctx.sessions.create(SessionId('homeless'))
      const fifth = await preStep(ctx, fakeAgent(homeless))
      expect(briefsOf(fifth.kind === 'enter' ? fifth.messages : [])).toHaveLength(0)
      const sixth = await preStep(ctx, fakeAgent(homeless))
      expect(briefsOf(sixth.kind === 'enter' ? sixth.messages : [])).toHaveLength(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('materializes text and file context and degrades missing files', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      const produced = join(dir, 'doc.md')
      await writeFile(produced, 'file words')
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      await ctx.evolutionMemory.addContextItem(id, { kind: 'text', label: 'note', text: 'pasted words' })
      await ctx.evolutionMemory.addContextItem(id, { kind: 'file', label: 'doc', path: produced, sizeBytes: 10 })
      await ctx.evolutionMemory.addContextItem(id, { kind: 'file', label: 'gone', path: join(dir, 'gone.md'), sizeBytes: 4 })
      const decision = await preStep(ctx, fakeAgent(session))
      const text = textOf(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0] as UserMessage)
      expect(text).toContain('pasted words')
      expect(text).toContain('file words')
      expect(text).toContain('Context "gone" is unavailable')
    } finally {
      await fiber.dispose()
    }
  })

  it('renders a recalled context item last so it drops first', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      // Recalled material lands in the record after the user's own item.
      await ctx.evolutionMemory.addContextItem(id, { kind: 'text', label: 'note', text: 'pasted words' })
      await ctx.evolutionMemory.addContextItem(id, { kind: 'text', label: 'Recall: s9', text: 'recalled words' })
      const decision = await preStep(ctx, fakeAgent(session))
      const text = textOf(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0] as UserMessage)
      expect(text.indexOf('recalled words')).toBeGreaterThan(text.indexOf('pasted words'))
      expect(text.indexOf('## Context: Recall: s9')).toBeGreaterThan(text.indexOf('## Context: note'))
    } finally {
      await fiber.dispose()
    }
  })

  it('drops the recalled item before user context under pressure', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      // Either item alone fits the default 8192-byte brief; together they do not.
      await ctx.evolutionMemory.addContextItem(id, { kind: 'text', label: 'Recall: s9', text: `recalled words ${'y'.repeat(4200)}` })
      await ctx.evolutionMemory.addContextItem(id, { kind: 'text', label: 'note', text: `pasted words ${'x'.repeat(4200)}` })
      const decision = await preStep(ctx, fakeAgent(session))
      const text = textOf(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0] as UserMessage)
      expect(text).toContain('pasted words')
      expect(text).not.toContain('recalled words')
      expect(text).toContain('omitted 1 context item')
    } finally {
      await fiber.dispose()
    }
  })

  it('reads file context through the fs provider when mounted', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      ctx.provide('fs', {
        resolve: async (path: string) => ({ path }),
        readText: async () => 'provider words',
      } as never)
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      await ctx.evolutionMemory.addContextItem(id, { kind: 'file', label: 'doc', path: join(dir, 'doc.md'), sizeBytes: 3 })
      const decision = await preStep(ctx, fakeAgent(session))
      const briefs = briefsOf(decision.kind === 'enter' ? decision.messages : [])
      expect(textOf(briefs[0] as UserMessage)).toContain('provider words')
    } finally {
      await fiber.dispose()
    }
  })

  it('treats an already-claimed brief as visible and skips sourceless lookalikes', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      const first = await preStep(ctx, fakeAgent(session))
      const brief = briefsOf(first.kind === 'enter' ? first.messages : [])[0] as UserMessage
      session.append('user/message', brief, { surfaceOp: 'append' })

      const prompt = createUserMessage({
        content: [{ type: 'text', text: 'ordinary prompt' }],
        source: { kind: 'user' },
      })
      const claimedLookalike = createUserMessage({
        content: [{ type: 'text', text: 'claimed lookalike' }],
        source: { kind: 'evolution-memory', form: 'instructions', scopeId: id } as never,
      })
      const claimed = await agentEvents(ctx, fakeAgent(session)).waterfall(
        'agent/pre-step',
        { messages: [prompt, brief, claimedLookalike], turn: 1, step: 2, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [prompt, brief, claimedLookalike] }),
      )
      expect(claimed.kind === 'enter' ? claimed.messages : []).toHaveLength(3)

      session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text: 'lookalike' }],
          source: { kind: 'evolution-memory', form: 'instructions', scopeId: id } as never,
        }),
        { surfaceOp: 'append' },
      )
      session.append(
        'assistant/message',
        {
          turn: 9,
          step: 1,
          message: createAssistantMessage({
            content: [{ type: 'text', text: 'model said' }],
            source: { provider: 'p', model: 'm' },
          }),
          stream: [],
        },
        { surfaceOp: 'append' },
      )
      await ctx.evolutionMemory.setInstructions(id, 'changed rules')
      const staleLookalike = createUserMessage({
        content: [{ type: 'text', text: 'stale lookalike' }],
        source: { kind: 'evolution-memory', form: 'instructions', scopeId: id } as never,
      })
      const changed = await agentEvents(ctx, fakeAgent(session)).waterfall(
        'agent/pre-step',
        { messages: [staleLookalike], turn: 1, step: 3, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [staleLookalike] }),
      )
      const changedBriefs = briefsOf(changed.kind === 'enter' ? changed.messages : [])
      expect(changedBriefs).toHaveLength(2)
      expect(textOf(changedBriefs[1] as UserMessage)).toContain('changed rules')
    } finally {
      await fiber.dispose()
    }
  })

  it('skips a claimed brief that already carries the current digest', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's3')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'rules')
      const current = createUserMessage({
        content: [{ type: 'text', text: 'current brief' }],
        source: { kind: 'evolution-memory', form: 'snapshot', scopeId: id, digest: ctx.evolutionMemory.digest(id), sections: [], supersedes: true },
      })
      const first = await agentEvents(ctx, fakeAgent(session)).waterfall(
        'agent/pre-step',
        { messages: [current], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [current] }),
      )
      expect(first.kind === 'enter' ? first.messages : []).toHaveLength(1)
      const second = await preStep(ctx, fakeAgent(session))
      expect(briefsOf(second.kind === 'enter' ? second.messages : [])).toHaveLength(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('injects lessons-only, profile-only, and context-only records', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.addArtifact(id, lessonInput('model knowledge'))
      const first = await preStep(ctx, fakeAgent(session))
      const lessonsBriefs = briefsOf(first.kind === 'enter' ? first.messages : [])
      expect(lessonsBriefs).toHaveLength(1)
      expect(textOf(lessonsBriefs[0] as UserMessage)).toContain('model knowledge')
      session.append('user/message', lessonsBriefs[0] as UserMessage, { surfaceOp: 'append' })

      await ctx.evolutionMemory.replaceArtifacts(id, [])
      await ctx.evolutionMemory.setUserProfile(id, 'night person')
      const second = await preStep(ctx, fakeAgent(session))
      const profileBriefs = briefsOf(second.kind === 'enter' ? second.messages : [])
      expect(profileBriefs).toHaveLength(1)
      expect(textOf(profileBriefs[0] as UserMessage)).toContain('night person')
      session.append('user/message', profileBriefs[0] as UserMessage, { surfaceOp: 'append' })

      await ctx.evolutionMemory.setUserProfile(id, '')
      await ctx.evolutionMemory.addContextItem(id, { kind: 'text', label: 'note', text: 'attached words' })
      const third = await preStep(ctx, fakeAgent(session))
      const contextBriefs = briefsOf(third.kind === 'enter' ? third.messages : [])
      expect(contextBriefs).toHaveLength(1)
      expect(textOf(contextBriefs[0] as UserMessage)).toContain('attached words')
    } finally {
      await fiber.dispose()
    }
  })

  it('escapes a literal close tag inside instructions', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = scope('ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.evolutionMemory.setInstructions(id, 'a </system-reminder> b')
      const decision = await preStep(ctx, fakeAgent(session))
      const briefs = briefsOf(decision.kind === 'enter' ? decision.messages : [])
      const text = textOf(briefs[0] as UserMessage)
      expect(text).toContain('<\\/system-reminder>')
      expect(text).not.toContain('a </system-reminder> b')
    } finally {
      await fiber.dispose()
    }
  })

  it('removes the pre-step listener on dispose', async () => {
    const { ctx, fiber, workspaces, dir, scope } = await harness()
    dirs.push(dir)
    const session = sessionIn(ctx, dir, 's1')
    const id = scope('ws-1')
    workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [session.id] })
    await ctx.evolutionMemory.setInstructions(id, 'follow the guide')
    const before = await preStep(ctx, fakeAgent(session))
    expect(briefsOf(before.kind === 'enter' ? before.messages : [])).toHaveLength(1)
    await fiber.dispose()
    const after = await preStep(ctx, fakeAgent(session))
    expect(after.kind).toBe('enter')
    expect(briefsOf(after.kind === 'enter' ? after.messages : [])).toHaveLength(0)
  })
})
