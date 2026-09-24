import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMemoryStore, { EvolutionScopeId } from '../src/index.ts'
import { artifactKey, type LessonArtifact, type LessonArtifactInput } from '../src/lesson-artifact.ts'
import { cosineSimilarity, mergeArtifact, pickMergeTarget } from '../src/merge.ts'
import type { EvolutionScopeId as ScopeId } from '../src/types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * A staged payload carrying artifact candidates. `LessonArtifactInput` is a
 * mapped type whose optional `ttlDays` admits `undefined`, so it is not
 * assignable to the store's `JsonValue` payload type even though the value
 * stored is JSON; the store validates the candidate when the entry is
 * approved, so the bridge cast is test-side only.
 * @param value - the payload object to hand the store.
 * @returns the same object typed as a JSON value.
 */
function artifactPayload(value: object): JsonValue {
  return value as unknown as JsonValue
}

const NOW = '2026-09-13T00:00:00.000Z'

function artifact(statement: string, overrides: Partial<LessonArtifact> = {}): LessonArtifact {
  return {
    id: artifactKey(statement), statement, source: 's1', conditions: 'first', evidence: 'inference',
    confidence: 0.6, validationCount: 2, refutationCount: 1, scope: 'project',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  }
}

function candidate(statement: string, overrides: Partial<LessonArtifactInput> = {}): LessonArtifactInput {
  return {
    statement, source: 's2', conditions: 'second', evidence: 'fact', confidence: 0.9, scope: 'project',
    sourceRefs: ['session:s2'], trajectoryRefs: ['run:s2'], lineage: { origin: 's2' }, ...overrides,
  }
}

describe('cosine similarity', () => {
  it('is 1 for equal vectors, 0 for orthogonal ones, and 0 without a magnitude', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6)
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0)
    // A position the other vector does not have counts as zero, so a truncated
    // vector yields a finite score rather than NaN.
    expect(cosineSimilarity([1, 1], [1])).toBeCloseTo(Math.SQRT1_2, 6)
  })
})

describe('lesson artifact merge', () => {
  it('overwrites content while keeping identity, counts, and creation instant', () => {
    const merged = mergeArtifact(artifact('use postgres'), candidate('use postgres 15'), 'overwrite', NOW)
    expect(merged).toMatchObject({
      // The statement is the artifact's identity, so an overwrite keeps it and
      // replaces the content around it; a re-keyed id would break addressing.
      id: artifactKey('use postgres'), statement: 'use postgres', source: 's2', conditions: 'second',
      evidence: 'fact', confidence: 0.9, validationCount: 2, refutationCount: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: NOW,
    })
  })

  it('merges conditions, keeps the higher confidence, and keeps both counters', () => {
    const merged = mergeArtifact(artifact('use postgres'), candidate('use postgres', { confidence: 0.4 }), 'merge', NOW)
    expect(merged.conditions).toBe('first; second')
    expect(merged.confidence).toBe(0.6)
    expect(merged.validationCount).toBe(2)
    expect(merged.refutationCount).toBe(1)
    expect(merged.updatedAt).toBe(NOW)
  })

  it('unions conditions, keeping whichever side carries them', () => {
    const fromCandidate = mergeArtifact(artifact('use postgres', { conditions: '' }), candidate('use postgres'), 'merge', NOW)
    expect(fromCandidate.conditions).toBe('second')
    const fromArtifact = mergeArtifact(artifact('use postgres'), candidate('use postgres', { conditions: '' }), 'merge', NOW)
    expect(fromArtifact.conditions).toBe('first')
  })

  it('selects the nearest artifact above the floor and nothing below it', () => {
    const existing = [artifact('use postgres'), artifact('prefers short answers')]
    const near = new Map([[artifactKey('use postgres'), 0.93], [artifactKey('prefers short answers'), 0.2]])
    expect(pickMergeTarget(candidate('use postgres 15'), existing, near, 0.87)?.id).toBe(artifactKey('use postgres'))
    const far = new Map([[artifactKey('use postgres'), 0.4], [artifactKey('prefers short answers'), 0.2]])
    expect(pickMergeTarget(candidate('use postgres 15'), existing, far, 0.87)).toBeUndefined()
  })

  it('prefers an exact identity over any similarity and skips unscored artifacts', () => {
    const existing = [artifact('use postgres'), artifact('prefers short answers')]
    const scored = new Map([[artifactKey('prefers short answers'), 0.99]])
    expect(pickMergeTarget(candidate('use postgres'), existing, scored, 0.87)?.id).toBe(artifactKey('use postgres'))
    expect(pickMergeTarget(candidate('unrelated fact'), existing, scored, 0.87)?.id).toBe(artifactKey('prefers short answers'))
  })
})

