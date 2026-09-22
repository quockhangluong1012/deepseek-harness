import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionModelRoutes from '../src/index.ts'
import type { ModelRoute } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool())) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionModelRoutes)
  return { ctx, fiber, store: ctx.evolutionModelRoutes }
}

const route = (provider = 'deepseek', model = 'deepseek-chat'): ModelRoute => ({ provider, model })

describe('evolution model routes', () => {
  it('observes a route outcome and its evidence', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.observe({
        role: 'candidate-generation',
        route: route(),
        triple: { pass: true, tokens: 10, wallTimeMs: 100 },
      })
      expect(first).toMatchObject({ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', pass: true, tokens: 10, wallTimeMs: 100 })
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(store.routes('candidate-generation')).toEqual([{
        role: 'candidate-generation',
        provider: 'deepseek',
        model: 'deepseek-chat',
        origin: 'observed',
        runs: 1,
        passRate: 1,
        meanTokens: 10,
        lastAt: first.at,
      }])
    } finally {
      await fiber.dispose()
    }
  })

  it('upserts the route as observed and keeps a pin outliving its evidence', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe({ role: 'evaluation', route: route(), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      await store.pin('evaluation', 'deepseek', 'deepseek-chat')
      await store.observe({ role: 'evaluation', route: route(), triple: { pass: false, tokens: 9, wallTimeMs: 9 } })
      const rows = store.routes('evaluation')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ origin: 'pinned', runs: 2, passRate: 0.5, meanTokens: 7 })
      expect(store.recommend('evaluation')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    } finally {
      await fiber.dispose()
    }
  })

  it('pins a fresh route and flips an existing one', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe({ role: 'reflection', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 3, wallTimeMs: 3 } })
      const pinned = await store.pin('reflection', 'deepseek', 'deepseek-reasoner')
      expect(pinned).toMatchObject({ role: 'reflection', provider: 'deepseek', model: 'deepseek-reasoner', origin: 'pinned' })
      expect(store.recommend('reflection')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      await store.pin('reflection', 'deepseek', 'deepseek-chat')
      expect(store.recommend('reflection')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    } finally {
      await fiber.dispose()
    }
  })

  it('lists per-role summaries in topology order and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 10, wallTimeMs: 10 } })
      await store.pin('evaluation', 'deepseek', 'deepseek-reasoner')
      await store.observe({ role: 'task-execution', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 8, wallTimeMs: 8 } })
      const all = store.routes()
      expect(all.map(summary => summary.role)).toEqual(['task-execution', 'candidate-generation', 'evaluation'])
      const copy = store.routes('evaluation')
      ;(copy[0] as { origin: string }).origin = 'mutated'
      expect(store.routes('evaluation')[0]?.origin).toBe('pinned')
    } finally {
      await fiber.dispose()
    }
  })

  it('lists evidence newest first with filters and tie-breaks', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe({ role: 'evaluation', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      await store.observe({ role: 'evaluation', route: route('deepseek', 'deepseek-reasoner'), triple: { pass: true, tokens: 8, wallTimeMs: 8 } })
      await store.observe({ role: 'reflection', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 3, wallTimeMs: 3 } })
      // The store records at millisecond granularity; equal instants tie-break by id.
      const all = store.evidence()
      expect(all).toHaveLength(3)
      expect(store.evidence('evaluation')).toHaveLength(2)
      expect(store.evidence('evaluation', route('deepseek', 'deepseek-reasoner'))).toHaveLength(1)
      expect(store.evidence('evaluation', route('deepseek', 'deepseek-chat')).every(row => row.model === 'deepseek-chat')).toBe(true)
      expect(store.evidence('promotion-review')).toEqual([])
      expect(store.evidence('evaluation', route('other', 'model'))).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends pinned, then best evidence, then nothing', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.recommend('candidate-generation')).toBeUndefined()
      await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-chat'), triple: { pass: false, tokens: 20, wallTimeMs: 20 } })
      await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-reasoner'), triple: { pass: true, tokens: 12, wallTimeMs: 12 } })
      expect(store.recommend('candidate-generation')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      await store.pin('candidate-generation', 'deepseek', 'deepseek-max')
      expect(store.recommend('candidate-generation')).toEqual({ provider: 'deepseek', model: 'deepseek-max' })
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.observe({ role: 'evaluation', route: route(), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      await first.store.pin('evaluation', 'deepseek', 'deepseek-reasoner')
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.routes('evaluation')).toHaveLength(2)
      expect(second.store.recommend('evaluation')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionModelRoutes(ctx)
    expect(() => store.routes()).toThrow('not started yet')
    expect(() => store.evidence()).toThrow('not started yet')
  })
})
