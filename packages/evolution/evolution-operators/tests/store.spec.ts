import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionOperators from '../src/index.ts'
import type { OperatorOutcome } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionOperators, config ?? {})
  return { ctx, fiber, store: ctx.evolutionOperators }
}

const outcome = (overrides: Partial<OperatorOutcome> = {}): OperatorOutcome => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  delta: 1,
  ...overrides,
})

describe('evolution operators', () => {
  it('records an outcome as a stats row with now as its instant', async () => {
    const { fiber, store } = await boot()
    try {
      const row = await store.record(outcome())
      expect(row).toMatchObject({ operator: 'rewrite', artifactClass: 'writer', attempts: 1, accepted: 1, meanDelta: 1, regressionRate: 0 })
      expect(row.lastAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('upserts by operator and class, advancing attempts', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(outcome())
      const second = await store.record(outcome({ accepted: false, delta: -1 }))
      expect(second).toMatchObject({ attempts: 2, accepted: 1, meanDelta: 0 })
      expect(store.stats()).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists stats in canonical operator order, filters by class, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(outcome({ operator: 'change-tool' }))
      await store.record(outcome({ operator: 'add-step' }))
      await store.record(outcome({ operator: 'rewrite', artifactClass: 'reader' }))
      expect(store.stats().map(row => row.operator)).toEqual(['add-step', 'change-tool', 'rewrite'])
      expect(store.stats('reader').map(row => row.operator)).toEqual(['rewrite'])
      expect(store.stats('ghost')).toEqual([])
      ;(store.stats()[0] as { artifactClass: string }).artifactClass = 'mutated'
      expect(store.stats()[0]?.artifactClass).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('ranks all canonical operators for a class and recommends the leader', async () => {
    const { fiber, store } = await boot(undefined, { exploration: 0.2 })
    try {
      const empty = store.ranking('writer')
      expect(empty).toHaveLength(8)
      expect(store.recommend('writer')?.operator).toBe('rewrite')
      await store.record(outcome({ operator: 'merge-candidates', accepted: true, delta: 1 }))
      await store.record(outcome({ operator: 'merge-candidates', accepted: true, delta: 1 }))
      await store.record(outcome({ operator: 'merge-candidates', accepted: true, delta: 1 }))
      const ranked = store.ranking('writer')
      expect(ranked[0]?.operator).toBe('merge-candidates')
      expect(store.recommend('writer')?.operator).toBe('merge-candidates')
      // A different class still ranks the canonical first operator.
      expect(store.recommend('ghost')?.operator).toBe('rewrite')
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.record(outcome())
      await first.store.record(outcome({ accepted: false, delta: -1 }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.stats()).toHaveLength(1)
      expect(second.store.stats('writer')[0]).toMatchObject({ attempts: 2, accepted: 1 })
      expect(second.store.recommend('writer')?.operator).toBe('rewrite')
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionOperators(ctx, { exploration: 0.2 })
    expect(() => store.stats()).toThrow('not started yet')
    expect(() => store.ranking('writer')).toThrow('not started yet')
    expect(() => store.recommend('writer')).toThrow('not started yet')
  })
})