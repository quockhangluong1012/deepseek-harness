import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionBenchmark, { MINED_TASK, resolveConfig } from '../src/index.ts'
import type { BenchmarkInput } from '../src/index.ts'

async function boot(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  new SessionProjectionRegistry(ctx)
  new TokenMeter(ctx)
  const fiber = await ctx.plugin(EvolutionBenchmark, config)
  return { ctx, fiber, store: ctx.evolutionBenchmark }
}

const input = (task: string, capability = 'writer'): BenchmarkInput => ({
  capability,
  task,
  gists: ['boom'],
  sourceSessions: ['s1'],
  ...MINED_TASK,
})

describe('evolution benchmark', () => {
  it('resolves the admission and run bounds', () => {
    expect(resolveConfig({})).toEqual({ maxAdmit: 20, maxTasks: 20, attempts: 1 })
    expect(resolveConfig({ maxAdmit: 3 })).toEqual({ maxAdmit: 3, maxTasks: 20, attempts: 1 })
    expect(resolveConfig({ maxTasks: 5, attempts: 3 })).toEqual({ maxAdmit: 20, maxTasks: 5, attempts: 3 })
  })

  it('admits fresh tasks with content addresses and reports duplicates', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.admit([input('fix a'), input('fix b')])
      expect(first.duplicates).toEqual([])
      expect(first.admitted).toHaveLength(2)
      expect(first.admitted[0]).toMatchObject({ capability: 'writer', state: 'fresh', gists: ['boom'] })
      expect(first.admitted[0]?.hash).toMatch(/^[0-9a-f]{64}$/)

      const second = await store.admit([input('fix a'), input('fix c'), input('fix a')])
      expect(second.admitted.map(t => t.task)).toEqual(['fix c'])
      expect(second.duplicates).toEqual(['fix a', 'fix a'])
      expect(store.tasks()).toHaveLength(3)
    } finally {
      await fiber.dispose()
    }
  })

  it('re-admits a task once its twin is contaminated or retired', async () => {
    const { fiber, store } = await boot()
    try {
      const { admitted } = await store.admit([input('fix a')])
      const id = admitted[0]?.id as string
      await store.transition(id, 'contaminated')
      const again = await store.admit([input('fix a')])
      expect(again.admitted).toHaveLength(1)

      const second = await store.admit([input('fix b')])
      const id2 = second.admitted[0]?.id as string
      await store.transition(id2, 'retired')
      const reread = await store.admit([input('fix b')])
      expect(reread.admitted).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('caps the admission pass and orders and filters the listing', async () => {
    const { fiber, store } = await boot({ maxAdmit: 2 })
    try {
      const { admitted } = await store.admit([input('a'), input('b'), input('c')])
      expect(admitted).toHaveLength(2)
      await store.transition(admitted[0]?.id as string, 'contaminated')
      const all = store.tasks()
      expect(all[0]?.state).toBe('fresh')
      expect(store.tasks('contaminated')).toHaveLength(1)
      // Detached copies.
      const rows = store.tasks('fresh')
      ;(rows[0] as { task: string }).task = 'mutated'
      expect(store.tasks('fresh')[0]?.task).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('enforces legal transitions and rejects unknown ids', async () => {
    const { fiber, store } = await boot()
    try {
      const { admitted } = await store.admit([input('fix a')])
      const id = admitted[0]?.id as string
      const search = await store.transition(id, 'search')
      expect(search.state).toBe('search')
      await store.transition(id, 'validation')
      await store.transition(id, 'holdout')
      await expect(store.transition(id, 'search')).rejects.toThrow(/illegal transition holdout → search/)
      await expect(store.transition('ghost', 'retired')).rejects.toThrow("unknown task 'ghost'")
      // Same-state resolves without writing.
      await expect(store.transition(id, 'holdout')).resolves.toMatchObject({ state: 'holdout' })
      // Terminal states never leave.
      await store.transition(id, 'contaminated')
      await expect(store.transition(id, 'fresh')).rejects.toThrow(/illegal transition contaminated → fresh/)
    } finally {
      await fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionBenchmark(ctx, {})
    expect(() => store.tasks()).toThrow('not started yet')
  })
})
