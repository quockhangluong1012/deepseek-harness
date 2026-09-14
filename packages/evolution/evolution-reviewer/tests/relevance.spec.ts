import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { LessonArtifact } from '@deepseek-ai/dsh-evolution-memory'
import { rankByRecency, rankBySimilarity, selectRelevantArtifacts } from '../src/relevance.ts'

/** One artifact stamped with the given update instant; every other field is fixed. */
function artifact(id: string, updatedAt: string, statement = id): LessonArtifact {
  return {
    id,
    statement,
    source: 'session',
    conditions: '',
    evidence: 'fact',
    confidence: 1,
    validationCount: 0,
    refutationCount: 0,
    scope: 'project',
    createdAt: updatedAt,
    updatedAt,
  }
}

/** Embeddings seam double: records every batch and answers from a lookup map. */
function seam(vectors: readonly (readonly number[])[] | Error, batches: string[][] = []) {
  return {
    batches,
    embed: async ({ texts }: { texts: readonly string[] }) => {
      batches.push([...texts])
      if (vectors instanceof Error) throw vectors
      return { vectors }
    },
  }
}

describe('rankByRecency', () => {
  it('orders newest first and truncates to the limit', () => {
    const artifacts = [artifact('old', '2026-01-01T00:00:00Z'), artifact('new', '2026-03-01T00:00:00Z'), artifact('mid', '2026-02-01T00:00:00Z')]
    expect(rankByRecency(artifacts, 2).map(entry => entry.id)).toEqual(['new', 'mid'])
  })

  it('leaves the caller-supplied order untouched', () => {
    const artifacts = [artifact('old', '2026-01-01T00:00:00Z'), artifact('new', '2026-03-01T00:00:00Z')]
    rankByRecency(artifacts, 1)
    expect(artifacts.map(entry => entry.id)).toEqual(['old', 'new'])
  })

  it('returns nothing for a scope with no artifacts', () => {
    expect(rankByRecency([], 5)).toEqual([])
  })
})

describe('rankBySimilarity', () => {
  const close = artifact('close', '2026-01-01T00:00:00Z')
  const further = artifact('further', '2026-01-02T00:00:00Z')
  const orthogonal = artifact('orthogonal', '2026-01-03T00:00:00Z')

  it('orders by descending cosine similarity', () => {
    const vectors = new Map<string, readonly number[]>([
      ['close', [1, 0]],
      ['further', [0.9, 0.4358898943540674]],
      ['orthogonal', [0, 1]],
    ])
    expect(rankBySimilarity([1, 0], [orthogonal, close, further], vectors, 3).map(entry => entry.id))
      .toEqual(['close', 'further', 'orthogonal'])
  })

  it('sorts an artifact with no vector last instead of dropping it', () => {
    const vectors = new Map<string, readonly number[]>([['close', [1, 0]], ['orthogonal', [0, 1]]])
    expect(rankBySimilarity([1, 0], [orthogonal, further, close], vectors, 3).map(entry => entry.id))
      .toEqual(['close', 'orthogonal', 'further'])
  })

  it('truncates to the limit and falls back to input order without any vectors', () => {
    const vectors = new Map<string, readonly number[]>([['close', [1, 0]], ['further', [0.9, 0.4358898943540674]]])
    expect(rankBySimilarity([1, 0], [further, close], vectors, 1).map(entry => entry.id)).toEqual(['close'])
    expect(rankBySimilarity([1, 0], [further, close], new Map(), 5).map(entry => entry.id)).toEqual(['further', 'close'])
  })
})

describe('selectRelevantArtifacts', () => {
  it('falls back to recency when no embeddings service is mounted', async () => {
    const ctx = new Context()
    const artifacts = [artifact('old', '2026-01-01T00:00:00Z'), artifact('new', '2026-03-01T00:00:00Z')]
    expect((await selectRelevantArtifacts(ctx, artifacts, 'anything', 2)).map(entry => entry.id)).toEqual(['new', 'old'])
  })

  it('falls back to recency when a foreign value sits behind the seam', async () => {
    const ctx = new Context()
    ctx.provide('embeddings', {})
    const artifacts = [artifact('old', '2026-01-01T00:00:00Z'), artifact('new', '2026-03-01T00:00:00Z')]
    expect((await selectRelevantArtifacts(ctx, artifacts, 'anything', 2)).map(entry => entry.id)).toEqual(['new', 'old'])
  })

  it('embeds the query and every statement in one batch, then ranks by similarity', async () => {
    const ctx = new Context()
    const embeddings = seam([[1, 0], [1, 0], [0, 1]])
    ctx.provide('embeddings', embeddings)
    const artifacts = [artifact('matching', '2026-01-01T00:00:00Z', 'use postgres'), artifact('other', '2026-03-01T00:00:00Z', 'answer briefly')]
    const selected = await selectRelevantArtifacts(ctx, artifacts, 'which database?', 2)
    expect(embeddings.batches).toEqual([['which database?', 'use postgres', 'answer briefly']])
    expect(selected.map(entry => entry.id)).toEqual(['matching', 'other'])
  })

  it('skips the batch entirely for a scope with no artifacts', async () => {
    const ctx = new Context()
    const embeddings = seam([[1, 0]])
    ctx.provide('embeddings', embeddings)
    expect(await selectRelevantArtifacts(ctx, [], 'anything', 5)).toEqual([])
    expect(embeddings.batches).toEqual([])
  })

  it('falls back to recency when the batch rejects', async () => {
    const ctx = new Context()
    ctx.provide('embeddings', seam(new Error('embeddings offline')))
    const artifacts = [artifact('old', '2026-01-01T00:00:00Z'), artifact('new', '2026-03-01T00:00:00Z')]
    expect((await selectRelevantArtifacts(ctx, artifacts, 'anything', 2)).map(entry => entry.id)).toEqual(['new', 'old'])
  })

  it('falls back to recency when the batch answers without a query vector', async () => {
    const ctx = new Context()
    ctx.provide('embeddings', seam([]))
    const artifacts = [artifact('old', '2026-01-01T00:00:00Z'), artifact('new', '2026-03-01T00:00:00Z')]
    expect((await selectRelevantArtifacts(ctx, artifacts, 'anything', 2)).map(entry => entry.id)).toEqual(['new', 'old'])
  })

  it('ranks a short batch to the end rather than failing the ranking', async () => {
    const ctx = new Context()
    ctx.provide('embeddings', seam([[1, 0], [0.6, 0.8]]))
    const artifacts = [artifact('scored', '2026-01-01T00:00:00Z'), artifact('unanswered', '2026-03-01T00:00:00Z')]
    expect((await selectRelevantArtifacts(ctx, artifacts, 'anything', 2)).map(entry => entry.id)).toEqual(['scored', 'unanswered'])
  })
})
