import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionPopulation from '../src/index.ts'
import type { PopulationRecordInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool())) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionPopulation)
  return { ctx, fiber, store: ctx.evolutionPopulation }
}

const record = (overrides: Partial<PopulationRecordInput> = {}): PopulationRecordInput => ({
  skill: 'writer',
  candidateId: 'c1',
  operator: 'rewrite',
  novelty: 0.5,
  triple: { pass: true, tokens: 10, wallTimeMs: 100 },
  status: 'staged',
  ...overrides,
})

describe('evolution population', () => {
  it('records a candidate with an auto parent and generation', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.record(record())
      expect(first).toMatchObject({
        candidateId: 'c1',
        skill: 'writer',
        parentCandidateId: null,
        operator: 'rewrite',
        novelty: 0.5,
        generation: 1,
        status: 'staged',
        triple: { pass: true, tokens: 10, wallTimeMs: 100 },
      })
      expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)

      const second = await store.record(record({ candidateId: 'c2' }))
      expect(second).toMatchObject({ parentCandidateId: 'c1', generation: 2 })

      const third = await store.record(record({ skill: 'reader', candidateId: 'r1' }))
      expect(third).toMatchObject({ parentCandidateId: null, generation: 1 })
    } finally {
      await fiber.dispose()
    }
  })

  it('treats the highest-generation head as the parent on ties', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(record({ candidateId: 'a' }))
      await store.record(record({ candidateId: 'b' }))
      const next = await store.record(record({ candidateId: 'c' }))
      expect(next).toMatchObject({ parentCandidateId: 'b', generation: 3 })
    } finally {
      await fiber.dispose()
    }
  })

  it('stores an unmeasured candidate as null triple', async () => {
    const { fiber, store } = await boot()
    try {
      const stored = await store.record(record({ triple: null }))
      expect(stored.triple).toBeNull()
    } finally {
      await fiber.dispose()
    }
  })

  it('lists candidates newest first, filters by skill, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(record({ candidateId: 'a' }))
      await store.record(record({ candidateId: 'reader-1', skill: 'reader' }))
      await store.record(record({ candidateId: 'b' }))
      const writer = store.candidates('writer')
      // The writer rows may share one timestamp millisecond or span several,
      // so the order is only stable as a set: id tie-break when equal, `at`
      // when not.
      expect(writer.map(candidate => candidate.candidateId).sort()).toEqual(['a', 'b'])
      expect(writer).toHaveLength(2)
      expect(store.candidates()).toHaveLength(3)
      expect(store.candidates('reader')).toHaveLength(1)
      ;(writer[0] as { skill: string }).skill = 'mutated'
      expect(store.candidates('writer')[0]?.skill).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('reports the current generation of a skill', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.generation('writer')).toBe(0)
      await store.record(record({ candidateId: 'a' }))
      await store.record(record({ candidateId: 'b' }))
      expect(store.generation('writer')).toBe(2)
      expect(store.generation('reader')).toBe(0)
    } finally {
      await fiber.dispose()
    }
  })

  it('walks the lineage of a candidate within its skill', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(record({ candidateId: 'a' }))
      await store.record(record({ candidateId: 'root', skill: 'reader' }))
      await store.record(record({ candidateId: 'b' }))
      const chain = store.lineage('writer', 'b')
      expect(chain.map(candidate => candidate.candidateId)).toEqual(['a', 'b'])
      expect(store.lineage('writer', 'ghost')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('ranks the approved elite of a skill', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(record({ candidateId: 'a', status: 'approved', triple: { pass: true, tokens: 10, wallTimeMs: 500 } }))
      await store.record(record({ candidateId: 'b', status: 'approved', triple: { pass: true, tokens: 5, wallTimeMs: 900 } }))
      await store.record(record({ candidateId: 'c', status: 'staged', triple: { pass: true, tokens: 1, wallTimeMs: 1 } }))
      await store.record(record({ candidateId: 'rejected', status: 'rejected', triple: { pass: true, tokens: 1, wallTimeMs: 1 } }))
      expect(store.elite('writer').map(candidate => candidate.candidateId)).toEqual(['b', 'a'])
      expect(store.elite('reader')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('approves and rejects staged candidates, terminal statuses never leave', async () => {
    const { fiber, store } = await boot()
    try {
      const stored = await store.record(record({ candidateId: 'c1' }))
      const approved = await store.updateStatus('c1', 'approved')
      expect(approved.status).toBe('approved')
      await expect(store.updateStatus('c1', 'rejected')).rejects.toThrow(/illegal transition approved → rejected/)
      await store.record(record({ candidateId: 'c2' }))
      await store.updateStatus('c2', 'rejected')
      await expect(store.updateStatus('c2', 'approved')).rejects.toThrow(/illegal transition rejected → approved/)
      await expect(store.updateStatus('ghost', 'approved')).rejects.toThrow("unknown candidate 'ghost'")
      await expect(store.updateStatus('c2', 'rejected')).resolves.toMatchObject({ status: 'rejected' })
      expect(stored.status).toBe('staged')
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.record(record({ candidateId: 'c1' }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.candidates()).toHaveLength(1)
      expect(second.store.candidates('writer')[0]?.candidateId).toBe('c1')
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionPopulation(ctx)
    expect(() => store.candidates()).toThrow('not started yet')
  })
})
