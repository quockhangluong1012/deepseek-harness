import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionNovelty from '../src/index.ts'
import type { NoveltyArchiveInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool())) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionNovelty)
  return { ctx, fiber, store: ctx.evolutionNovelty }
}

const record = (overrides: Partial<NoveltyArchiveInput> = {}): NoveltyArchiveInput => ({
  candidateId: 'c1',
  skill: 'writer',
  features: ['do the thing', 'keep it short'],
  ...overrides,
})

describe('evolution novelty search', () => {
  it('records a seed descriptor with full novelty', async () => {
    const { fiber, store } = await boot()
    try {
      const stored = await store.record(record())
      expect(stored).toMatchObject({
        candidateId: 'c1',
        skill: 'writer',
        features: ['do the thing', 'keep it short'],
        novelty: 1,
      })
      expect(stored.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('measures novelty against the skill archive, excluding itself', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(record({ candidateId: 'a' }))
      // Re-recording the same candidate keeps its seed novelty: the archive
      // excludes the entry itself when measuring.
      const again = await store.record(record({ candidateId: 'a' }))
      expect(again.novelty).toBe(1)
      const overlapping = await store.record(record({ candidateId: 'b', features: ['do the thing', 'new rule'] }))
      expect(overlapping.novelty).toBeCloseTo(2 / 3)
      const verbatim = await store.record(record({ candidateId: 'c', features: ['do the thing', 'keep it short'] }))
      expect(verbatim.novelty).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('isolates skills from each other', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(record({ candidateId: 'a' }))
      // An identical descriptor in another skill is a seed there.
      const other = await store.record(record({ skill: 'reader', candidateId: 'r1' }))
      expect(other.novelty).toBe(1)
      expect(store.entries('reader')).toHaveLength(1)
      expect(store.entries()).toHaveLength(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists entries newest first, filters by skill, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(record({ candidateId: 'a' }))
      await store.record(record({ candidateId: 'r1', skill: 'reader' }))
      await store.record(record({ candidateId: 'b' }))
      const writer = store.entries('writer')
      // Timestamps may share one millisecond, so the order is only stable as
      // a set: candidate-id tie-break when equal, `at` when not.
      expect(writer.map(entry => entry.candidateId).sort()).toEqual(['a', 'b'])
      expect(writer).toHaveLength(2)
      expect(store.entries()).toHaveLength(3)
      ;(writer[0] as { skill: string }).skill = 'mutated'
      expect(store.entries('writer')[0]?.skill).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('reports the mean archive novelty of a skill', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.mean('writer')).toBe(0)
      await store.record(record({ candidateId: 'a' }))
      await store.record(record({ candidateId: 'b', features: ['do the thing', 'new rule'] }))
      expect(store.mean('writer')).toBeCloseTo((1 + 2 / 3) / 2)
      expect(store.mean('reader')).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.record(record({ candidateId: 'c1' }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.entries()).toHaveLength(1)
      expect(second.store.entries('writer')[0]?.novelty).toBe(1)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionNovelty(ctx)
    expect(() => store.entries()).toThrow('not started yet')
  })
})
