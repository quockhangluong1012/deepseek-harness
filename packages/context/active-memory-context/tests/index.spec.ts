import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSearchTurn, resolveConfig } from '../src/index.ts'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SessionQueryEngine, {
  type SemanticSessionSearchHit,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import * as activeMemoryContext from '../src/index.ts'

const SIGNAL = new AbortController().signal

const directories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  // The engine holds its database open until its fiber disposes; on Windows
  // removing the directory first fails with EBUSY.
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-active-memory-'))
  directories.push(directory)
  return join(directory, name)
}

function header(id: string, createdAt = 1, cwd?: string): SessionHeader {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt,
    isSeeded: false,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

function messageEvents(text: string, time = 1): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: SessionSeq(0),
    time,
    data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
    surfaceOp: 'append',
  }]
}

const VOCABULARY = ['needle', 'hay', 'straw']

/** Bag-of-words "embedding" over a three-word vocabulary, so ranking is checkable by hand. */
function bagOfWords(text: string): number[] {
  const words = text.toLowerCase().split(/\s+/)
  return VOCABULARY.map(term => words.filter(word => word === term).length)
}

/** Minimal embeddings-service double shape `dsh-session-query-sqlite`'s vector channel calls. */
interface FakeEmbeddingsService {
  resolve: () => { provider: string; model: string }
  embed: (args: { texts: readonly string[] }) => Promise<{
    spec: { provider: string; model: string }
    vectors: number[][]
    cached: number
    embedded: number
  }>
}

/** One embeddings-service double plus every batch of texts it was asked to embed. */
interface FakeEmbeddings {
  batches: string[][]
  service: FakeEmbeddingsService
}

/** Embedding service double: cosine similarity of orthogonal bag-of-words vectors is exactly 0. */
function fakeEmbeddings(): FakeEmbeddings {
  const batches: string[][] = []
  return {
    batches,
    service: {
      resolve: () => ({ provider: 'fake', model: 'fake-embed' }),
      embed: ({ texts }: { texts: readonly string[] }) => Promise.resolve({
        spec: { provider: 'fake', model: 'fake-embed' },
        vectors: (batches.push([...texts]), texts.map(bagOfWords)),
        cached: 0,
        embedded: texts.length,
      }),
    },
  }
}

interface Workspace { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }

async function harness(
  config: activeMemoryContext.Config = { maxBytes: 4096 },
  embeddings?: FakeEmbeddingsService,
): Promise<{ ctx: Context; workspaces: Map<string, Workspace> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: await temporaryPath('sessions'), compression: 'none' })
  if (embeddings !== undefined) ctx.provide('embeddings', embeddings as never)
  await ctx.plugin(SqliteSessionQueryEngine, { path: await temporaryPath('derived.db') })
  const workspaces = new Map<string, Workspace>()
  ctx.provide('workspaceRegistry', {
    list: () => [...workspaces.values()],
    get: (id: WorkspaceId) => workspaces.get(String(id)),
  } as never)
  await ctx.plugin(activeMemoryContext, config)
  contexts.push(ctx)
  return { ctx, workspaces }
}

/** Persist one session whose single event carries `text`, indexed as a search candidate. */
async function persist(ctx: Context, id: string, text: string, createdAt = 10): Promise<SessionHeader> {
  const meta = header(id, createdAt)
  const writer = await ctx.sessionPersistence.create(meta)
  await writer.append(messageEvents(text))
  await writer.close()
  return meta
}

function fakeAgent(session: Session): Agent {
  return { id: session.id, session } as Agent
}

function textMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function briefsOf(messages: readonly UserMessage[]): UserMessage[] {
  return messages.filter(message => (message.source as { kind?: string }).kind === 'active-memory')
}

async function preStep(
  ctx: Context,
  agent: Agent,
  messages: UserMessage[] = [],
  options: { turn?: number; signal?: AbortSignal } = {},
) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages, turn: options.turn ?? 1, step: 1, signal: options.signal ?? SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [...messages] }),
  )
}

