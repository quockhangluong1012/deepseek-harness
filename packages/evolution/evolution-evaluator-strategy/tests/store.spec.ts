import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionEvaluatorStrategy from '../src/index.ts'
import type { EvaluatorOutcome } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionEvaluatorStrategy, config ?? {})
  return { ctx, fiber, store: ctx.evolutionEvaluatorStrategy }
}

const outcome = (overrides: Partial<EvaluatorOutcome> = {}): EvaluatorOutcome => ({
  evaluator: 'scorer-v1',
  taskClass: 'writer',
  candidateModel: 'deepseek-chat',
  judgeModel: 'deepseek-reasoner',
  verdict: true,
  groundTruth: true,
  independent: true,
  ...overrides,
})

describe('evolution evaluator strategy', () => {
  it('observes a verdict pair as a strategy row with now as its instant', async () => {
    const { fiber, store } = await boot()
    try {
      const row = await store.observe(outcome())
      expect(row).toMatchObject({ evaluator: 'scorer-v1', taskClass: 'writer', samples: 1, independentSamples: 1, corroborations: 1 })
      expect(row.lastAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('upserts by evaluator and class, folding non-independent pairs into samples only', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe(outcome())
      const second = await store.observe(outcome({ verdict: false, groundTruth: false, independent: false }))
      expect(second).toMatchObject({ samples: 2, independentSamples: 1, corroborations: 1 })
      expect(store.strategies()).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists strategies in evaluator order, filters by class, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe(outcome({ evaluator: 'ensemble-v2' }))
      await store.observe(outcome({ evaluator: 'a-v0' }))
      await store.observe(outcome({ evaluator: 'scorer-v1', taskClass: 'reader' }))
      expect(store.strategies().map(row => row.evaluator)).toEqual(['a-v0', 'ensemble-v2', 'scorer-v1'])
      expect(store.strategies('reader').map(row => row.evaluator)).toEqual(['scorer-v1'])
      expect(store.strategies('ghost')).toEqual([])
      ;(store.strategies()[0] as { taskClass: string }).taskClass = 'mutated'
      expect(store.strategies()[0]?.taskClass).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('orders rows by evaluator then task class', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe(outcome({ evaluator: 'scorer-v1', taskClass: 'writer' }))
      await store.observe(outcome({ evaluator: 'scorer-v1', taskClass: 'reader' }))
      await store.observe(outcome({ evaluator: 'ensemble-v2', taskClass: 'writer' }))
      expect(store.strategies().map(row => `${row.evaluator}/${row.taskClass}`))
        .toEqual(['ensemble-v2/writer', 'scorer-v1/reader', 'scorer-v1/writer'])
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends the most corroborated evaluator once it has minimum samples', async () => {
    const { fiber, store } = await boot(undefined, { minimumSamples: 2 })
    try {
      expect(store.recommend('writer')).toBeUndefined()
      await store.observe(outcome({ evaluator: 'scorer-v1' }))
      expect(store.recommend('writer')).toBeUndefined()
      await store.observe(outcome({ evaluator: 'scorer-v1' }))
      expect(store.recommend('writer')?.evaluator).toBe('scorer-v1')
      // A non-independent pair contributes samples but not independent ones,
      // so it cannot push an otherwise unrecommendable evaluator over the bar.
      await store.observe(outcome({ evaluator: 'ensemble-v2', independent: false }))
      await store.observe(outcome({ evaluator: 'ensemble-v2', independent: false }))
      expect(store.recommend('writer')?.evaluator).toBe('scorer-v1')
      // A genuinely corroborated evaluator outranks by weight.
      await store.observe(outcome({ evaluator: 'ensemble-v2', verdict: false, groundTruth: false, independent: true }))
      await store.observe(outcome({ evaluator: 'ensemble-v2', verdict: true, groundTruth: true, independent: true }))
      expect(store.recommend('writer')?.evaluator).toBe('ensemble-v2')
    } finally {
      await fiber.dispose()
    }
  })

  it('records a same-model verdict as non-independent evidence', async () => {
    const { fiber, store } = await boot(undefined, { minimumSamples: 1 })
    try {
      await store.observe(outcome({ judgeModel: 'deepseek-chat' }))
      expect(store.strategies()[0]).toMatchObject({
        samples: 1,
        independentSamples: 0,
        corroborations: 0,
        selfJudgedSamples: 1,
      })
      // The verdict is recorded non-independent, so it cannot be recommended on.
      expect(store.recommend('writer')).toBeUndefined()
      expect(store.ranking('writer')[0]?.reason).toContain("judged by the candidate's own model")
    } finally {
      await fiber.dispose()
    }
  })

  it('names the route §28 puts on the final promotion review', async () => {
    const { ctx, fiber, store } = await boot(undefined, { minimumSamples: 1 })
    try {
      ctx.provide('evolutionModelRoutes', {
        recommend: (role: string) => (role === 'promotion-review' ? { provider: 'deepseek', model: 'deepseek-max' } : undefined),
      } as never)
      await store.observe(outcome())
      expect(store.recommend('writer')?.promotionReview).toEqual({ provider: 'deepseek', model: 'deepseek-max' })
      expect(store.ranking('writer')[0]?.promotionReview).toEqual({ provider: 'deepseek', model: 'deepseek-max' })
    } finally {
      await fiber.dispose()
    }
  })

  it('names no promotion-review route while the model-routes store is unmounted', async () => {
    const { fiber, store } = await boot(undefined, { minimumSamples: 1 })
    try {
      await store.observe(outcome())
      expect(store.recommend('writer')?.promotionReview).toBeNull()
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.observe(outcome())
      await first.store.observe(outcome({ verdict: false, groundTruth: false, independent: false }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.strategies()).toHaveLength(1)
      expect(second.store.strategies('writer')[0]).toMatchObject({ samples: 2, independentSamples: 1, corroborations: 1 })
      expect(second.store.recommend('writer')).toBeUndefined()
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionEvaluatorStrategy(ctx, { minimumSamples: 3 })
    expect(() => store.strategies()).toThrow('not started yet')
    expect(() => store.ranking('writer')).toThrow('not started yet')
    expect(() => store.recommend('writer')).toThrow('not started yet')
  })
})
