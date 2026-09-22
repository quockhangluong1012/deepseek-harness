import { describe, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
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
  workflow: [
    { component: 'operators', choice: 'portfolio-v1' },
    { component: 'evaluator', choice: 'scorer-v1' },
  ],
  pass: true,
  tokens: 5000,
  wallTimeMs: 60000,
  ...overrides,
})

const REVERSED = [
  { component: 'evaluator' as const, choice: 'scorer-v1' },
  { component: 'operators' as const, choice: 'portfolio-v1' },
]

describe('evolution meta', () => {
  it('records an engine run with now as its instant', async () => {
    const { fiber, store } = await boot()
    try {
      const run = await store.record(input())
      expect(run).toMatchObject({ runId: 'r1', taskClass: 'writer', pass: true, tokens: 5000, wallTimeMs: 60000 })
      expect(run.config).toMatchObject({ operators: 'portfolio-v1', evaluator: 'scorer-v1', budget: 'balanced-v1', routing: 'evidence-v1' })
      expect(run.workflow).toEqual([
        { component: 'operators', choice: 'portfolio-v1' },
        { component: 'evaluator', choice: 'scorer-v1' },
      ])
      expect(run.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('records a run whose caller observed no sequence as an empty workflow', async () => {
    const { fiber, store } = await boot()
    try {
      const run = await store.record(input({ workflow: undefined }))
      expect(run.workflow).toEqual([])
      expect(store.summaries('writer')[0]).toMatchObject({ workflowId: '' })
    } finally {
      await fiber.dispose()
    }
  })

  it('completes a partial configuration with the default choices', async () => {
    const { fiber, store } = await boot()
    try {
      const run = await store.record(input({ config: { operators: 'portfolio-v2' } }))
      expect(run.config).toMatchObject({ operators: 'portfolio-v2', evaluator: 'scorer-v1', budget: 'balanced-v1', routing: 'evidence-v1' })
      // A run that names no choice at all takes every default.
      const empty = await store.record(input({ runId: 'r2', config: {} }))
      expect(empty.config).toEqual({ operators: 'portfolio-v1', evaluator: 'scorer-v1', budget: 'balanced-v1', routing: 'evidence-v1' })
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
      await delay(5)
      await store.record(input({ runId: 'r2' }))
      await delay(5)
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
      // Grouped by task class ascending, then best score first inside a class.
      expect(all.map(row => row.taskClass)).toEqual(['reader', 'writer', 'writer'])
      const writerDefault = all.find(row => row.taskClass === 'writer' && row.samples === 2)
      expect(writerDefault).toMatchObject({ passes: 1, passRate: 0.5, meanTokens: 10000 })
      expect(store.summaries('writer')).toHaveLength(2)
      const detached = store.summaries()[0]
      if (detached !== undefined) detached.taskClass = 'mutated'
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
      expect(recommended?.configId).toBe('portfolio-v1\0scorer-v1\0balanced-v1\0evidence-v1\0operators=portfolio-v1>evaluator=scorer-v1')
      expect(recommended?.samples).toBe(2)
      expect(recommended?.reason).toContain('2/2 passed')
      expect(store.recommend('ghost')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends a workflow, not only a scalar choice', async () => {
    const { fiber, store } = await boot(undefined, { minimumSamples: 2 })
    try {
      // The same four choices run in two orders are two candidates, and the
      // pass rate picks the sequence rather than the components.
      await store.record(input({ runId: 'forward-1' }))
      await store.record(input({ runId: 'forward-2' }))
      await store.record(input({ runId: 'reverse-1', workflow: REVERSED, pass: false }))
      await store.record(input({ runId: 'reverse-2', workflow: REVERSED, pass: false }))
      expect(store.summaries('writer')).toHaveLength(2)
      const recommended = store.recommend('writer')
      expect(recommended?.config).toEqual(input().config)
      expect(recommended?.workflow).toEqual([
        { component: 'operators', choice: 'portfolio-v1' },
        { component: 'evaluator', choice: 'scorer-v1' },
      ])
      expect(recommended?.workflowId).toBe('operators=portfolio-v1>evaluator=scorer-v1')
      expect(recommended?.reason).toContain('workflow operators=portfolio-v1>evaluator=scorer-v1')
      expect(store.runs('writer').find(row => row.runId === 'reverse-1')?.workflow).toEqual(REVERSED)
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
      expect(second.store.runs()[0]?.workflow).toEqual([
        { component: 'operators', choice: 'portfolio-v1' },
        { component: 'evaluator', choice: 'scorer-v1' },
      ])
      expect(second.store.summaries('writer')[0]).toMatchObject({ samples: 2, passes: 1 })
      expect(second.store.summaries('writer')[0]?.workflowId).toBe('operators=portfolio-v1>evaluator=scorer-v1')
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
