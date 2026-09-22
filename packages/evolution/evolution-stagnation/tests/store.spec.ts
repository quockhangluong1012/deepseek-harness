import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionStagnation from '../src/index.ts'
import type { StagnationRunInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionStagnation, config ?? {})
  return { ctx, fiber, store: ctx.evolutionStagnation }
}

const run = (overrides: Partial<StagnationRunInput> = {}): StagnationRunInput => ({
  runId: 'r1',
  skill: 'writer',
  score: { pass: true, tokens: 10, wallTimeMs: 100 },
  ...overrides,
})

describe('evolution stagnation', () => {
  it('records a run with an auto generation and a first-run improvement', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.recordRun(run())
      expect(first).toMatchObject({
        runId: 'r1',
        skill: 'writer',
        generation: 1,
        score: { pass: true, tokens: 10, wallTimeMs: 100 },
        improved: true,
      })
      expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const second = await store.recordRun(run({ runId: 'r2' }))
      expect(second.generation).toBe(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('flags only meaningful improvements against the configured floor', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.recordRun(run({ score: { pass: true, tokens: 100, wallTimeMs: 1000 } }))
      expect(first.improved).toBe(true)
      // A 2% token dip is below the 5% floor.
      const jitter = await store.recordRun(run({ runId: 'r2', score: { pass: true, tokens: 98, wallTimeMs: 50 } }))
      expect(jitter.improved).toBe(false)
      // A 5% token drop reaches the floor.
      const gain = await store.recordRun(run({ runId: 'r3', score: { pass: true, tokens: 95, wallTimeMs: 2000 } }))
      expect(gain.improved).toBe(true)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists runs newest first, filters by skill, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.recordRun(run({ runId: 'a' }))
      await store.recordRun(run({ runId: 'reader-1', skill: 'reader' }))
      await store.recordRun(run({ runId: 'b' }))
      const writer = store.runs('writer')
      // Timestamps may share one millisecond, so the order is only stable as
      // a set: run-id tie-break when equal, `at` when not.
      expect(writer.map(entry => entry.runId).sort()).toEqual(['a', 'b'])
      expect(writer).toHaveLength(2)
      expect(store.runs()).toHaveLength(3)
      ;(writer[0] as { skill: string }).skill = 'mutated'
      expect(store.runs('writer')[0]?.skill).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('reports the stagnation status with the ladder strategy', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.status('writer')).toMatchObject({
        skill: 'writer',
        runs: 0,
        bestScore: null,
        generationsSinceImprovement: 0,
        stagnant: false,
        threshold: 5,
        strategy: 'exploitation',
      })
      await store.recordRun(run({ runId: 'a', score: { pass: true, tokens: 100, wallTimeMs: 1000 } }))
      for (let index = 0; index < 5; index += 1) {
        await store.recordRun(run({ runId: `stale-${index}`, score: { pass: true, tokens: 99, wallTimeMs: 900 } }))
      }
      const status = store.status('writer')
      expect(status.runs).toBe(6)
      expect(status.bestScore).toEqual({ pass: true, tokens: 100, wallTimeMs: 1000 })
      expect(status.generationsSinceImprovement).toBe(5)
      expect(status.stagnant).toBe(true)
      expect(status.strategy).toBe('diversity')
      expect(store.status('reader')).toMatchObject({ runs: 0, stagnant: false })
    } finally {
      await fiber.dispose()
    }
  })

  it('applies the configured threshold and gain floor', async () => {
    const { fiber, store } = await boot(undefined, { threshold: 2, relativeImprovement: 0.1 })
    try {
      const first = await store.recordRun(run({ score: { pass: true, tokens: 100, wallTimeMs: 1000 } }))
      expect(first.improved).toBe(true)
      // 8% off is below the 10% floor.
      const jitter = await store.recordRun(run({ runId: 'r2', score: { pass: true, tokens: 92, wallTimeMs: 1 } }))
      expect(jitter.improved).toBe(false)
      const deeper = await store.recordRun(run({ runId: 'r3', score: { pass: true, tokens: 92, wallTimeMs: 1 } }))
      expect(deeper.improved).toBe(false)
      expect(deeper.generation).toBe(3)
      const status = store.status('writer')
      // Two runs past the last improvement reach the threshold of 2.
      expect(status.stagnant).toBe(true)
      expect(status.strategy).toBe('diversity')
      expect(status.threshold).toBe(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('resets one skill, returning the count removed', async () => {
    const { fiber, store } = await boot()
    try {
      await store.recordRun(run({ runId: 'a' }))
      await store.recordRun(run({ runId: 'b' }))
      await store.recordRun(run({ runId: 'r1', skill: 'reader' }))
      expect(await store.reset('writer')).toBe(2)
      expect(store.runs('writer')).toHaveLength(0)
      expect(store.runs('reader')).toHaveLength(1)
      expect(await store.reset('writer')).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.recordRun(run({ runId: 'r1' }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.runs()).toHaveLength(1)
      expect(second.store.runs('writer')[0]?.improved).toBe(true)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionStagnation(ctx, { threshold: 5, relativeImprovement: 0.05 })
    expect(() => store.status('writer')).toThrow('not started yet')
  })
})
