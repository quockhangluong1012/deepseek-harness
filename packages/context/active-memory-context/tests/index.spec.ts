import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isSearchTurn, resolveConfig } from '../src/index.ts'
import AgentContext from '@deepseek-ai/dsh-agent-context'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SessionQueryEngine, {
  SessionQueryError,
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

/** Knowledge-graph double plus every read it received. */
interface FakeGraph {
  calls: {
    find: Array<{ scope: string; query: string; limit: number }>
    expand: Array<{ scope: string; subject: string; depth: number; limit: number }>
  }
  service: {
    find: (scope: string, query: string, limit: number) => unknown[]
    expand: (scope: string, subject: string, depth: number, limit: number) => unknown[]
  }
}

/**
 * Knowledge-graph double over a fixed entity set. `find` matches a label that
 * *contains* the query, exactly like `EvolutionGraph.find`, so a whole-turn
 * lookup answers nothing and only a token lookup can seed. `expand` returns the
 * configured neighbors. Both record their arguments; `fail` makes one read
 * throw, the way a mounted but broken engine would.
 * @param options - the scope's entity labels, its neighbors, and which read to fail.
 * @returns the double and its recorded calls.
 */
function fakeGraph(options: {
  labels?: readonly string[]
  neighbors?: readonly string[]
  fail?: 'find' | 'expand'
} = {}): FakeGraph {
  const calls: FakeGraph['calls'] = { find: [], expand: [] }
  const nodes = (labels: readonly string[]) => labels.map(label => ({
    id: label.toLowerCase(),
    label,
    kind: null,
  }))
  return {
    calls,
    service: {
      find: (scope, query, limit) => {
        calls.find.push({ scope, query, limit })
        if (options.fail === 'find') throw new Error('graph read failed')
        const needle = query.trim().toLowerCase()
        return nodes((options.labels ?? []).filter(label => label.toLowerCase().includes(needle))).slice(0, limit)
      },
      expand: (scope, subject, depth, limit) => {
        calls.expand.push({ scope, subject, depth, limit })
        if (options.fail === 'expand') throw new Error('graph read failed')
        return nodes(options.neighbors ?? []).map((node, index) => ({
          node,
          path: ['relates_to'],
          depth: index + 1,
        }))
      },
    },
  }
}

/** The brief's rendered text, or an empty string when the step injected none. */
function briefText(message: UserMessage | undefined): string {
  const block = message?.content.find(part => part.type === 'text')
  return block?.type === 'text' ? block.text : ''
}

/** One §39 configuration, starting from the injected brief's own shipped choice. */
function recommendedConfiguration(
  overrides: Partial<activeMemoryContext.RecommendedRetrievalConfiguration> = {},
): activeMemoryContext.RecommendedRetrievalConfiguration {
  return {
    source: 'hybrid',
    queryExpansion: 'graph-entities',
    weights: { vector: 1, graph: 1 },
    reranker: 'none',
    mmr: { enabled: false, lambda: 1 },
    memoryScope: 'workspace',
    graphDepth: 1,
    threshold: 0.7,
    ...overrides,
  }
}

/**
 * Retrieval store double: the attribution sink and a recommendation per task
 * class, so a test names the class it wants a recommendation for and any other
 * class answers the way a store below its evidence gate does.
 * @param recommendations - each class's configuration and rank score.
 * @returns the double plus every attribution it recorded.
 */
function fakeRetrievalStore(
  recommendations: Record<string, { configuration: activeMemoryContext.RecommendedRetrievalConfiguration; score: number }> = {},
): {
  recorded: { configuration: unknown; sessionId: string }[]
  service: {
    record: (input: { configuration: unknown; sessionId: string }) => Promise<unknown>
    recommend: (taskClass: string) => unknown
  }
} {
  const recorded: { configuration: unknown; sessionId: string }[] = []
  return {
    recorded,
    service: {
      record: (input) => {
        recorded.push(input)
        return Promise.resolve(input)
      },
      recommend: (taskClass) => {
        const entry = recommendations[taskClass]
        return entry === undefined ? undefined : { configKey: `key-${taskClass}`, ...entry }
      },
    },
  }
}

/** Skill-telemetry double: each skill's recorded session ids. */
function fakeSkillTelemetry(skills: Record<string, readonly string[]>): { entries: () => unknown[] } {
  return {
    entries: () => Object.entries(skills).map(([name, sessionIds]) => ({
      name,
      usage: { sessionIds: [...sessionIds] },
    })),
  }
}

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

/**
 * Build the scope a graph-leg test searches in: the live `current` session plus
 * the named siblings, all registered as one workspace.
 * @param ctx - harness context.
 * @param workspaces - the registry the harness answers `list`/`get` from.
 * @param siblings - sibling id and persisted text pairs.
 * @returns the live session the pre-step runs for.
 */
async function scopeWith(
  ctx: Context,
  workspaces: Map<string, Workspace>,
  siblings: readonly { id: string; text: string }[],
): Promise<Session> {
  const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
  for (const sibling of siblings) await persist(ctx, sibling.id, sibling.text)
  workspaces.set('ws-1', {
    id: WorkspaceId('ws-1'),
    title: 'Project',
    path: '/unused',
    sessionIds: [session.id, ...siblings.map(sibling => SessionId(sibling.id))],
  })
  return session
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

  it('registers its logged recall as an untrusted delta memory source', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    await ctx.plugin(AgentContext, {})
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])
    const agent = fakeAgent(session)
    const decision = await preStep(ctx, agent, [textMessage('needle')])
    const brief = briefsOf(decision.kind === 'enter' ? decision.messages : [])[0]
    if (brief === undefined) throw new Error('active memory did not emit a brief')
    const text = briefText(brief)
    session.append('user/message', brief, { surfaceOp: 'append' })

    const compiled = await ctx.agentContext.compile(agent, { sections: [], contexts: [], tools: [], variables: {} })
    const source = compiled.included.find(entry => entry.source.id === `active-memory:${String(brief.id)}`)

    expect(source?.source.content).toBe(text)
    expect(source?.source.kind).toBe('memory')
    expect(source?.source.trust).toBe('untrusted')
    expect(source?.source.retention).toBe('compressible')
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

  it('merges the sessions the graph reaches into the brief', async () => {
    const { ctx, workspaces } = await harness({ maxBytes: 4096 })
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-atlas', text: 'atlas launch slipped a week' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    const graph = fakeGraph({ labels: ['Atlas'], neighbors: ['Ava'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('atlas')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-atlas')
    expect(text).toContain('sibling-ava')
    expect(text).toContain('via graph connections')
    expect(graph.calls.find).toEqual([{ scope: 'default:ws-1', query: 'atlas', limit: 1 }])
    expect(graph.calls.expand).toEqual([{ scope: 'default:ws-1', subject: 'Atlas', depth: 1, limit: 5 }])
  })

  it('seeds a multi-word turn from the word that names an entity', async () => {
    const { ctx, workspaces } = await harness({ maxBytes: 4096 })
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-atlas', text: 'atlas launch slipped a week' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    const graph = fakeGraph({ labels: ['Atlas'], neighbors: ['Ava'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('what about the ATLAS launch?')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(graph.calls.find.map(call => call.query)).toEqual(['what', 'about', 'the', 'atlas'])
    expect(graph.calls.expand).toEqual([{ scope: 'default:ws-1', subject: 'Atlas', depth: 1, limit: 5 }])
    expect(text).toContain('sibling-atlas')
    expect(text).toContain('sibling-ava')
  })

  it('spends at most graphLimit label lookups on a turn that names no entity', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096, graphLimit: 3 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])
    const graph = fakeGraph({ labels: ['Atlas'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle alpha beta gamma delta')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(graph.calls.find.map(call => call.query)).toEqual(['needle', 'alpha', 'beta'])
    expect(graph.calls.expand).toEqual([])
    expect(text).toContain('sibling-needle')
    expect(text).not.toContain('via graph connections')
  })

  it('counts a session once when more than one label matches it', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [
      { id: 'mmm-both', text: 'needle atlas' },
      { id: 'zzz-multi', text: 'atlas ava bora' },
    ])
    const graph = fakeGraph({ labels: ['Atlas'], neighbors: ['Ava', 'Bora'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle atlas')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    // Three labels match `zzz-multi`, which is why the leg keeps one hit per
    // session: counted once per match it would carry three reciprocal-rank
    // contributions and outrank `mmm-both`, the session both legs found.
    expect([...text.matchAll(/\[session ([^ ]+)/g)].map(match => match[1]))
      .toEqual(['mmm-both', 'zzz-multi'])
  })

  it('does not seed the graph from a word too short to name an entity', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-needle', text: 'needle in the stack' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    // `find` matches any label containing the token, so the turn's own "a"
    // would otherwise seed Atlas and spend the label budget on an entity the
    // turn never named.
    const graph = fakeGraph({ labels: ['Atlas'], neighbors: ['Ava'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle a')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(graph.calls.find.map(call => call.query)).toEqual(['needle'])
    expect(graph.calls.expand).toEqual([])
    expect(text).toContain('sibling-needle')
    expect(text).not.toContain('via graph connections')
    expect(text).not.toContain('sibling-ava')
  })

  it('leaves the brief byte-identical to the vector-only result when the turn names no entity', async () => {
    const withGraph = fakeEmbeddings()
    const mounted = await harness({ maxBytes: 4096 }, withGraph.service)
    const mountedSession = await scopeWith(mounted.ctx, mounted.workspaces, [
      { id: 'sibling-needle', text: 'needle in the stack' },
    ])
    mounted.ctx.provide('evolutionGraph', fakeGraph({ labels: ['Atlas'] }).service as never)
    const mountedDecision = await preStep(mounted.ctx, fakeAgent(mountedSession), [textMessage('needle please')])

    const withoutGraph = fakeEmbeddings()
    const alone = await harness({ maxBytes: 4096 }, withoutGraph.service)
    const aloneSession = await scopeWith(alone.ctx, alone.workspaces, [
      { id: 'sibling-needle', text: 'needle in the stack' },
    ])
    const aloneDecision = await preStep(alone.ctx, fakeAgent(aloneSession), [textMessage('needle please')])

    const briefs = (decision: typeof mountedDecision) => briefsOf(decision.kind === 'enter' ? decision.messages : [])
    expect(briefs(mountedDecision)).toHaveLength(1)
    expect(briefText(briefs(mountedDecision)[0])).toBe(briefText(briefs(aloneDecision)[0]))
  })

  it('behaves exactly as before when no graph is mounted', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-needle')
    expect(text).toContain('similarity 1.00')
    expect(text).not.toContain('via graph connections')
  })

  it('keeps the vector-only brief when the graph matches no entity', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])
    const graph = fakeGraph()
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-needle')
    expect(text).not.toContain('via graph connections')
    expect(graph.calls.expand).toEqual([])
  })

  it('ignores a mounted service that offers no graph reads', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])
    ctx.provide('evolutionGraph', { find: () => [] } as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-needle')
  })

  it('keeps the vector-only brief when the graph lookup throws', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-needle', text: 'needle in the stack' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    ctx.provide('evolutionGraph', fakeGraph({ labels: ['Atlas'], fail: 'find' }).service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-needle')
    expect(text).not.toContain('sibling-ava')
  })

  it('keeps the vector-only brief when the graph expansion throws', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-needle', text: 'needle in the stack' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    // The seed label must match a token of the turn so the leg actually reaches
    // `expand`, which is the read under test here.
    const graph = fakeGraph({ labels: ['Needle'], neighbors: ['Ava'], fail: 'expand' })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-needle')
    expect(text).not.toContain('sibling-ava')
  })

  it('degrades to the vector leg when the scope key is not a valid scope', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = ctx.sessions.create(SessionId('current'), { meta: header('current') })
    await persist(ctx, 'sibling-needle', 'needle in the stack')
    // A registry workspace id is unvalidated, and `EvolutionScopeId` refuses
    // one holding ':': the turn must still resolve without the graph leg.
    workspaces.set('ws:1', {
      id: WorkspaceId('ws:1'),
      title: 'Project',
      path: '/unused',
      sessionIds: [session.id, SessionId('sibling-needle')],
    })
    const graph = fakeGraph({ labels: ['Needle'], neighbors: ['Ava'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-needle')
    expect(text).not.toContain('via graph connections')
    expect(graph.calls.find).toEqual([])
  })

  it('refuses a profile that can never name a scope', async () => {
    for (const profile of ['', 'team:eu']) {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(JsonlSessionPersistence, { root: await temporaryPath('sessions'), compression: 'none' })
      await ctx.plugin(SqliteSessionQueryEngine, { path: await temporaryPath('derived.db') })
      ctx.provide('workspaceRegistry', { list: () => [], get: () => undefined } as never)
      contexts.push(ctx)

      // `EvolutionScopeId` builds `<profile>:<workspace>`, so accepting this
      // profile would empty the graph leg on every turn instead of failing.
      await expect(ctx.plugin(activeMemoryContext, { maxBytes: 4096, profile })).rejects.toThrow(/profile/)
    }
  })

  it('degrades to the vector leg when the graph expansion returns a non-array', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])
    ctx.provide('evolutionGraph', {
      find: () => [{ id: 'needle', label: 'Needle', kind: null }],
      expand: () => 'not an array',
    } as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-needle')
    expect(text).not.toContain('via graph connections')
  })

  it('skips the graph leg when the session has no resolvable workspace membership', async () => {
    const { ctx } = await harness({ maxBytes: 4096 })
    const session = ctx.sessions.create(SessionId('outsider'), { meta: header('outsider') })
    const graph = fakeGraph({ labels: ['Atlas'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('atlas')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(graph.calls.find).toEqual([])
  })

  it('reads the graph under the configured profile, depth, and label cap', async () => {
    const { ctx, workspaces } = await harness({ maxBytes: 4096, profile: 'team', graphDepth: 2, graphLimit: 1 })
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-atlas', text: 'atlas launch slipped a week' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    const graph = fakeGraph({ labels: ['Atlas'], neighbors: ['Ava'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('atlas')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(graph.calls.find).toEqual([{ scope: 'team:ws-1', query: 'atlas', limit: 1 }])
    expect(graph.calls.expand).toEqual([{ scope: 'team:ws-1', subject: 'Atlas', depth: 2, limit: 1 }])
    expect(text).toContain('sibling-atlas')
    expect(text).not.toContain('sibling-ava')
  })

  it('skips the vector leg under graph-first escalation when the graph connects the turn', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096, escalation: 'graph-first' }, fake.service)
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-atlas', text: 'atlas launch slipped a week' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    ctx.provide('evolutionGraph', fakeGraph({ labels: ['Atlas'], neighbors: ['Ava'] }).service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('atlas')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    // The graph already connected the turn to both sessions, so the vector
    // leg — and its query embedding call — never runs.
    expect(fake.batches).toHaveLength(0)
    expect(text).toContain('sibling-atlas')
    expect(text).toContain('sibling-ava')
    expect(text).toContain('via graph connections')
  })

  it('escalates to the vector leg under graph-first escalation when the graph finds nothing', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096, escalation: 'graph-first' }, fake.service)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])
    const graph = fakeGraph({ labels: ['Atlas'] })
    ctx.provide('evolutionGraph', graph.service as never)

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(graph.calls.expand).toEqual([])
    expect(fake.batches).toHaveLength(1)
    expect(text).toContain('sibling-needle')
    expect(text).not.toContain('via graph connections')
  })

  it('runs the vector leg under graph-first escalation when no graph is mounted', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096, escalation: 'graph-first' }, fake.service)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(fake.batches).toHaveLength(1)
    expect(text).toContain('sibling-needle')
  })

  it('runs both legs by default even when the graph connects the turn', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-atlas', text: 'atlas launch slipped a week' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    ctx.provide('evolutionGraph', fakeGraph({ labels: ['Atlas'], neighbors: ['Ava'] }).service as never)

    await preStep(ctx, fakeAgent(session), [textMessage('atlas')])

    // Default `both` preserves the historical behavior: the vector leg spends
    // its embedding call regardless of what the graph leg found.
    expect(fake.batches).toHaveLength(1)
  })

  it('keeps searching the remaining graph labels when one label search fails', async () => {
    class SelectiveSessionQuery extends SqliteSessionQueryEngine {
      readonly failing = new Set<string>()

      override searchSessions(
        request: SessionSearchRequest,
        exec?: SessionSearchExecContext,
      ): Promise<SessionSearchPage<SessionSearchHit>> {
        if (this.failing.has(request.query)) {
          return Promise.reject(new SessionQueryError('search disabled', 'SESSION_QUERY_SEARCH_DISABLED'))
        }
        return super.searchSessions(request, exec)
      }
    }
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: await temporaryPath('sessions'), compression: 'none' })
    await ctx.plugin(SelectiveSessionQuery, { path: await temporaryPath('derived.db') })
    const workspaces = new Map<string, Workspace>()
    ctx.provide('workspaceRegistry', {
      list: () => [...workspaces.values()],
      get: (id: WorkspaceId) => workspaces.get(String(id)),
    } as never)
    await ctx.plugin(activeMemoryContext, { maxBytes: 4096 })
    contexts.push(ctx)
    const session = await scopeWith(ctx, workspaces, [
      { id: 'sibling-atlas', text: 'atlas launch slipped a week' },
      { id: 'sibling-ava', text: 'ava owns the rollout' },
    ])
    ctx.provide('evolutionGraph', fakeGraph({ labels: ['Atlas'], neighbors: ['Ava'] }).service as never)
    const engine = ctx.get('sessionQuery') as SelectiveSessionQuery
    engine.failing.add('Atlas')

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('atlas')])
    const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

    expect(text).toContain('sibling-ava')
    expect(text).not.toContain('sibling-atlas')
  })

  it('propagates a lexical search failure that is not a SessionQueryError', async () => {
    class BrokenLexicalSessionQuery extends SqliteSessionQueryEngine {
      override searchSessions(): Promise<never> {
        return Promise.reject(new Error('lexical boom'))
      }
    }
    const fake = fakeEmbeddings()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root: await temporaryPath('sessions'), compression: 'none' })
    ctx.provide('embeddings', fake.service as never)
    await ctx.plugin(BrokenLexicalSessionQuery, { path: await temporaryPath('derived.db') })
    const workspaces = new Map<string, Workspace>()
    ctx.provide('workspaceRegistry', {
      list: () => [...workspaces.values()],
      get: (id: WorkspaceId) => workspaces.get(String(id)),
    } as never)
    await ctx.plugin(activeMemoryContext, { maxBytes: 4096 })
    contexts.push(ctx)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])
    // The label must match a token of the turn, or the graph leg seeds nothing
    // and never reaches the lexical search whose failure this test propagates.
    ctx.provide('evolutionGraph', fakeGraph({ labels: ['Needle'] }).service as never)

    await expect(preStep(ctx, fakeAgent(session), [textMessage('needle')])).rejects.toThrow('lexical boom')
  })

  it('records the retrieval configuration in force without changing the brief it injects', async () => {
    const recorded: { configuration: unknown; sessionId: string }[] = []
    const withLedger = fakeEmbeddings()
    const mounted = await harness({ maxBytes: 4096, escalation: 'graph-first', graphDepth: 2, relevanceThreshold: 0.5 }, withLedger.service)
    mounted.ctx.provide('evolutionRetrieval', {
      record: (input: { configuration: unknown; sessionId: string }) => {
        recorded.push(input)
        return Promise.resolve(input)
      },
    } as never)
    const mountedSession = await scopeWith(mounted.ctx, mounted.workspaces, [
      { id: 'sibling-needle', text: 'needle in the stack' },
    ])
    const mountedDecision = await preStep(mounted.ctx, fakeAgent(mountedSession), [textMessage('needle')])

    const withoutLedger = fakeEmbeddings()
    const plain = await harness({ maxBytes: 4096, escalation: 'graph-first', graphDepth: 2, relevanceThreshold: 0.5 }, withoutLedger.service)
    const plainSession = await scopeWith(plain.ctx, plain.workspaces, [
      { id: 'sibling-needle', text: 'needle in the stack' },
    ])
    const plainDecision = await preStep(plain.ctx, fakeAgent(plainSession), [textMessage('needle')])

    expect(recorded).toEqual([{
      configuration: {
        source: 'graph',
        queryExpansion: 'graph-entities',
        weights: { vector: 1, graph: 1 },
        reranker: 'none',
        mmr: { enabled: false, lambda: 1 },
        memoryScope: 'workspace',
        graphDepth: 2,
        threshold: 0.5,
      },
      sessionId: 'current',
    }])
    const briefs = (decision: typeof mountedDecision) => briefsOf(decision.kind === 'enter' ? decision.messages : [])
    expect(briefs(mountedDecision)).toHaveLength(1)
    expect(briefText(briefs(mountedDecision)[0])).toBe(briefText(briefs(plainDecision)[0]))
  })

  it('records one configuration per session across retried steps', async () => {
    const recorded: { sessionId: string }[] = []
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    ctx.provide('evolutionRetrieval', {
      record: (input: { sessionId: string }) => {
        recorded.push(input)
        return Promise.resolve(input)
      },
    } as never)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])

    await preStep(ctx, fakeAgent(session), [textMessage('needle')])
    await preStep(ctx, fakeAgent(session), [textMessage('needle')], { turn: 2 })

    expect(recorded.map(entry => entry.sessionId)).toEqual(['current'])
  })

  it('keeps serving the turn when the retrieval store rejects the record', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096 }, fake.service)
    const debugged: string[] = []
    ctx.provide('evolutionRetrieval', { record: () => Promise.reject(new Error('store offline')) } as never)
    ctx.logger.debug = ((message: string) => {
      debugged.push(message)
    }) as typeof ctx.logger.debug
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(1)
    // The rejection reaction is queued before the step's own awaits continue, so it has run by now.
    await Promise.resolve()
    expect(debugged.some(message => message.includes('retrieval-configuration record degraded'))).toBe(true)
  })
})

