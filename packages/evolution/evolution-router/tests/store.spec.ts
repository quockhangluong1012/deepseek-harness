import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionRouter from '../src/index.ts'
import type { RouteOutcome } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionRouter, config ?? {})
  return { ctx, fiber, store: ctx.evolutionRouter }
}

const outcome = (overrides: Partial<RouteOutcome> = {}): RouteOutcome => ({
  taskClass: 'writer',
  role: 'evaluation',
  provider: 'deepseek',
  model: 'chat',
  pass: true,
  tokens: 1000,
  wallTimeMs: 2000,
  ...overrides,
})

describe('evolution router', () => {
  it('observes a route outcome with now as its instant', async () => {
    const { fiber, store } = await boot()
    try {
      const row = await store.observe(outcome())
      expect(row).toMatchObject({ taskClass: 'writer', role: 'evaluation', provider: 'deepseek', model: 'chat', pass: true, tokens: 1000, wallTimeMs: 2000 })
      expect(row.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('accumulates outcomes as events, listing newest first', async () => {
    const { fiber, store } = await boot()
    try {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
      try {
        await store.observe(outcome())
      } finally {
        vi.useRealTimers()
      }
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.observe(outcome({ pass: false }))
      expect(store.outcomes()).toHaveLength(2)
      expect(store.outcomes()[0]?.pass).toBe(false)
      expect(store.outcomes('ghost')).toEqual([])
      expect(store.outcomes('writer', 'evaluation')).toHaveLength(2)
      expect(store.outcomes('writer', 'reflection')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('derives grouped effectiveness with running means', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe(outcome())
      await store.observe(outcome({ pass: false, tokens: 3000, wallTimeMs: 6000 }))
      await store.observe(outcome({ taskClass: 'reader', provider: 'openai', model: 'gpt' }))
      await store.observe(outcome({ role: 'reflection' }))
      const rows = store.effectiveness()
      expect(rows).toHaveLength(3)
      const evaluation = rows.find(row => row.taskClass === 'writer' && row.role === 'evaluation')
      expect(evaluation).toMatchObject({ samples: 2, passes: 1, passRate: 0.5, meanTokens: 2000, meanWallTimeMs: 4000 })
      expect(store.effectiveness('writer')).toHaveLength(2)
      expect(store.effectiveness('writer', 'reflection')).toHaveLength(1)
      ;(store.effectiveness()[0] as { model: string }).model = 'mutated'
      expect(store.effectiveness()[0]?.model).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends the best route once it has minimum outcomes', async () => {
    const { fiber, store } = await boot(undefined, { minimumSamples: 2 })
    try {
      expect(store.recommend('writer', 'evaluation')).toBeUndefined()
      await store.observe(outcome())
      expect(store.recommend('writer', 'evaluation')).toBeUndefined()
      await store.observe(outcome())
      const recommended = store.recommend('writer', 'evaluation')
      expect(recommended).toMatchObject({ provider: 'deepseek', model: 'chat', samples: 2, passRate: 1 })
      expect(recommended?.reason).toContain('2/2 passed')
      // A second route with fewer outcomes cannot displace the leader.
      await store.observe(outcome({ provider: 'openai', model: 'gpt' }))
      expect(store.recommend('writer', 'evaluation')?.provider).toBe('deepseek')
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.observe(outcome())
      await first.store.observe(outcome({ pass: false, tokens: 3000, wallTimeMs: 6000 }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.outcomes()).toHaveLength(2)
      expect(second.store.effectiveness('writer', 'evaluation')[0]).toMatchObject({ samples: 2, passes: 1, meanTokens: 2000 })
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionRouter(ctx, { minimumSamples: 3 })
    expect(() => store.outcomes()).toThrow('not started yet')
    expect(() => store.effectiveness()).toThrow('not started yet')
    expect(() => store.recommend('writer', 'evaluation')).toThrow('not started yet')
  })
})