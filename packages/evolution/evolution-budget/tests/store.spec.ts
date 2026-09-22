import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionBudget from '../src/index.ts'
import type { AllocationInput, SpendInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionBudget, config ?? {})
  return { ctx, fiber, store: ctx.evolutionBudget }
}

const allocate = (overrides: Partial<AllocationInput> = {}): AllocationInput => ({
  batchId: 'b1',
  taskClass: 'writer',
  candidateClass: 'high-potential',
  ...overrides,
})

const spend = (overrides: Partial<SpendInput> = {}): SpendInput => ({
  tokens: 5000,
  wallTimeMs: 60000,
  rollouts: 4,
  ...overrides,
})

describe('evolution budget', () => {
  it('allocates a batch with priced ceilings and now as its instant', async () => {
    const { fiber, store } = await boot(undefined, { baseMaxTokens: 20000, baseMaxWallTimeMs: 600000 })
    try {
      const row = await store.allocate(allocate())
      expect(row).toMatchObject({ batchId: 'b1', taskClass: 'writer', candidateClass: 'high-potential', maxTokens: 40000, maxWallTimeMs: 1200000 })
      expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('upserts the allocation by batch identity', async () => {
    const { fiber, store } = await boot()
    try {
      await store.allocate(allocate())
      const second = await store.allocate(allocate({ candidateClass: 'low-potential' }))
      expect(second.candidateClass).toBe('low-potential')
      expect(store.batches()).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('spends against the allocation and settles the cumulative spend', async () => {
    const { fiber, store } = await boot(undefined, { baseMaxTokens: 20000, baseMaxWallTimeMs: 600000 })
    try {
      await expect(store.spend('ghost', spend())).rejects.toThrow("unknown batch 'ghost'")
      await store.allocate(allocate({ candidateClass: 'low-potential' }))
      const first = await store.spend('b1', spend({ tokens: 6000, wallTimeMs: 120000 }))
      expect(first).toMatchObject({ tokens: 6000, wallTimeMs: 120000, remainingTokens: 4000, remainingWallTimeMs: 180000, exceededTokens: 0 })
      const second = await store.spend('b1', spend({ tokens: 5000, wallTimeMs: 90000 }))
      expect(second).toMatchObject({ tokens: 11000, wallTimeMs: 210000, exceededTokens: 1000, exceededWallTimeMs: 30000 })
      expect(store.spends()).toHaveLength(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists allocations by task class and spends by batch, detaching copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.allocate(allocate({ batchId: 'b-b' }))
      await store.allocate(allocate({ batchId: 'a-a' }))
      await store.allocate(allocate({ batchId: 'c-c', taskClass: 'reader' }))
      expect(store.batches().map(row => row.batchId)).toEqual(['a-a', 'b-b', 'c-c'])
      expect(store.batches('reader').map(row => row.batchId)).toEqual(['c-c'])
      expect(store.batches('ghost')).toEqual([])
      await store.allocate(allocate({ batchId: 'reads' }))
      await store.spend('reads', spend())
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.spend('reads', spend({ tokens: 1 }))
      expect(store.spends('reads')).toHaveLength(2)
      expect(store.spends('ghost')).toEqual([])
      ;(store.batches()[0] as { taskClass: string }).taskClass = 'mutated'
      expect(store.batches()[0]?.taskClass).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('reports within budget across the cumulative spend', async () => {
    const { fiber, store } = await boot(undefined, { baseMaxTokens: 20000, baseMaxWallTimeMs: 600000 })
    try {
      expect(store.withinBudget('ghost')).toBe(false)
      await store.allocate(allocate())
      await store.spend('b1', spend({ tokens: 30000, wallTimeMs: 60000 }))
      expect(store.withinBudget('b1')).toBe(false)
      await store.spend('b1', spend())
      expect(store.withinBudget('b1')).toBe(false)
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.allocate(allocate())
      await first.store.spend('b1', spend())
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.batches()).toHaveLength(1)
      expect(second.store.batches('writer')[0]).toMatchObject({ batchId: 'b1', candidateClass: 'high-potential' })
      expect(second.store.spends('b1')).toHaveLength(1)
      expect(second.store.batches('writer')[0]?.maxTokens).toBe(40000)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionBudget(ctx, { baseMaxTokens: 20000, baseMaxWallTimeMs: 600000 })
    expect(() => store.batches()).toThrow('not started yet')
    expect(() => store.spends()).toThrow('not started yet')
    expect(() => store.withinBudget('b1')).toThrow('not started yet')
  })
})