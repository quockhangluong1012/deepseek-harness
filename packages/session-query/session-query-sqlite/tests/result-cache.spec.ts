import { describe, expect, it, afterEach, vi } from 'vitest'
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
import { SessionResultCache } from '../src/result-cache.ts'

describe('SessionResultCache', () => {
  it('misses a key that was never stored', () => {
    const cache = new SessionResultCache<number>({ maxEntries: 2, ttlMs: 1000 })
    expect(cache.get('a', 0)).toBeUndefined()
    expect(cache.size).toBe(0)
  })

  it('answers a stored key until it ages past the configured TTL', () => {
    const cache = new SessionResultCache<number>({ maxEntries: 2, ttlMs: 100 })
    cache.set('a', [1, 2], 0)
    expect(cache.get('a', 50)).toEqual([1, 2])
    expect(cache.get('a', 101)).toBeUndefined()
    // An expired read also evicts the entry rather than leaving it held.
    expect(cache.size).toBe(0)
  })

  it('evicts the least recently used entry once the bound is exceeded', () => {
    const cache = new SessionResultCache<number>({ maxEntries: 2, ttlMs: 1000 })
    cache.set('a', [1], 0)
    cache.set('b', [2], 0)
    // Touching `a` makes `b` the least recently used entry.
    expect(cache.get('a', 0)).toEqual([1])
    cache.set('c', [3], 0)
    expect(cache.get('b', 0)).toBeUndefined()
    expect(cache.get('a', 0)).toEqual([1])
    expect(cache.get('c', 0)).toEqual([3])
    expect(cache.size).toBe(2)
  })

  it('overwrites an existing key without growing past the bound', () => {
    const cache = new SessionResultCache<number>({ maxEntries: 1, ttlMs: 1000 })
    cache.set('a', [1], 0)
    cache.set('a', [2], 0)
    expect(cache.get('a', 0)).toEqual([2])
    expect(cache.size).toBe(1)
  })

  it('drops every entry on clear', () => {
    const cache = new SessionResultCache<number>({ maxEntries: 2, ttlMs: 1000 })
    cache.set('a', [1], 0)
    cache.set('b', [2], 0)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.get('a', 0)).toBeUndefined()
  })
})

const directories: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  // The engine holds the database open until its fiber disposes; on Windows a
  // removal before that fails with EBUSY.
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function temporaryPath(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-result-cache-'))
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

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root: await temporaryPath('sessions'), compression: 'none' })
  await ctx.plugin(SqliteSessionQueryEngine, { path: await temporaryPath('derived.db') })
  contexts.push(ctx)
  return ctx
}

async function persist(ctx: Context, id: string, text: string, createdAt = 10): Promise<SessionHeader> {
  const meta = header(id, createdAt)
  const writer = await ctx.sessionPersistence.create(meta)
  await writer.append(messageEvents(text))
  await writer.close()
  return meta
}

describe('engine result cache', () => {
  it('answers a repeated identical session search from the cache instead of re-querying', async () => {
    const ctx = await harness()
    await persist(ctx, 'session-a', 'needle in haystack')
    const spy = vi.spyOn(ctx.sessionQuery as unknown as { _querySessions: () => unknown }, '_querySessions' as never)
    const first = await ctx.sessionQuery.searchSessions({ query: 'needle' })
    const second = await ctx.sessionQuery.searchSessions({ query: 'needle' })
    expect(second).toEqual(first)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('re-queries once the corpus changes, never serving a page that predates it', async () => {
    const ctx = await harness()
    await persist(ctx, 'session-a', 'needle in haystack')
    const before = await ctx.sessionQuery.searchSessions({ query: 'needle' })
    expect(before.items).toHaveLength(1)
    await persist(ctx, 'session-b', 'needle in haystack too')
    const after = await ctx.sessionQuery.searchSessions({ query: 'needle' })
    expect(after.items).toHaveLength(2)
  })

  it('answers a repeated identical event search from the cache instead of re-querying', async () => {
    const ctx = await harness()
    const meta = await persist(ctx, 'session-a', 'needle in haystack')
    const spy = vi.spyOn(ctx.sessionQuery as unknown as { _queryEvents: () => unknown }, '_queryEvents' as never)
    const first = await ctx.sessionQuery.searchEvents({ sessionId: meta.id, query: 'needle' })
    const second = await ctx.sessionQuery.searchEvents({ sessionId: meta.id, query: 'needle' })
    expect(second).toEqual(first)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('keys event pages so two different sessions never share a cache entry', async () => {
    const ctx = await harness()
    const a = await persist(ctx, 'session-a', 'needle in haystack')
    const b = await persist(ctx, 'session-b', 'needle in haystack too')
    const eventsA = await ctx.sessionQuery.searchEvents({ sessionId: a.id, query: 'needle' })
    const eventsB = await ctx.sessionQuery.searchEvents({ sessionId: b.id, query: 'needle' })
    expect(eventsA.session.id).toBe(a.id)
    expect(eventsB.session.id).toBe(b.id)
  })

  it('drops every cached page when the engine closes', async () => {
    const ctx = await harness()
    await persist(ctx, 'session-a', 'needle in haystack')
    await ctx.sessionQuery.searchSessions({ query: 'needle' })
    const engine = ctx.sessionQuery as unknown as { _resultCache: { size: number } }
    expect(engine._resultCache.size).toBeGreaterThan(0)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
    expect(engine._resultCache.size).toBe(0)
  })
})
