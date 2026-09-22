import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMeta from '../src/index.ts'
import type { EngineRunInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionMeta, config ?? {})
  return { ctx, fiber, store: ctx.evolutionMeta }
}

const input = (overrides: Partial<EngineRunInput> = {}): EngineRunInput => ({
  runId: 'r1',
  taskClass: 'writer',
  config: {
    operators: 'portfolio-v1',
    evaluator: 'scorer-v1',
    budget: 'balanced-v1',
    routing: 'evidence-v1',
  },
  pass: true,
  tokens: 5000,
  wallTimeMs: 60000,
  ...overrides,
})

describe('evolution meta', () => {
  it('records an engine run with now as its instant', async () => {
    const { fiber, store } = await boot()
    try {
      const run = await store.record(input())
      expect(run).toMatchObject({ runId: 'r1', taskClass: 'writer', pass: true, tokens: 5000, wallTimeMs: 60000 })
      expect(run.config).toMatchObject({ operators: 'portfolio-v1', evaluator: 'scorer-v1', budget: 'balanced-v1', routing: 'evidence-v1' })
      expect(run.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('completes a partial configuration with the default choices', async () => {
    const { fiber, store } = await boot()
    try {
      const run = await store.record(input({ config: { operators: 'portfolio-v2' } }))
      expect(run.config).toMatchObject({ operators: 'portfolio-v2', evaluator: 'scorer-v1', budget: 'balanced-v1', routing: 'evidence-v1' })
    } finally {
      await fiber.dispose()
    }
  })

  it('lists runs newest first and filters by task class', async () => {
    const { fiber, store } = await boot()
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
      try {
        await store.record(input())
      } finally {
        vi.useRealTimers()
      }
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.record(input({ runId: 'r2' }))
      await store.record(input({ runId: 'r3', taskClass: 'reader' }))
      expect(store.runs().map(row => row.runId)).toEqual(['r3', 'r2', 'r1'])
      expect(store.runs('writer').map(row => row.runId)).toEqual(['r2', 'r1'])
      expect(store.runs('ghost')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('derives summaries grouped by task class and configuration', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(input())
      await store.record(input({ runId: 'r2', pass: false, tokens: 15000 }))
      await store.record(input({ runId: 'r3', config: { operators: 'portfolio-v2' } }))
      await store.record(input({ runId: 'r4', taskClass: 'reader' }))
      const all = store.summaries()
      expect(all).toHaveLength(3)
      const writerDefault = all[0]
      expect(writerDefault).toMatchObject({ taskClass: 'writer', samples: 2, passes: 1, passRate: 0.5, meanTokens: 10000 })
      expect(store.summaries('writer')).toHaveLength(2)
      ;(store.summaries()[0] as { taskClass: string }).taskClass = 'mutated'
      expect(store.summaries()[0]?.taskClass).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends the best-scored configuration once it has minimum runs', async () => {
    const { fiber, store } = await boot(undefined, { minimumSamples: 2 })
    try {
      expect(store.recommend('writer')).toBeUndefined()
      await store.record(input())
      expect(store.recommend('writer')).toBeUndefined()
      await store.record(input({ runId: 'r2' }))
      const recommended = store.recommend('writer')
      expect(recommended?.configId).toBe('portfolio-v1\0scorer-v1\0balanced-v1\0evidence-v1')
      expect(recommended?.samples).toBe(2)
      expect(recommended?.reason).toContain('2/2 passed')
      expect(store.recommend('ghost')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.record(input())
      await first.store.record(input({ runId: 'r2', pass: false }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.runs()).toHaveLength(2)
      expect(second.store.summaries('writer')[0]).toMatchObject({ samples: 2, passes: 1 })
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionMeta(ctx, { minimumSamples: 3, defaultConfig: { operators: 'portfolio-v1', evaluator: 'scorer-v1', budget: 'balanced-v1', routing: 'evidence-v1' } })
    expect(() => store.runs()).toThrow('not started yet')
    expect(() => store.summaries()).toThrow('not started yet')
    expect(() => store.recommend('writer')).toThrow('not started yet')
  })
})