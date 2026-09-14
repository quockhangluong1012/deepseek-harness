import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  rankBySimilarity,
  SEMANTIC_CANDIDATES_SQL,
} from '../src/semantic.ts'

const directories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  // The engine holds the database open until its fiber disposes; on Windows a
  // removal before that fails with EBUSY.
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-semantic-'))
  directories.push(directory)
  return join(directory, name)
}

function header(id: string, createdAt = 1): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false }
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

/** Embedding service double recording every batch it is asked for. */
function fakeEmbeddings() {
  const batches: string[][] = []
  return {
    batches,
    service: {
      resolve: () => ({ provider: 'fake', model: 'fake-embed' }),
      embed: ({ texts }: { texts: readonly string[] }) => {
        batches.push([...texts])
        return Promise.resolve({
          spec: { provider: 'fake', model: 'fake-embed' },
          vectors: texts.map(bagOfWords),
          cached: 0,
          embedded: texts.length,
        })
      },
    },
  }
}

/** Context with real JSONL persistence, the search index, and an optional embedding service. */
async function harness(embeddings?: unknown) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, {
    root: await temporaryPath('sessions'),
    compression: 'none',
  })
  if (embeddings !== undefined) ctx.provide('embeddings', embeddings as never)
  await ctx.plugin(SqliteSessionQueryEngine, { path: await temporaryPath('derived.db') })
  contexts.push(ctx)
  return ctx
}

/** Persist one session whose single event carries `text`. */
async function persist(ctx: Context, id: string, text: string, createdAt = 10): Promise<SessionHeader> {
  const meta = header(id, createdAt)
  const writer = await ctx.sessionPersistence.create(meta)
  await writer.append(messageEvents(text))
  await writer.close()
  return meta
}

describe('semantic channel primitives', () => {
  it('round-trips a vector through the stored encoding', () => {
    const vector = [0.5, -1.25, 3]
    const decoded = decodeVector(encodeVector(vector))
    expect(decoded).toHaveLength(3)
    decoded?.forEach((value, index) => { expect(value).toBeCloseTo(vector[index] ?? 0, 6) })
  })

  it('refuses a stored blob that is not a whole number of float32 values', () => {
    expect(decodeVector(new Uint8Array([]))).toBeUndefined()
    expect(decodeVector(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  it('measures cosine similarity over equal-length vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
  })

  it('ranks rows by similarity, skipping vectors of another length', () => {
    const rows = [{ doc_rowid: 1 }, { doc_rowid: 2 }, { doc_rowid: 3 }]
    const vectors = new Map<number, readonly number[]>([
      [1, [1, 0]],
      [2, [0, 1]],
      [3, [1, 0, 0]],
    ])
    expect(rankBySimilarity(rows, [1, 0], vectors).map(entry => entry.row.doc_rowid)).toEqual([1, 2])
  })

  it('skips rows with no vector and orders a similarity tie by rowid', () => {
    const rows = [{ doc_rowid: 7 }, { doc_rowid: 3 }, { doc_rowid: 5 }]
    const vectors = new Map<number, readonly number[]>([
      [7, [1, 0]],
      [3, [1, 0]],
      [5, [1, 0]],
    ])
    expect(rankBySimilarity(rows, [1, 0], vectors).map(entry => entry.row.doc_rowid)).toEqual([3, 5, 7])
    const partial = new Map<number, readonly number[]>([[7, [1, 0]]])
    expect(rankBySimilarity(rows, [1, 0], partial).map(entry => entry.row.doc_rowid)).toEqual([7])
  })

  it('keeps the candidate query free of full-text matching', () => {
    expect(SEMANTIC_CANDIDATES_SQL).not.toContain('MATCH')
    expect(SEMANTIC_CANDIDATES_SQL).toContain('temp.live_docs')
  })
})

describe('semantic session search', () => {
  it('refuses the call when no embedding service is mounted', async () => {
    const ctx = await harness()
    await persist(ctx, 'a', 'needle')
    await expect(ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' }))
      .rejects.toMatchObject({ code: 'SESSION_QUERY_SEMANTIC_UNAVAILABLE' })
  })

  it('answers an empty corpus without asking for a vector', async () => {
    const fake = fakeEmbeddings()
    const ctx = await harness(fake.service)
    await expect(ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' })).resolves.toEqual({ items: [] })
    expect(fake.batches).toHaveLength(0)
  })

  it('ranks sessions by similarity to the query and embeds the query last', async () => {
    const fake = fakeEmbeddings()
    const ctx = await harness(fake.service)
    await persist(ctx, 'hay', 'hay straw')
    await persist(ctx, 'needle', 'needle needle')
    const page = await ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' })
    expect(page.items.map(hit => hit.header.id)).toEqual(['needle', 'hay'])
    expect(page.items[0]?.bestMatch.snippet).toContain('needle')
    expect(fake.batches[0]?.at(-1)).toBe('needle')
  })

  it('reuses stored document vectors on the next search', async () => {
    const fake = fakeEmbeddings()
    const ctx = await harness(fake.service)
    await persist(ctx, 'needle', 'needle need')
    await ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' })
    fake.batches.length = 0
    await ctx.sessionQuery.searchSessionsSemantic({ query: 'hay' })
    expect(fake.batches).toEqual([['hay']])
  })

  it('forwards the caller signal, including when only the query is embedded', async () => {
    const fake = fakeEmbeddings()
    const ctx = await harness(fake.service)
    await persist(ctx, 'needle', 'needle need')
    const controller = new AbortController()
    await ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' }, { signal: controller.signal })
    // Every document vector is stored now, so this batch carries the query alone.
    fake.batches.length = 0
    await ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' }, { signal: controller.signal })
    expect(fake.batches).toEqual([['needle']])
  })

  it('honours the page limit and the session filters', async () => {
    const fake = fakeEmbeddings()
    const ctx = await harness(fake.service)
    await persist(ctx, 'a', 'needle', 5)
    await persist(ctx, 'b', 'needle', 50)
    const all = await ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' })
    expect(all.items).toHaveLength(2)
    const limited = await ctx.sessionQuery.searchSessionsSemantic({
      query: 'needle',
      sessionFilters: [{ kind: 'created-at', from: 40 }],
      limit: 1,
    })
    expect(limited.items.map(hit => hit.header.id)).toEqual(['b'])
  })

  it('ranks live documents when the deployment mounts no persistence', async () => {
    const fake = fakeEmbeddings()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('embeddings', fake.service as never)
    await ctx.plugin(SqliteSessionQueryEngine, { path: await temporaryPath('live.db') })
    contexts.push(ctx)
    ctx.sessions.create(SessionId('live-needle'), { seed: messageEvents('needle needle') })
    ctx.sessions.create(SessionId('live-hay'), { seed: messageEvents('hay straw') })
    const page = await ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' })
    expect(page.items.map(hit => hit.header.id)).toEqual(['live-needle', 'live-hay'])
    // Live documents are not stored, so the next search embeds them again.
    fake.batches.length = 0
    await ctx.sessionQuery.searchSessionsSemantic({ query: 'needle' })
    expect(fake.batches[0]).toHaveLength(3)
  })

  it('fuses the lexical and semantic rankings', async () => {
    const fake = fakeEmbeddings()
    const ctx = await harness(fake.service)
    await persist(ctx, 'both', 'needle here')
    await persist(ctx, 'hay', 'hay straw')
    const page = await ctx.sessionQuery.searchSessionsHybrid({ query: 'needle' })
    expect(page.items[0]?.header.id).toBe('both')
    expect(page.items).toHaveLength(2)
  })
})
