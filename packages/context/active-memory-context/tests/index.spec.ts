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

  it('degrades to the vector leg when the configured profile is not a valid scope', async () => {
    for (const profile of ['team:eu', '']) {
      const fake = fakeEmbeddings()
      const { ctx, workspaces } = await harness({ maxBytes: 4096, profile }, fake.service)
      const session = await scopeWith(ctx, workspaces, [{ id: 'sibling-needle', text: 'needle in the stack' }])
      const graph = fakeGraph({ labels: ['Needle'], neighbors: ['Ava'] })
      ctx.provide('evolutionGraph', graph.service as never)

      // `EvolutionScopeId` rejects this profile, so the turn must still resolve.
      const decision = await preStep(ctx, fakeAgent(session), [textMessage('needle')])
      const text = briefText(briefsOf(decision.kind === 'enter' ? decision.messages : [])[0])

      expect(text).toContain('sibling-needle')
      expect(text).not.toContain('via graph connections')
      expect(graph.calls.find).toEqual([])
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
})

describe('resolveConfig', () => {
  it('fills every optional field with its default when omitted', () => {
    expect(resolveConfig({ maxBytes: 1024 })).toEqual({
      maxBytes: 1024,
      topK: 5,
      relevanceThreshold: 0.7,
      turnInterval: 1,
      profile: 'default',
      graphDepth: 1,
      graphLimit: 5,
    })
  })

  it('keeps every explicitly configured value as given', () => {
    expect(resolveConfig({
      maxBytes: 2048,
      topK: 3,
      relevanceThreshold: 0.42,
      turnInterval: 4,
      profile: 'team',
      graphDepth: 2,
      graphLimit: 7,
    })).toEqual({
      maxBytes: 2048,
      topK: 3,
      relevanceThreshold: 0.42,
      turnInterval: 4,
      profile: 'team',
      graphDepth: 2,
      graphLimit: 7,
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