describe('active-memory-context injector', () => {
  it('injects the relevant sibling session, filtered below threshold by an unrelated one', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    await persist(ctx, 'sibling-hay', 'hay in the barn')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle'), SessionId('sibling-hay')],
    })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    const briefs = briefsOf(decision.kind === 'enter' ? decision.messages : [])
    expect(briefs).toHaveLength(1)
    const text = briefs[0]?.content.find(block => block.type === 'text')
    expect(text && 'text' in text ? text.text : '').toContain('sibling-needle')
    expect(text && 'text' in text ? text.text : '').not.toContain('sibling-hay')
  })

  it('excludes the current session from its own search results', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'needle needle needle' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: '/unused', sessionIds: [session.id] })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
  })

  it('skips when the session has no resolvable workspace membership', async () => {
    const fake = fakeEmbeddings()
    const { ctx } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('outsider'), { meta: header('outsider') })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
  })

  it('resolves membership by canonical cwd when the session id is not yet listed', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const dir = await realpath(await temporaryPath('.'))
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current', 1, dir) })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: dir,
      sessionIds: [SessionId('sibling-needle')],
    })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(1)
  })

  it('skips when the proposed messages carry no text', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: '/unused', sessionIds: [session.id] })

    const decision = await preStep(ctx, fakeAgent(session), [])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
  })

  it('does not repeat the search on a retried step for the same observed turn', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })

    const first = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    expect(briefsOf(first.kind === 'enter' ? first.messages : [])).toHaveLength(1)
    const batchesAfterFirst = fake.batches.length

    const second = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    expect(briefsOf(second.kind === 'enter' ? second.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(batchesAfterFirst)
  })

  it('gates the search by the configured turn interval', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096, turnInterval: 2 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
  })

  it('degrades to no injection when the vector channel is unavailable', async () => {
    const { ctx, workspaces } = await harness({ maxBytes: 4096 })
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
  })

  it('propagates a failure that is not a SessionQueryError', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    class ThrowingSessionQuery extends SessionQueryEngine {
      override searchSessions(
        _request: SessionSearchRequest,
        _exec?: SessionSearchExecContext,
      ): Promise<SessionSearchPage<SessionSearchHit>> {
        return Promise.reject(new Error('not used by this test'))
      }

      override searchSessionsSemantic(
        _request: SessionSearchRequest,
        _exec?: SessionSearchExecContext,
      ): Promise<SessionSearchPage<SemanticSessionSearchHit>> {
        return Promise.reject(new Error('boom'))
      }

      override searchEvents(): Promise<never> {
        return Promise.reject(new Error('not used by this test'))
      }
    }
    new ThrowingSessionQuery(ctx)
    const sessionIds: SessionId[] = []
    ctx.provide('workspaceRegistry', {
      list: () => [{ id: WorkspaceId('ws-1'), title: 'Project', path: '/unused', sessionIds }],
      get: () => undefined,
    } as never)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await ctx.plugin(activeMemoryContext, { maxBytes: 4096 })
    contexts.push(ctx)
    sessionIds.push(session.id, SessionId('sibling'))

    await expect(preStep(ctx, fakeAgent(session), [textMessage('needle')])).rejects.toThrow('boom')
  })

  it('skips when no hit clears the relevance threshold', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096, relevanceThreshold: 0.5 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'hay in the barn')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
  })

  it('skips when the relevant brief does not fit the configured byte budget', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 16 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
  })

  it('passes through a rejected decision without searching', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })

    const decision = await agentEvents(ctx, fakeAgent(session)).waterfall(
      'agent/pre-step',
      { messages: [textMessage('needle')], turn: 1, step: 1, signal: SIGNAL },
      () => Promise.resolve({ kind: 'reject' as const }),
    )

    expect(decision).toEqual({ kind: 'reject' })
    expect(fake.batches).toHaveLength(0)
  })

  it('skips an already-aborted step without searching', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })
    const controller = new AbortController()
    controller.abort()

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')], { signal: controller.signal })

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
  })

  it('reuses cached workspace membership on a later observed turn', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    workspaces.set('ws-1', {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })

    const first = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    expect(briefsOf(first.kind === 'enter' ? first.messages : [])).toHaveLength(1)
    session.append('turn/start', { turn: 1 })
    const second = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    expect(briefsOf(second.kind === 'enter' ? second.messages : [])).toHaveLength(1)
  })

  it('re-scans membership when a cached workspace id no longer resolves', async () => {
    const fake = fakeEmbeddings()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: await temporaryPath('sessions'), compression: 'none' })
    ctx.provide('embeddings', fake.service as never)
    await ctx.plugin(SqliteSessionQueryEngine, { path: await temporaryPath('derived.db') })
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    let deleted = false
    const workspace = {
      id: WorkspaceId('ws-1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    }
    ctx.provide('workspaceRegistry', {
      list: () => [workspace],
      get: (id: WorkspaceId) => (deleted ? undefined : (String(id) === String(workspace.id) ? workspace : undefined)),
    } as never)
    await ctx.plugin(activeMemoryContext, { maxBytes: 4096 })
    contexts.push(ctx)

    const first = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    expect(briefsOf(first.kind === 'enter' ? first.messages : [])).toHaveLength(1)
    deleted = true
    session.append('turn/start', { turn: 1 })
    const second = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    expect(briefsOf(second.kind === 'enter' ? second.messages : [])).toHaveLength(1)
  })

  it('treats an unresolvable cwd as no membership', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(
      SessionId('current'),
      { meta: header('current', 1, join(tmpdir(), 'dsh-active-memory-missing-dir')) },
    )
    workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: '/unused', sessionIds: [] })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
  })

  it('treats a resolvable cwd matching no workspace as no membership', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const dir = await realpath(await temporaryPath('.'))
    const elsewhere = await realpath(await temporaryPath('.'))
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current', 1, dir) })
    workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: elsewhere, sessionIds: [] })

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
  })

  it('keeps treating a session as unscoped once a prior search found no membership', async () => {
    const fake = fakeEmbeddings()
    const { ctx } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('outsider'), { meta: header('outsider') })

    const first = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    expect(briefsOf(first.kind === 'enter' ? first.messages : [])).toHaveLength(0)
    session.append('turn/start', { turn: 1 })
    const second = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    expect(briefsOf(second.kind === 'enter' ? second.messages : [])).toHaveLength(0)
    expect(fake.batches).toHaveLength(0)
  })
})

describe('resolveConfig', () => {
  it('fills every optional field with its default when omitted', () => {
    expect(resolveConfig({ maxBytes: 1024 })).toEqual({
      maxBytes: 1024,
      topK: 5,
      relevanceThreshold: 0.7,
      turnInterval: 1,
    })
  })

  it('keeps every explicitly configured value as given', () => {
    expect(resolveConfig({ maxBytes: 2048, topK: 3, relevanceThreshold: 0.42, turnInterval: 4 })).toEqual({
      maxBytes: 2048,
      topK: 3,
      relevanceThreshold: 0.42,
      turnInterval: 4,
    })
  })
})

describe('isSearchTurn', () => {
  it('treats an unobserved turn as the first turn', () => {
    expect(isSearchTurn(0, 1)).toBe(true)
    expect(isSearchTurn(0, 2)).toBe(false)
  })

  it('is due exactly on interval multiples', () => {
    expect(isSearchTurn(2, 2)).toBe(true)
    expect(isSearchTurn(3, 2)).toBe(false)
  })
})
