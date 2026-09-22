import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionBudget from '../src/index.ts'
import type { AllocationInput, PoolInput, SpendInput } from '../src/index.ts'

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

const pool = (overrides: Partial<PoolInput> = {}): PoolInput => ({
  batchId: 'b1',
  taskClass: 'writer',
  candidates: [{ candidateId: 'c1', runs: 2, passes: 2, novelty: 0 }],
  ...overrides,
})

const spend = (overrides: Partial<SpendInput> = {}): SpendInput => ({
  tokens: 5000,
  wallTimeMs: 60000,
  rollouts: 4,
  ...overrides,
})

describe('evolution budget', () => {
  it('allocates a batch with priced ceilings, every §37 dimension, and now as its instant', async () => {
    const { fiber, store } = await boot(undefined, { baseMaxTokens: 20000, baseMaxWallTimeMs: 600000 })
    try {
      const row = await store.allocate(allocate())
      expect(row).toMatchObject({
        batchId: 'b1',
        taskClass: 'writer',
        candidateClass: 'high-potential',
        maxTokens: 40000,
        maxWallTimeMs: 1200000,
        maxCost: 20,
        timeLimitMs: 172800000,
        parallelism: 8,
      })
      expect(row.reason).toContain('cost 20 units, deadline 172800000 ms, parallelism 8')
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
      expect(first).toMatchObject({
        tokens: 6000,
        wallTimeMs: 120000,
        remainingTokens: 4000,
        remainingWallTimeMs: 180000,
        exceededTokens: 0,
      })
      const second = await store.spend('b1', spend({ tokens: 5000, wallTimeMs: 210000 }))
      expect(second).toMatchObject({ tokens: 11000, wallTimeMs: 330000, exceededTokens: 1000, exceededWallTimeMs: 30000 })
      expect(store.spends()).toHaveLength(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('settles a spend against the priced cost, deadline, and parallelism ceilings', async () => {
    const { fiber, store } = await boot(undefined, { baseMaxCost: 10, baseTimeLimitMs: 3600000, baseParallelism: 4 })
    try {
      await store.allocate(allocate({ candidateClass: 'standard' }))
      const over = await store.spend('b1', spend({ cost: 12, parallelism: 5 }))
      expect(over.cost).toEqual({ budgeted: 10, spent: 12, remaining: 0, exceeded: 2 })
      expect(over.parallelism).toEqual({ budgeted: 4, spent: 5, remaining: 0, exceeded: 1 })
      expect(over.time.budgeted).toBe(3600000)
      expect(over.time.exceeded).toBe(0)
      expect(store.withinBudget('b1')).toBe(false)

      await store.allocate(allocate({ batchId: 'b2' }))
      const inside = await store.spend('b2', spend({ cost: 1, parallelism: 1 }))
      expect(inside.cost).toEqual({ budgeted: 20, spent: 1, remaining: 19, exceeded: 0 })
      expect(store.withinBudget('b2')).toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('records a candidate pool, upserting candidates and detaching copies', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.recordPool(pool({
        candidates: [
          { candidateId: 'c2', runs: 1, passes: 0, novelty: 0.2 },
          { candidateId: 'c1', runs: 1, passes: 1, novelty: 0 },
        ],
      }))
      expect(first.map(row => row.candidateId)).toEqual(['c1', 'c2'])
      expect(first[0]).toMatchObject({ batchId: 'b1', taskClass: 'writer', runs: 1, passes: 1, novelty: 0 })
      expect(first[0]?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      // A re-recorded candidate replaces its evidence and leaves its sibling alone.
      const second = await store.recordPool(pool({ candidates: [{ candidateId: 'c1', runs: 3, passes: 1, novelty: 0.5 }] }))
      expect(second).toHaveLength(2)
      expect(second[0]).toMatchObject({ candidateId: 'c1', runs: 3, passes: 1 })
      expect(second[1]).toMatchObject({ candidateId: 'c2', passes: 0 })
      ;(store.pool('b1')[0] as { passes: number }).passes = 99
      expect(store.pool('b1')[0]?.passes).toBe(1)
      expect(store.pool('ghost')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('prices a pooled candidate through the policy branch its evidence reached', async () => {
    const { fiber, store } = await boot()
    try {
      await store.recordPool(pool({
        candidates: [
          { candidateId: 'proven', runs: 2, passes: 2, novelty: 0 },
          { candidateId: 'failed', runs: 2, passes: 0, novelty: 0.1 },
          { candidateId: 'novel', runs: 0, passes: 0, novelty: 0.9 },
          { candidateId: 'plain', runs: 0, passes: 0, novelty: 0.1 },
        ],
      }))
      const proven = await store.allocateForCandidate('b1', 'proven')
      expect(proven.candidateClass).toBe('high-potential')
      expect(proven.reason).toContain('branch more-budget: 2 passes of 2 recorded runs')
      expect(proven).toMatchObject({ taskClass: 'writer', maxTokens: 40000 })

      const failed = await store.allocateForCandidate('b1', 'failed')
      expect(failed.candidateClass).toBe('low-potential')
      expect(failed.reason).toContain('branch early-stop')
      expect(failed).toMatchObject({ maxTokens: 10000, maxCost: 5 })

      const novel = await store.allocateForCandidate('b1', 'novel')
      expect(novel.candidateClass).toBe('novel')
      expect(novel.reason).toContain('branch exploration-budget')

      expect((await store.allocateForCandidate('b1', 'plain')).candidateClass).toBe('standard')
      await expect(store.allocateForCandidate('b1', 'ghost')).rejects.toThrow("recorded no pool candidate 'ghost'")
    } finally {
      await fiber.dispose()
    }
  })

  it('decides the priced class by the configured policy bars', async () => {
    const { fiber, store } = await boot(undefined, { noveltyThreshold: 0.9, provenPasses: 2 })
    try {
      await store.recordPool(pool({
        candidates: [
          { candidateId: 'nearly-proven', runs: 1, passes: 1, novelty: 0 },
          { candidateId: 'novel', runs: 0, passes: 0, novelty: 0.5 },
        ],
      }))
      expect((await store.allocateForCandidate('b1', 'nearly-proven')).candidateClass).toBe('low-potential')
      expect((await store.allocateForCandidate('b1', 'novel')).candidateClass).toBe('standard')
    } finally {
      await fiber.dispose()
    }
  })

  it('derives the screening schedule from the recorded pool', async () => {
    const { fiber, store } = await boot(undefined, { keepFraction: 0.5, screeningRounds: 2 })
    try {
      expect(store.schedule('ghost')).toBeUndefined()
      await store.recordPool(pool({
        candidates: Array.from({ length: 10 }, (_, index) => ({ candidateId: `c${index}`, runs: 0, passes: 0, novelty: 0 })),
      }))
      expect(store.schedule('b1')).toEqual({
        entered: 10,
        rounds: [
          { round: 1, evaluateCount: 10, keepCount: 5 },
          { round: 2, evaluateCount: 5, keepCount: 2 },
        ],
        finalists: 2,
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('reads the §27 objectives a batch recorded', async () => {
    const { fiber, store } = await boot()
    try {
      expect(() => store.objectives('ghost')).toThrow("unknown batch 'ghost'")
      await store.allocate(allocate({ candidateClass: 'standard' }))
      await store.recordPool(pool({
        candidates: [
          { candidateId: 'c1', runs: 2, passes: 2, novelty: 0 },
          { candidateId: 'c2', runs: 2, passes: 0, novelty: 0 },
        ],
      }))
      await store.spend('b1', spend({ tokens: 800, wallTimeMs: 4000, rollouts: 4, backgroundTokens: 200 }))
      const readings = store.objectives('b1')
      expect(readings.map(row => row.objective)).toEqual([
        'quality',
        'reliability',
        'latency',
        'cost',
        'memory-footprint',
        'context-usage',
        'background-compute',
      ])
      expect(readings[0]?.value).toBe(0.5)
      expect(readings[1]?.value).toBe(0.5)
      expect(readings[2]?.value).toBe(1000)
      expect(readings[3]?.value).toBe(800)
      expect(readings[4]?.value).toBeNull()
      expect(readings[5]?.value).toBeNull()
      expect(readings[6]?.value).toBe(200)
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
      expect(store.withinBudget('b1')).toBe(true)
      await store.spend('b1', spend({ tokens: 20000 }))
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
      await first.store.recordPool(pool())
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.batches()).toHaveLength(1)
      expect(second.store.batches('writer')[0]).toMatchObject({ batchId: 'b1', candidateClass: 'high-potential' })
      expect(second.store.spends('b1')).toHaveLength(1)
      expect(second.store.batches('writer')[0]?.maxTokens).toBe(40000)
      expect(second.store.pool('b1')).toHaveLength(1)
      expect(second.store.schedule('b1')?.entered).toBe(1)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', async () => {
    const ctx = new Context()
    const store = new EvolutionBudget(ctx, { baseMaxTokens: 20000, baseMaxWallTimeMs: 600000 })
    expect(() => store.batches()).toThrow('not started yet')
    expect(() => store.spends()).toThrow('not started yet')
    expect(() => store.withinBudget('b1')).toThrow('not started yet')
    expect(() => store.pool('b1')).toThrow('not started yet')
    expect(() => store.schedule('b1')).toThrow('not started yet')
    expect(() => store.objectives('b1')).toThrow('not started yet')
    await expect(store.allocateForCandidate('b1', 'c1')).rejects.toThrow('not started yet')
  })
})