describe('task-aware retrieval policy', () => {
  it('leaves the brief byte-identical when the policy is off, recommendation present or not', async () => {
    const withStores = fakeEmbeddings()
    const { ctx, workspaces } = await harness({ maxBytes: 4096, relevanceThreshold: 0.5 }, withStores.service)
    ctx.provide('evolutionRetrieval', fakeRetrievalStore({
      writer: { configuration: recommendedConfiguration({ threshold: 0.9, graphDepth: 4 }), score: 0.8 },
    }).service as never)
    ctx.provide('evolutionSkillTelemetry', fakeSkillTelemetry({ writer: ['current'] }) as never)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-hay', text: 'hay needle' }])
    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    const plainEmbeddings = fakeEmbeddings()
    const plain = await harness({ maxBytes: 4096, relevanceThreshold: 0.5 }, plainEmbeddings.service)
    const plainSession = await scopeWith(plain.ctx, plain.workspaces, [{ id: 'sibling-hay', text: 'hay needle' }])
    const plainDecision = await preStep(plain.ctx, fakeAgent(plainSession), [textMessage('needle')])

    const briefs = briefsOf(decision.kind === 'enter' ? decision.messages : [])
    expect(briefs).toHaveLength(1)
    expect(briefText(briefs[0])).toBe(briefText(briefsOf(plainDecision.kind === 'enter' ? plainDecision.messages : [])[0]))
    // Nothing that consumes the recommendation leaves a mark on the record.
    expect(briefs[0]?.source).toEqual({ kind: 'active-memory', form: 'search-result' })
  })

  it('runs the recommended lane and graph depth and records what it applied', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness(
      { maxBytes: 4096, relevanceThreshold: 0.5, graphDepth: 1, taskAwarePolicy: true },
      fake.service,
    )
    ctx.provide('evolutionRetrieval', fakeRetrievalStore({
      writer: {
        configuration: recommendedConfiguration({ source: 'graph', graphDepth: 3, threshold: 0.9, memoryScope: 'global' }),
        score: 0.8,
      },
    }).service as never)
    ctx.provide('evolutionSkillTelemetry', fakeSkillTelemetry({ writer: ['current'] }) as never)
    const graph = fakeGraph({ labels: ['Needle'], neighbors: ['Haystack'] })
    ctx.provide('evolutionGraph', graph.service as never)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    const briefs = briefsOf(decision.kind === 'enter' ? decision.messages : [])
    expect(briefs).toHaveLength(1)
    // The recommended `source: 'graph'` is the graph-first lane, so the graph
    // leg answers the turn and the vector leg's embedding call never runs.
    expect(fake.batches).toHaveLength(0)
    expect(graph.calls.expand[0]?.depth).toBe(3)
    expect(briefs[0]?.source).toEqual({
      kind: 'active-memory',
      form: 'search-result',
      policy: {
        taskClass: 'writer',
        configKey: 'key-writer',
        applied: [
          { dimension: 'source', value: 'graph' },
          { dimension: 'graphDepth', value: '3' },
          { dimension: 'threshold', value: '0.9' },
        ],
        unapplied: [
          expect.objectContaining({ dimension: 'queryExpansion' }),
          expect.objectContaining({ dimension: 'weights' }),
          expect.objectContaining({ dimension: 'reranker' }),
          expect.objectContaining({ dimension: 'mmr' }),
          expect.objectContaining({ dimension: 'memoryScope', value: 'global' }),
        ],
        effective: { escalation: 'graph-first', graphDepth: 3, threshold: 0.9 },
      },
    })
  })

  it('filters the vector leg at the recommended threshold', async () => {
    // 'hay needle' scores 0.707 against 'needle': above the mount's 0.5, below
    // the recommendation's 0.9, so the two configurations retrieve differently.
    const filtered = fakeEmbeddings()
    const { ctx, workspaces } = await harness(
      { maxBytes: 4096, relevanceThreshold: 0.5, taskAwarePolicy: true },
      filtered.service,
    )
    ctx.provide('evolutionRetrieval', fakeRetrievalStore({
      writer: { configuration: recommendedConfiguration({ threshold: 0.9 }), score: 0.8 },
    }).service as never)
    ctx.provide('evolutionSkillTelemetry', fakeSkillTelemetry({ writer: ['current'] }) as never)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-hay', text: 'hay needle' }])
    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    const kept = fakeEmbeddings()
    const off = await harness({ maxBytes: 4096, relevanceThreshold: 0.5 }, kept.service)
    const offSession = await scopeWith(off.ctx, off.workspaces, [{ id: 'sibling-hay', text: 'hay needle' }])
    const offDecision = await preStep(off.ctx, fakeAgent(offSession), [textMessage('needle')])

    expect(briefsOf(decision.kind === 'enter' ? decision.messages : [])).toHaveLength(0)
    expect(briefsOf(offDecision.kind === 'enter' ? offDecision.messages : [])).toHaveLength(1)
  })

  it("consults the strongest recommendation across the session's recorded task classes", async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness(
      { maxBytes: 4096, relevanceThreshold: 0.5, taskAwarePolicy: true },
      fake.service,
    )
    // The classes are consulted in name order: alpha leads, beta outscores it,
    // delta stays below it, and gamma records nothing to recommend.
    ctx.provide('evolutionRetrieval', fakeRetrievalStore({
      alpha: { configuration: recommendedConfiguration({ graphDepth: 2 }), score: 0.4 },
      beta: { configuration: recommendedConfiguration({ graphDepth: 5 }), score: 0.9 },
      delta: { configuration: recommendedConfiguration({ graphDepth: 6 }), score: 0.1 },
    }).service as never)
    ctx.provide('evolutionSkillTelemetry', fakeSkillTelemetry({
      alpha: ['current'],
      beta: ['current'],
      delta: ['current'],
      gamma: ['current'],
    }) as never)
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    const brief = briefsOf(decision.kind === 'enter' ? decision.messages : [])[0]
    expect(brief?.source).toMatchObject({ policy: { taskClass: 'beta', configKey: 'key-beta', effective: { graphDepth: 5 } } })
  })

  it('runs the mount configuration and says so when no telemetry store records the turn', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness(
      { maxBytes: 4096, relevanceThreshold: 0.5, taskAwarePolicy: true },
      fake.service,
    )
    ctx.provide('evolutionRetrieval', fakeRetrievalStore({
      writer: { configuration: recommendedConfiguration({ threshold: 0.9 }), score: 0.8 },
    }).service as never)
    const debugged: string[] = []
    ctx.logger.debug = ((message: string) => {
      debugged.push(message)
    }) as typeof ctx.logger.debug
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-hay', text: 'hay needle' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    const brief = briefsOf(decision.kind === 'enter' ? decision.messages : [])[0]
    // The mount's own 0.5 threshold kept the 0.707 hit, and the record is bare.
    expect(briefText(brief)).toContain('sibling-hay')
    expect(brief?.source).toEqual({ kind: 'active-memory', form: 'search-result' })
    expect(debugged.some(message => message.includes("running the mount's own configuration"))).toBe(true)
  })

  it('runs the mount configuration when no skill recorded this session', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness(
      { maxBytes: 4096, relevanceThreshold: 0.5, taskAwarePolicy: true },
      fake.service,
    )
    ctx.provide('evolutionRetrieval', fakeRetrievalStore({
      writer: { configuration: recommendedConfiguration({ threshold: 0.9 }), score: 0.8 },
    }).service as never)
    ctx.provide('evolutionSkillTelemetry', fakeSkillTelemetry({ writer: ['another-session'] }) as never)
    const debugged: string[] = []
    ctx.logger.debug = ((message: string) => {
      debugged.push(message)
    }) as typeof ctx.logger.debug
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-hay', text: 'hay needle' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])).toContain('sibling-hay')
    expect(debugged.some(message => message.includes("running the mount's own configuration"))).toBe(true)
  })

  it('runs the mount configuration when the recorded class has no recommendation', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness(
      { maxBytes: 4096, relevanceThreshold: 0.5, taskAwarePolicy: true },
      fake.service,
    )
    ctx.provide('evolutionRetrieval', fakeRetrievalStore().service as never)
    ctx.provide('evolutionSkillTelemetry', fakeSkillTelemetry({ writer: ['current'] }) as never)
    const debugged: string[] = []
    ctx.logger.debug = ((message: string) => {
      debugged.push(message)
    }) as typeof ctx.logger.debug
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-hay', text: 'hay needle' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])).toContain('sibling-hay')
    expect(debugged.some(message => message.includes("running the mount's own configuration"))).toBe(true)
  })

  it('runs the mount configuration when the mounted store cannot recommend', async () => {
    const fake = fakeEmbeddings()
    const { ctx, workspaces } = await harness(
      { maxBytes: 4096, relevanceThreshold: 0.5, taskAwarePolicy: true },
      fake.service,
    )
    ctx.provide('evolutionRetrieval', {
      record: () => Promise.resolve(undefined),
    } as never)
    ctx.provide('evolutionSkillTelemetry', fakeSkillTelemetry({ writer: ['current'] }) as never)
    const debugged: string[] = []
    ctx.logger.debug = ((message: string) => {
      debugged.push(message)
    }) as typeof ctx.logger.debug
    const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-hay', text: 'hay needle' }])

    const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])

    expect(briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])).toContain('sibling-hay')
    expect(debugged.some(message => message.includes("running the mount's own configuration"))).toBe(true)
  })
})

describe('resolveConfig', () => {
  it('fills every optional field with its default when omitted', () => {
    expect(resolveConfig({ maxBytes: 1024 })).toEqual({
      maxBytes: 1024,
      topK: 5,
      relevanceThreshold: 0.7,
      turnInterval: 1,
      escalation: 'both',
      profile: 'default',
      graphDepth: 1,
      graphLimit: 5,
      taskAwarePolicy: false,
    })
  })

  it('keeps every explicitly configured value as given', () => {
    expect(resolveConfig({
      maxBytes: 2048,
      topK: 3,
      relevanceThreshold: 0.42,
      turnInterval: 4,
      escalation: 'graph-first',
      profile: 'team',
      graphDepth: 2,
      graphLimit: 7,
      taskAwarePolicy: true,
    })).toEqual({
      maxBytes: 2048,
      topK: 3,
      relevanceThreshold: 0.42,
      turnInterval: 4,
      escalation: 'graph-first',
      profile: 'team',
      graphDepth: 2,
      graphLimit: 7,
      taskAwarePolicy: true,
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
