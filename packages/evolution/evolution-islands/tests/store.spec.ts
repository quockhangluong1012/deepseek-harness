import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionIslands from '../src/index.ts'
import type { IslandInput, MigrationInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionIslands, config ?? {})
  return { ctx, fiber, store: ctx.evolutionIslands }
}

const island = (overrides: Partial<IslandInput> = {}): IslandInput => ({
  islandId: 'a',
  name: 'Stable A',
  objective: 'performance',
  skill: 'writer',
  ...overrides,
})

const migration = (overrides: Partial<MigrationInput> = {}): MigrationInput => ({
  fromIslandId: 'a',
  toIslandId: 'b',
  candidateId: 'c1',
  reason: 'schedule',
  ...overrides,
})

describe('evolution islands', () => {
  it('registers an island with a zero generation and no activity', async () => {
    const { fiber, store } = await boot()
    try {
      const stored = await store.register(island())
      expect(stored).toMatchObject({
        islandId: 'a',
        name: 'Stable A',
        objective: 'performance',
        skill: 'writer',
        generation: 0,
        lastActivityAt: null,
      })
      expect(stored.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      await expect(store.register(island())).rejects.toThrow("island 'a' already exists")
    } finally {
      await fiber.dispose()
    }
  })

  it('advances the head island of a skill and is a no-op without one', async () => {
    const { fiber, store } = await boot()
    try {
      expect(await store.advance('writer')).toBeUndefined()
      await store.register(island())
      // A millisecond gap keeps the registrations distinguishable: the head
      // is the newest-`at` island, and ties would resolve to input order.
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.register(island({ islandId: 'b', name: 'Diverse B', objective: 'novelty' }))
      const advanced = await store.advance('writer')
      expect(advanced?.islandId).toBe('b')
      expect(advanced?.generation).toBe(1)
      expect(advanced?.lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const stored = store.islands('writer').find(row => row.islandId === 'b')
      expect(stored?.generation).toBe(1)
      expect(await store.advance('reader')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('records migrations, rejecting unknown or cross-skill islands', async () => {
    const { fiber, store } = await boot()
    try {
      await store.register(island())
      await store.register(island({ islandId: 'b', name: 'Diverse B', objective: 'novelty' }))
      const first = await store.migrate(migration())
      expect(first).toMatchObject({
        fromIslandId: 'a',
        toIslandId: 'b',
        candidateId: 'c1',
        skill: 'writer',
        reason: 'schedule',
      })
      expect(first.migrationId).toMatch(/^[0-9a-f-]{36}$/)
      // A candidate may migrate repeatedly; every move gets its own record.
      const second = await store.migrate(migration({ candidateId: 'c1' }))
      expect(second.migrationId).not.toBe(first.migrationId)
      await expect(store.migrate(migration({ fromIslandId: 'ghost' }))).rejects.toThrow("unknown island 'ghost'")
      await expect(store.migrate(migration({ toIslandId: 'ghost' }))).rejects.toThrow("unknown island 'ghost'")
      await store.register(island({ islandId: 'r', name: 'Reader', objective: 'cost', skill: 'reader' }))
      await expect(store.migrate(migration({ toIslandId: 'r' }))).rejects.toThrow(/different skills/)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists islands and migrations newest first, filters by skill, and detaches', async () => {
    const { fiber, store } = await boot()
    try {
      await store.register(island())
      await store.register(island({ islandId: 'b', name: 'Diverse B', objective: 'novelty' }))
      await store.register(island({ islandId: 'r', name: 'Reader', objective: 'cost', skill: 'reader' }))
      await store.migrate(migration())
      const writer = store.islands('writer')
      expect(writer.map(row => row.islandId).sort()).toEqual(['a', 'b'])
      expect(writer).toHaveLength(2)
      expect(store.islands()).toHaveLength(3)
      expect(store.migrations()).toHaveLength(1)
      expect(store.migrations('reader')).toHaveLength(0)
      ;(writer[0] as { name: string }).name = 'mutated'
      expect(store.islands('writer')[0]?.name).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('reports the schedule with the last migration and the due flag', async () => {
    const { fiber, store } = await boot()
    try {
      await store.register(island())
      await store.register(island({ islandId: 'b', name: 'Diverse B', objective: 'novelty' }))
      await store.register(island({ islandId: 'c', name: 'Fresh C', objective: 'cost' }))
      await store.migrate(migration())
      await store.migrate(migration({ fromIslandId: 'b', toIslandId: 'a', candidateId: 'c2' }))
      const schedule = store.schedule('writer')
      expect(schedule.map(row => row.island.islandId)).toEqual(['a', 'b', 'c'])
      const a = schedule[0] as { island: { islandId: string }; lastMigrationAt: string | null; due: boolean }
      expect(a.island.islandId).toBe('a')
      // The migration from 'a' to 'b' touched both ends, so both carry it.
      expect(a.lastMigrationAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      // The default cadence is one day, so a fresh island is never due.
      expect(a.due).toBe(false)
      const b = schedule[1] as { lastMigrationAt: string | null; due: boolean }
      expect(b.lastMigrationAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(b.due).toBe(false)
      const c = schedule[2] as { lastMigrationAt: string | null; due: boolean }
      expect(c.lastMigrationAt).toBeNull()
      expect(c.due).toBe(false)
      expect(store.schedule()).toHaveLength(3)
    } finally {
      await fiber.dispose()
    }
  })

  it('respects a configured migration cadence', async () => {
    const { fiber, store } = await boot(undefined, { migrationCadence: 1000 })
    try {
      // One second is still far longer than the test's registration instant,
      // so the fresh island stays not due while the config is honored.
      await store.register(island())
      expect(store.schedule('writer')[0]?.due).toBe(false)
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.register(island())
      await first.store.register(island({ islandId: 'b', name: 'Diverse B', objective: 'novelty' }))
      await first.store.migrate(migration())
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.islands()).toHaveLength(2)
      expect(second.store.migrations()).toHaveLength(1)
      expect(second.store.migrations('writer')[0]?.fromIslandId).toBe('a')
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionIslands(ctx, { migrationCadence: 86_400_000 })
    expect(() => store.islands()).toThrow('not started yet')
    expect(() => store.migrations()).toThrow('not started yet')
  })
})
