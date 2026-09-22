import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionUncertainty from '../src/index.ts'
import type { UncertaintySignalInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionUncertainty, config ?? {})
  return { ctx, fiber, store: ctx.evolutionUncertainty }
}

const input = (overrides: Partial<UncertaintySignalInput> = {}): UncertaintySignalInput => ({
  signalId: 's1',
  skill: 'writer',
  taskId: 't1',
  kind: 'disagreement',
  score: 0.5,
  detail: 'channels split on routing',
  ...overrides,
})

describe('evolution uncertainty', () => {
  it('records a signal stamping the current instant', async () => {
    const { fiber, store } = await boot()
    try {
      const stored = await store.record(input())
      expect(stored).toMatchObject({
        signalId: 's1',
        skill: 'writer',
        taskId: 't1',
        kind: 'disagreement',
        score: 0.5,
        detail: 'channels split on routing',
      })
      expect(stored.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const second = await store.record(input({ signalId: 's2', taskId: null }))
      expect(second.taskId).toBeNull()
    } finally {
      await fiber.dispose()
    }
  })

  it('lists signals newest first, filters by skill, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(input({ signalId: 'old' }))
      // A millisecond gap keeps the pair distinguishable: newest-first is only
      // asserted across this gap, never within one shared millisecond.
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.record(input({ signalId: 'new' }))
      await store.record(input({ signalId: 'reader-1', skill: 'reader', taskId: null }))
      const writer = store.signals('writer')
      expect(writer.map(entry => entry.signalId)).toEqual(['new', 'old'])
      expect(store.signals()).toHaveLength(3)
      expect(store.signals('reader')).toHaveLength(1)
      // Reads are deterministic: the same call twice names the same order.
      expect(store.signals().map(entry => entry.signalId)).toEqual(store.signals().map(entry => entry.signalId))
      ;(writer[0] as { detail: string }).detail = 'mutated'
      expect(store.signals('writer')[0]?.detail).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('queues tasks capped by the default limit and an override', async () => {
    const { fiber, store } = await boot(undefined, { queueLimit: 2 })
    try {
      await store.record(input({ signalId: 'hot', taskId: 'hot', score: 0.9 }))
      await store.record(input({ signalId: 'warm-a', taskId: 'warm', score: 0.5 }))
      await store.record(input({ signalId: 'warm-b', taskId: 'warm', kind: 'low-confidence', score: 0.5, detail: 'judge hedged' }))
      await store.record(input({ signalId: 'r1', skill: 'reader', taskId: null }))
      const top = store.queue()
      expect(top.map(task => task.taskId)).toEqual(['hot', 'warm'])
      expect(top[0]).toMatchObject({ skill: 'writer', topScore: 0.9, priority: 0.9, signals: 1 })
      expect(top[1]?.priority).toBeCloseTo(0.65)
      expect(store.queue(undefined, 3)).toHaveLength(3)
      expect(store.queue(undefined, 1).map(task => task.taskId)).toEqual(['hot'])
      expect(store.queue('reader').map(task => task.taskId)).toEqual([null])
    } finally {
      await fiber.dispose()
    }
  })

  it('resolves one task or the skill-wide signals, returning the count removed', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(input({ signalId: 'n1', taskId: null }))
      await store.record(input({ signalId: 'n2', taskId: null }))
      await store.record(input({ signalId: 'a', taskId: 't1' }))
      await store.record(input({ signalId: 'b', taskId: 't1' }))
      await store.record(input({ signalId: 'c', taskId: 't2' }))
      await store.record(input({ signalId: 'r', skill: 'reader', taskId: null }))
      // Without a task identity only the skill-wide signals go.
      expect(await store.resolve('writer')).toBe(2)
      expect(store.signals('writer').map(entry => entry.signalId).sort()).toEqual(['a', 'b', 'c'])
      expect(await store.resolve('writer', 't1')).toBe(2)
      expect(await store.resolve('writer', 't9')).toBe(0)
      expect(store.signals('writer').map(entry => entry.signalId)).toEqual(['c'])
      expect(await store.resolve('reader')).toBe(1)
      expect(await store.resolve('ghost')).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.record(input({ signalId: 's1' }))
      await first.store.record(input({ signalId: 's2', taskId: null, kind: 'conflicting-evidence', detail: 'sources disagree' }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.signals()).toHaveLength(2)
      expect(second.store.signals('writer').map(entry => entry.signalId).sort()).toEqual(['s1', 's2'])
      expect(second.store.queue('writer')).toHaveLength(2)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionUncertainty(ctx, { queueLimit: 50, corroborationBonus: 0.15 })
    expect(() => store.signals()).toThrow('not started yet')
    expect(() => store.queue()).toThrow('not started yet')
  })
})
