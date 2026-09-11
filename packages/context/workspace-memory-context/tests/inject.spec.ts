import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import WorkspaceMemoryStore from '@deepseek-ai/dsh-workspace-memory'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as workspaceMemoryContext from '../src/index.ts'

const SIGNAL = new AbortController().signal

interface Harness {
  ctx: Context
  fiber: { dispose(): Promise<void> }
  workspaces: Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>
  dir: string
}

async function harness(): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wmc-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(WorkspaceMemoryStore, { capacityBytes: 65536 })
  await ctx.plugin(SessionStore)
  const workspaces = new Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>()
  ctx.provide('workspaceRegistry', {
    list: () => [...workspaces.values()],
    get: (id: WorkspaceId) => workspaces.get(String(id)),
  } as never)
  const fiber = await ctx.plugin(workspaceMemoryContext, { maxBytes: 8192 })
  return { ctx, fiber, workspaces, dir }
}

function sessionIn(ctx: Context, dir: string, name: string): Session {
  return ctx.sessions.create(SessionId(name), { meta: { cwd: dir } })
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as Agent
}

function briefsOf(messages: readonly UserMessage[]): UserMessage[] {
  return messages.filter(message => (message.source as { kind?: string }).kind === 'workspace-memory')
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

describe('workspace-memory-context injector', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('injects one brief, skips the unchanged turn, and replaces on change', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.workspaceMemory.setInstructions(id, 'follow the guide')
      await ctx.workspaceMemory.setMemory(id, 'the project is green')

      const first = await preStep(ctx, fakeAgent(session))
      expect(first.kind).toBe('enter')
      const briefs = briefsOf(first.kind === 'enter' ? first.messages : [])
      expect(briefs).toHaveLength(1)
      const digest = (briefs[0]?.source as { digest: string }).digest
      expect(textOf(briefs[0] as UserMessage)).toContain('follow the guide')
      expect(textOf(briefs[0] as UserMessage)).toContain('the project is green')
      expect(ctx.workspaceMemory.digest(id)).toBe(digest)
      session.append('user/message', briefs[0] as UserMessage, { surfaceOp: 'append' })

      const second = await preStep(ctx, fakeAgent(session))
      expect(second.kind).toBe('enter')
      expect(briefsOf(second.kind === 'enter' ? second.messages : [])).toHaveLength(0)

      await ctx.workspaceMemory.setInstructions(id, 'follow the new guide')
      const third = await preStep(ctx, fakeAgent(session))
      const replaced = briefsOf(third.kind === 'enter' ? third.messages : [])
      expect(replaced).toHaveLength(1)
      expect(textOf(replaced[0] as UserMessage)).toContain('follow the new guide')
      expect((replaced[0]?.source as { digest: string }).digest).not.toBe(digest)
    } finally {
      await fiber.dispose()
    }
  })

  it('ignores claimed messages that are not the brief', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.workspaceMemory.setInstructions(id, 'rules')
      const plain = createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      })
      const decision = await preStep(ctx, fakeAgent(session), [plain])
      expect(decision.kind).toBe('enter')
      const messages = decision.kind === 'enter' ? decision.messages : []
      expect(briefsOf(messages)).toHaveLength(1)
      expect(messages[0]).toBe(plain)
    } finally {
      await fiber.dispose()
    }
  })

  it('spreads the downstream decision, including startsRequestSeries', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.workspaceMemory.setInstructions(id, 'rules')
      const agent = fakeAgent(session)
      const decision = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [], startsRequestSeries: true as const }),
      )
      expect(decision).toMatchObject({ kind: 'enter', startsRequestSeries: true })
      expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('leaves rejections, aborted signals, empty records, and outside sessions alone', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      const agent = fakeAgent(session)

      const rejected = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: SIGNAL },
        () => Promise.resolve({ kind: 'reject' as const }),
      )
      expect(rejected).toEqual({ kind: 'reject' })

      const aborted = await agentEvents(ctx, agent).waterfall(
        'agent/pre-step',
        { messages: [], turn: 1, step: 1, signal: AbortSignal.abort() },
        () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
      )
      expect(briefsOf(aborted.kind === 'enter' ? aborted.messages : [])).toHaveLength(0)

      // Present-but-empty and absent records cost zero tokens.
      const empty = await preStep(ctx, agent)
      expect(briefsOf(empty.kind === 'enter' ? empty.messages : [])).toHaveLength(0)
      await ctx.workspaceMemory.setDescription(id, 'just a blurb')
      const blurbOnly = await preStep(ctx, agent)
      expect(briefsOf(blurbOnly.kind === 'enter' ? blurbOnly.messages : [])).toHaveLength(0)

      // A session outside any workspace gets nothing, twice (cached miss).
      const lone = sessionIn(ctx, dir, 'lone')
      workspaces.clear()
      const agentLone = fakeAgent(lone)
      for (let round = 0; round < 2; round += 1) {
        const decision = await preStep(ctx, agentLone)
        expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
      }
      ctx.emit('session/disposed', lone)
    } finally {
      await fiber.dispose()
    }
  })

  it('falls back to a canonical-path match and forgets removed workspaces', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      // No sessionIds account: membership resolves through the session cwd.
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [] })
      await ctx.workspaceMemory.setInstructions(id, 'rules')
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
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [] })
      const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'wmc-else-')))
      dirs.push(elsewhere)
      const outsider = sessionIn(ctx, elsewhere, 'outsider')
      const fourth = await preStep(ctx, fakeAgent(outsider))
      expect(briefsOf(fourth.kind === 'enter' ? fourth.messages : [])).toHaveLength(0)
      const homeless = ctx.sessions.create(SessionId('homeless'))
      const fifth = await preStep(ctx, fakeAgent(homeless))
      expect(briefsOf(fifth.kind === 'enter' ? fifth.messages : [])).toHaveLength(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('materializes text and file context and degrades missing files', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      const filePath = join(dir, 'notes.md')
      await writeFile(filePath, '# notes\nremember this')
      const size = (await stat(filePath)).size
      await ctx.workspaceMemory.setInstructions(id, 'rules')
      await ctx.workspaceMemory.addContextItem(id, { kind: 'text', label: 'pasted', text: 'pasted words' })
      await ctx.workspaceMemory.addContextItem(id, { kind: 'file', label: 'notes', path: filePath, sizeBytes: size })
      await ctx.workspaceMemory.addContextItem(id, { kind: 'file', label: 'gone', path: join(dir, 'gone.md'), sizeBytes: 4 })
      const decision = await preStep(ctx, fakeAgent(session))
      const briefs = briefsOf(decision.kind === 'enter' ? decision.messages : [])
      expect(briefs).toHaveLength(1)
      const text = textOf(briefs[0] as UserMessage)
      expect(text).toContain('pasted words')
      expect(text).toContain('remember this')
      expect(text).toContain('Context "gone" is unavailable')
    } finally {
      await fiber.dispose()
    }
  })

  it('reads file context through the fs provider when mounted', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      ctx.provide('fs', {
        resolve: async (path: string) => ({ path }),
        readText: async () => 'provider words',
      } as never)
      await ctx.workspaceMemory.setInstructions(id, 'rules')
      await ctx.workspaceMemory.addContextItem(id, { kind: 'file', label: 'doc', path: join(dir, 'doc.md'), sizeBytes: 3 })
      const decision = await preStep(ctx, fakeAgent(session))
      const briefs = briefsOf(decision.kind === 'enter' ? decision.messages : [])
      expect(textOf(briefs[0] as UserMessage)).toContain('provider words')
    } finally {
      await fiber.dispose()
    }
  })

  it('treats an already-claimed brief as visible and skips sourceless lookalikes', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.workspaceMemory.setInstructions(id, 'rules')
      const first = await preStep(ctx, fakeAgent(session))
      const brief = briefsOf(first.kind === 'enter' ? first.messages : [])[0] as UserMessage
      session.append('user/message', brief, { surfaceOp: 'append' })

      // The brief is already in the claimed batch: nothing is added, even
      // beside an ordinary prompt and a digest-less lookalike.
      const prompt = createUserMessage({
        content: [{ type: 'text', text: 'ordinary prompt' }],
        source: { kind: 'user' },
      })
      const claimedLookalike = createUserMessage({
        content: [{ type: 'text', text: 'claimed lookalike' }],
        source: { kind: 'workspace-memory', form: 'instructions', workspaceId: id } as never,
      })
      const claimed = await agentEvents(ctx, fakeAgent(session)).waterfall(
        'agent/pre-step',
        { messages: [prompt, brief, claimedLookalike], turn: 1, step: 2, signal: SIGNAL },
        () => Promise.resolve({ kind: 'enter' as const, messages: [prompt, brief, claimedLookalike] }),
      )
      expect(claimed.kind === 'enter' ? claimed.messages : []).toHaveLength(3)

      // Sourceless lookalikes and other surface kinds never shadow the digest.
      session.append(
        'user/message',
        createUserMessage({
          content: [{ type: 'text', text: 'lookalike' }],
          source: { kind: 'workspace-memory', form: 'instructions', workspaceId: id } as never,
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
      await ctx.workspaceMemory.setInstructions(id, 'changed rules')
      const changed = await preStep(ctx, fakeAgent(session))
      expect(briefsOf(changed.kind === 'enter' ? changed.messages : [])).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('injects memory-only and context-only records', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.workspaceMemory.setMemory(id, 'model knowledge')
      const first = await preStep(ctx, fakeAgent(session))
      const memoryBriefs = briefsOf(first.kind === 'enter' ? first.messages : [])
      expect(memoryBriefs).toHaveLength(1)
      expect(textOf(memoryBriefs[0] as UserMessage)).toContain('model knowledge')
      session.append('user/message', memoryBriefs[0] as UserMessage, { surfaceOp: 'append' })

      await ctx.workspaceMemory.setMemory(id, '')
      await ctx.workspaceMemory.addContextItem(id, { kind: 'text', label: 'note', text: 'attached words' })
      const second = await preStep(ctx, fakeAgent(session))
      const contextBriefs = briefsOf(second.kind === 'enter' ? second.messages : [])
      expect(contextBriefs).toHaveLength(1)
      expect(textOf(contextBriefs[0] as UserMessage)).toContain('attached words')
    } finally {
      await fiber.dispose()
    }
  })

  it('escapes a literal close tag inside instructions', async () => {
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    try {
      const session = sessionIn(ctx, dir, 's1')
      const id = WorkspaceId('ws-1')
      workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
      await ctx.workspaceMemory.setInstructions(id, 'a </system-reminder> b')
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
    const { ctx, fiber, workspaces, dir } = await harness()
    dirs.push(dir)
    const session = sessionIn(ctx, dir, 's1')
    const id = WorkspaceId('ws-1')
    workspaces.set(id, { id, title: 'Project', path: dir, sessionIds: [session.id] })
    await ctx.workspaceMemory.setInstructions(id, 'follow the guide')
    const before = await preStep(ctx, fakeAgent(session))
    expect(briefsOf(before.kind === 'enter' ? before.messages : [])).toHaveLength(1)
    await fiber.dispose()
    const after = await preStep(ctx, fakeAgent(session))
    expect(after.kind).toBe('enter')
    expect(briefsOf(after.kind === 'enter' ? after.messages : [])).toHaveLength(0)
  })
})
