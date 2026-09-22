import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionSleeptime from '../src/index.ts'
import type { AnticipationInput, PrecomputeInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionSleeptime, config ?? {})
  return { ctx, fiber, store: ctx.evolutionSleeptime }
}

const anticipate = (overrides: Partial<AnticipationInput> = {}): AnticipationInput => ({
  taskId: 't1',
  domain: 'writer',
  likelihood: 0.5,
  expectedQueries: 10,
  expectedSavingTokens: 100,
  ...overrides,
})

const precompute = (overrides: Partial<PrecomputeInput> = {}): PrecomputeInput => ({
  artifactId: 'a1',
  taskId: 't1',
  kind: 'summary',
  summary: 'outline',
  offlineCostTokens: 200,
  ...overrides,
})

describe('evolution sleeptime', () => {
  it('anticipates a task with now as its instant and upserts by task id', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.anticipate(anticipate({ scope: 'outline' }))
      expect(first).toMatchObject({
        taskId: 't1',
        domain: 'writer',
        scope: 'outline',
        likelihood: 0.5,
        expectedQueries: 10,
        expectedSavingTokens: 100,
      })
      expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const second = await store.anticipate(anticipate({ likelihood: 0.9 }))
      expect(second.likelihood).toBe(0.9)
      expect(second.scope).toBeUndefined()
      expect(store.tasks()).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists tasks likeliest first, filters by domain, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.anticipate(anticipate({ taskId: 'low', likelihood: 0.2 }))
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.anticipate(anticipate({ taskId: 'b-tie', likelihood: 0.8, domain: 'reader' }))
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.anticipate(anticipate({ taskId: 'a-tie', likelihood: 0.8 }))
      const all = store.tasks()
      // Equal likelihoods break by task id ascending.
      expect(all.map(entry => entry.taskId)).toEqual(['a-tie', 'b-tie', 'low'])
      expect(store.tasks('reader').map(entry => entry.taskId)).toEqual(['b-tie'])
      expect(store.tasks('ghost')).toEqual([])
      ;(all[0] as { domain: string }).domain = 'mutated'
      expect(store.tasks()[0]?.domain).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('precomputes an artifact with zero hits and rejects unknown tasks', async () => {
    const { fiber, store } = await boot()
    try {
      await expect(store.precompute(precompute())).rejects.toThrow("unknown anticipated task 't1'")
      await store.anticipate(anticipate())
      const artifact = await store.precompute(precompute({ kind: 'candidate-plan' }))
      expect(artifact).toMatchObject({
        artifactId: 'a1',
        taskId: 't1',
        kind: 'candidate-plan',
        summary: 'outline',
        offlineCostTokens: 200,
        hits: 0,
        savedTokens: 0,
      })
      expect(artifact.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists artifacts newest first, filters by task, and breaks ties by artifact id', async () => {
    const { fiber, store } = await boot()
    try {
      await store.anticipate(anticipate())
      await store.anticipate(anticipate({ taskId: 't2' }))
      // A frozen clock gives both artifacts the same instant, so the order
      // must come from the artifact-id tie-break.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'))
      try {
        await store.precompute(precompute({ artifactId: 'b' }))
        await store.precompute(precompute({ artifactId: 'a', taskId: 't2' }))
      } finally {
        vi.useRealTimers()
      }
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.precompute(precompute({ artifactId: 'c' }))
      expect(store.artifacts().map(entry => entry.artifactId)).toEqual(['c', 'a', 'b'])
      expect(store.artifacts('t2').map(entry => entry.artifactId)).toEqual(['a'])
      expect(store.artifacts('ghost')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('accumulates hits and saved tokens, rejecting unknown artifacts', async () => {
    const { fiber, store } = await boot()
    try {
      await expect(store.hit('ghost', 10)).rejects.toThrow("unknown artifact 'ghost'")
      await store.anticipate(anticipate())
      await store.precompute(precompute())
      const first = await store.hit('a1', 100)
      expect(first).toMatchObject({ hits: 1, savedTokens: 100 })
      const second = await store.hit('a1', 50)
      expect(second).toMatchObject({ hits: 2, savedTokens: 150 })
    } finally {
      await fiber.dispose()
    }
  })

  it('plans only tasks with no artifact yet, best net first within budget', async () => {
    const { fiber, store } = await boot(undefined, { defaultEstimatedCostTokens: 200, maxOfflineTokens: 450 })
    try {
      await store.anticipate(anticipate({ taskId: 'done', likelihood: 1 }))
      await store.anticipate(anticipate({ taskId: 'first', likelihood: 1 }))
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.anticipate(anticipate({ taskId: 'second', likelihood: 0.9 }))
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.anticipate(anticipate({ taskId: 'hopeless', likelihood: 0 }))
      await store.precompute(precompute({ artifactId: 'cached', taskId: 'done' }))
      // The default config estimates 200 per precompute inside a 450 budget,
      // so the plan fits the two best open tasks and skips the cached and the
      // worthless one.
      const planned = store.plan()
      expect(planned.map(decision => decision.taskId)).toEqual(['first', 'second'])
      expect(planned[0]).toMatchObject({ domain: 'writer', worthIt: true })
    } finally {
      await fiber.dispose()
    }
  })

  it('honors explicit cost and budget arguments', async () => {
    const { fiber, store } = await boot()
    try {
      await store.anticipate(anticipate({ taskId: 'first', likelihood: 1 }))
      await store.anticipate(anticipate({ taskId: 'second', likelihood: 0.9 }))
      expect(store.plan(200, 199).map(decision => decision.taskId)).toEqual([])
      expect(store.plan(200, 10_000).map(decision => decision.taskId)).toEqual(['first', 'second'])
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.anticipate(anticipate({ scope: 'outline' }))
      await first.store.precompute(precompute())
      await first.store.hit('a1', 100)
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.tasks()).toHaveLength(1)
      expect(second.store.tasks('writer')[0]).toMatchObject({ taskId: 't1', scope: 'outline' })
      expect(second.store.artifacts()).toHaveLength(1)
      expect(second.store.artifacts('t1')[0]).toMatchObject({ hits: 1, savedTokens: 100 })
      expect(second.store.plan(200, 10_000)).toEqual([])
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionSleeptime(ctx, { defaultEstimatedCostTokens: 2000, maxOfflineTokens: 50000 })
    expect(() => store.tasks()).toThrow('not started yet')
    expect(() => store.artifacts()).toThrow('not started yet')
    expect(() => store.plan()).toThrow('not started yet')
  })
})