/** Minimal embeddings seam double: the store reads only `embed`. */
interface FakeEmbeddings {
  /** Every batch of texts the store asked to embed, in call order. */
  batches: string[][]
  /** Vectors keyed by text; a text with no entry contributes no vector. */
  vectors: Map<string, readonly number[]>
  /**
   * Runs inside the embed call, which is the window between the store reading
   * the record and entering its write chain — the seam a concurrent writer
   * lands in.
   */
  onEmbed?: () => Promise<void>
}

async function harness(embeddings?: FakeEmbeddings) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  if (embeddings !== undefined) {
    ctx.provide('embeddings', {
      embed: async ({ texts }: { texts: readonly string[] }) => {
        embeddings.batches.push([...texts])
        await embeddings.onEmbed?.()
        const vectors: Array<readonly number[]> = []
        for (const text of texts) {
          const vector = embeddings.vectors.get(text)
          if (vector !== undefined) vectors.push(vector)
        }
        return { vectors }
      },
    })
  }
  const fiber = await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 4096 })
  return { fiber, store: ctx.evolutionMemory }
}

function scope(name = 'ws-1'): ScopeId {
  return EvolutionScopeId('test', name)
}

/** One artifact candidate with the fields these tests vary pinned. */
function storeCandidate(statement: string, overrides: Partial<LessonArtifactInput> = {}): LessonArtifactInput {
  return {
    statement, source: 's1', conditions: '', evidence: 'fact', confidence: 0.9, scope: 'project',
    sourceRefs: ['session:s1'], trajectoryRefs: ['run:s1'], lineage: { origin: 's1' }, ...overrides,
  }
}

/** One unit vector per text, on the axis the cosine decides with. */
function vectorsOf(entries: ReadonlyArray<readonly [string, number]>): Map<string, readonly number[]> {
  return new Map(entries.map(([text, score]) => [text, [score, Math.sqrt(Math.max(0, 1 - score * score))]]))
}

describe('evolution-memory addArtifact merging', () => {
  it('folds a paraphrase into the artifact it resembles and keeps that identity', async () => {
    const embeddings: FakeEmbeddings = { batches: [], vectors: vectorsOf([['use postgres 15', 1], ['use postgres', 0.93]]) }
    const { fiber, store } = await harness(embeddings)
    const id = scope()
    const first = await store.addArtifact(id, storeCandidate('use postgres', { conditions: 'database work' }))
    const createdAt = first.agentLessons[0]?.createdAt as string
    const record = await store.addArtifact(id, storeCandidate('use postgres 15', { conditions: 'rechecked' }), 'overwrite')
    expect(embeddings.batches).toEqual([['use postgres 15', 'use postgres']])
    expect(record.agentLessons).toHaveLength(1)
    expect(record.agentLessons[0]).toMatchObject({
      id: 'use postgres', statement: 'use postgres', conditions: 'rechecked', createdAt, validationCount: 0,
    })
    expect(record.agentLessons[0]?.id).toBe(artifactKey(record.agentLessons[0]?.statement ?? ''))
    await fiber.dispose()
  })

  it('folds into the closest artifact when several clear the floor', async () => {
    const embeddings: FakeEmbeddings = {
      batches: [],
      vectors: vectorsOf([['answer briefly', 1], ['prefers short answers', 0.9], ['prefers brief replies', 0.99]]),
    }
    const { fiber, store } = await harness(embeddings)
    const id = scope()
    await store.addArtifact(id, storeCandidate('prefers short answers', { conditions: 'one' }))
    await store.addArtifact(id, storeCandidate('prefers brief replies', { conditions: 'two' }))
    const record = await store.addArtifact(id, storeCandidate('answer briefly', { conditions: 'three' }), 'merge')
    expect(record.agentLessons).toHaveLength(2)
    expect(record.agentLessons[0]).toMatchObject({ statement: 'prefers short answers', conditions: 'one' })
    expect(record.agentLessons[1]).toMatchObject({ statement: 'prefers brief replies', conditions: 'two; three' })
    await fiber.dispose()
  })

  it('stores a separate artifact under keep_both even when the similarity clears the floor', async () => {
    const embeddings: FakeEmbeddings = { batches: [], vectors: vectorsOf([['use postgres 15', 1], ['use postgres', 0.93]]) }
    const { fiber, store } = await harness(embeddings)
    const id = scope()
    await store.addArtifact(id, storeCandidate('use postgres'))
    const record = await store.addArtifact(id, storeCandidate('use postgres 15'))
    expect(record.agentLessons.map(entry => entry.statement)).toEqual(['use postgres', 'use postgres 15'])
    expect(embeddings.batches).toEqual([])
    await fiber.dispose()
  })

  it('matches identity only when no embeddings service is mounted', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, storeCandidate('use postgres'))
    const appended = await store.addArtifact(id, storeCandidate('use postgres 15'), 'merge')
    expect(appended.agentLessons.map(entry => entry.statement)).toEqual(['use postgres', 'use postgres 15'])
    // The fallback is identity-only rather than off: an exact identity still folds in.
    const folded = await store.addArtifact(id, storeCandidate('use postgres', { conditions: 'rechecked' }), 'merge')
    expect(folded.agentLessons).toHaveLength(2)
    expect(folded.agentLessons[0]).toMatchObject({ id: 'use postgres', statement: 'use postgres', conditions: 'rechecked' })
    await fiber.dispose()
  })

  it('stores a candidate apart when the embeddings service answers an incomplete batch', async () => {
    const empty: FakeEmbeddings = { batches: [], vectors: new Map() }
    const { fiber, store } = await harness(empty)
    const id = scope()
    await store.addArtifact(id, storeCandidate('use postgres'))
    const noQuery = await store.addArtifact(id, storeCandidate('use postgres 15'), 'overwrite')
    expect(noQuery.agentLessons.map(entry => entry.statement)).toEqual(['use postgres', 'use postgres 15'])
    await fiber.dispose()

    // The query vector arrived but the artifact's did not, so nothing scored.
    const partial: FakeEmbeddings = { batches: [], vectors: vectorsOf([['use postgres 15', 1]]) }
    const second = await harness(partial)
    await second.store.addArtifact(id, storeCandidate('use postgres'))
    const noVector = await second.store.addArtifact(id, storeCandidate('use postgres 15'), 'merge')
    expect(noVector.agentLessons.map(entry => entry.statement)).toEqual(['use postgres', 'use postgres 15'])
    await second.fiber.dispose()
  })

  it('folds a staged paraphrase in when the embeddings service is mounted', async () => {
    const embeddings: FakeEmbeddings = { batches: [], vectors: vectorsOf([['use postgres 15', 1], ['use postgres', 0.93]]) }
    const { fiber, store } = await harness(embeddings)
    const id = scope()
    await store.addArtifact(id, storeCandidate('use postgres', { conditions: 'database work' }))
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', originSessionId: 's1', gist: 'g',
      payload: artifactPayload({ candidate: storeCandidate('use postgres 15', { conditions: 'rechecked' }), strategy: 'merge' }),
    })
    await store.approveStaged(staged.id)
    const after = store.read(id)
    expect(after?.agentLessons).toHaveLength(1)
    expect(after?.agentLessons[0]).toMatchObject({ id: 'use postgres', conditions: 'database work; rechecked' })
    await fiber.dispose()
  })

  it('stores the candidate when the matched artifact is removed before the add lands', async () => {
    const embeddings: FakeEmbeddings = { batches: [], vectors: vectorsOf([['use postgres 15', 1], ['use postgres', 0.93]]) }
    const { fiber, store } = await harness(embeddings)
    const id = scope()
    await store.addArtifact(id, storeCandidate('use postgres', { conditions: 'database work' }))
    // The removal lands in the window between the store's pre-read and its
    // write, so the resolved target no longer exists by the time it is used.
    embeddings.onEmbed = async () => { await store.removeArtifact(id, 'use postgres') }
    const record = await store.addArtifact(id, storeCandidate('use postgres 15', { conditions: 'rechecked' }), 'merge')
    expect(record.agentLessons.map(entry => entry.statement)).toEqual(['use postgres 15'])
    expect(record.agentLessons[0]).toMatchObject({
      id: artifactKey('use postgres 15'), statement: 'use postgres 15', conditions: 'rechecked',
      validationCount: 0, createdAt: record.agentLessons[0]?.updatedAt,
    })
    expect(store.read(id)?.agentLessons).toEqual(record.agentLessons)
    await fiber.dispose()
  })

  it('merges from the record at write time, not from the snapshot the target came from', async () => {
    const embeddings: FakeEmbeddings = { batches: [], vectors: vectorsOf([['use postgres 15', 1], ['use postgres', 0.93]]) }
    const { fiber, store } = await harness(embeddings)
    const id = scope()
    const seeded = await store.addArtifact(id, storeCandidate('use postgres', { conditions: 'database work', confidence: 0.6 }))
    const createdAt = seeded.agentLessons[0]?.createdAt as string
    // The edit lands after the target was measured, before the add writes.
    embeddings.onEmbed = async () => {
      await store.updateArtifact(id, 'use postgres', { conditions: 'concurrent', confidence: 0.95 })
    }
    const record = await store.addArtifact(
      id,
      storeCandidate('use postgres 15', { conditions: 'rechecked', confidence: 0.9 }),
      'merge',
    )
    expect(record.agentLessons).toHaveLength(1)
    // The concurrent edit's conditions are the ones unioned, so a merge from
    // the stale snapshot ('database work; rechecked', 0.9) cannot pass.
    expect(record.agentLessons[0]).toMatchObject({
      id: 'use postgres', statement: 'use postgres', conditions: 'concurrent; rechecked', confidence: 0.95, createdAt,
    })
    expect(store.read(id)?.agentLessons).toEqual(record.agentLessons)
    await fiber.dispose()
  })
})
