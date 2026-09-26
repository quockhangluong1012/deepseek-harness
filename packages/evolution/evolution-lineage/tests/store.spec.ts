import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionLineage from '../src/index.ts'
import type { ExperimentInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionLineage, config ?? {})
  return { ctx, fiber, store: ctx.evolutionLineage }
}

const experiment = (overrides: Partial<ExperimentInput> = {}): ExperimentInput => ({
  experimentId: 'e1',
  skill: 'writer',
  candidate: 'c1',
  tasks: ['t1'],
  metrics: { pass: true, tokens: 10, wallTimeMs: 100 },
  outcome: 'improved',
  regressions: [],
  dependencies: { skill: 's1', evaluator: 'e1' },
  seeds: [7],
  ...overrides,
})

describe('evolution lineage', () => {
  it('records an envelope with a recording instant', async () => {
    const { fiber, store } = await boot()
    try {
      const stored = await store.record(experiment({ hypothesis: 'compress', operator: 'rewrite' }))
      expect(stored).toMatchObject({
        experimentId: 'e1',
        skill: 'writer',
        hypothesis: 'compress',
        candidate: 'c1',
        operator: 'rewrite',
        tasks: ['t1'],
        metrics: { pass: true, tokens: 10, wallTimeMs: 100 },
        outcome: 'improved',
        regressions: [],
        dependencies: { skill: 's1', evaluator: 'e1' },
        seeds: [7],
      })
      expect(stored.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('amends an existing envelope\'s outcome and reason without touching its other fields', async () => {
    const { fiber, store } = await boot()
    try {
      const original = await store.record(experiment({ hypothesis: 'compress' }))
      const amended = await store.amendOutcome('e1', 'regressed', 'rolled back after a canary regression')
      expect(amended).toMatchObject({
        experimentId: 'e1',
        outcome: 'regressed',
        rejectedReason: 'rolled back after a canary regression',
        hypothesis: 'compress',
        candidate: 'c1',
      })
      expect(amended.at).toBe(original.at)
      expect(store.envelope('e1')?.outcome).toBe('regressed')
    } finally {
      await fiber.dispose()
    }
  })

  it('amending an unknown experiment throws', async () => {
    const { fiber, store } = await boot()
    try {
      await expect(store.amendOutcome('missing', 'regressed')).rejects.toThrow("unknown experiment 'missing'")
    } finally {
      await fiber.dispose()
    }
  })

  it('lists envelopes newest first, filters by skill, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(experiment({ experimentId: 'a' }))
      // A millisecond gap keeps the records distinguishable: the list is
      // newest-`at` first, and ties resolve to experiment-id order.
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.record(experiment({ experimentId: 'b' }))
      await store.record(experiment({ experimentId: 'reader-1', skill: 'reader' }))
      const writer = store.experiments('writer')
      expect(writer.map(entry => entry.experimentId)).toEqual(['b', 'a'])
      expect(store.experiments()).toHaveLength(3)
      ;(writer[0] as { skill: string }).skill = 'mutated'
      expect(store.experiments('writer')[0]?.skill).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('reads one envelope detached, or undefined when unknown', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.envelope('ghost')).toBeUndefined()
      await store.record(experiment())
      expect(store.envelope('e1')).toMatchObject({ experimentId: 'e1', candidate: 'c1' })
      ;(store.envelope('e1') as { candidate: string }).candidate = 'mutated'
      expect(store.envelope('e1')?.candidate).toBe('c1')
    } finally {
      await fiber.dispose()
    }
  })

  it('compares envelopes over the configured keys', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(experiment({ experimentId: 'a' }))
      await store.record(experiment({ experimentId: 'b' }))
      expect(store.compare('a', 'b')).toEqual({ comparable: true, changed: [] })
      await store.record(
        experiment({ experimentId: 'c', dependencies: { skill: 's1', evaluator: 'e2' } }),
      )
      expect(store.compare('a', 'c')).toEqual({ comparable: false, changed: ['evaluator'] })
      // A change outside the compared keys stays comparable.
      await store.record(experiment({ experimentId: 'd', dependencies: { skill: 's1', evaluator: 'e1', tool: 't2' } }))
      expect(store.compare('a', 'd')).toEqual({ comparable: true, changed: [] })
    } finally {
      await fiber.dispose()
    }
  })

  it('comparing with an unknown id returns undefined', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(experiment({ experimentId: 'a' }))
      expect(store.compare('a', 'ghost')).toBeUndefined()
      expect(store.compare('ghost', 'a')).toBeUndefined()
      expect(store.compare('ghost', 'other')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('replays a detached envelope, or undefined when unknown', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.replay('ghost')).toBeUndefined()
      await store.record(experiment({ seeds: [7, 11] }))
      const replayed = store.replay('e1')
      expect(replayed).toMatchObject({ experimentId: 'e1', seeds: [7, 11] })
      ;(replayed as { seeds: number[] }).seeds.push(13)
      expect(store.replay('e1')?.seeds).toEqual([7, 11])
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.record(experiment({ experimentId: 'e1' }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.experiments()).toHaveLength(1)
      expect(second.store.envelope('e1')?.outcome).toBe('improved')
      expect(second.store.compare('e1', 'e1')).toEqual({ comparable: true, changed: [] })
    } finally {
      await second.fiber.dispose()
    }
  })

  it('numbers a policy\'s revisions from one and diffs each against its parent', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.recordRevision({ policy: 'skill:writer', body: 'head\nold\n' })
      expect(first).toMatchObject({
        policy: 'skill:writer',
        version: 1,
        parentDigest: null,
        diff: { addedLines: 0, removedLines: 0 },
        body: 'head\nold\n',
      })
      expect(first.digest).toMatch(/^[0-9a-f]{64}$/)
      expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const second = await store.recordRevision({ policy: 'skill:writer', body: 'head\nnew\n', benchmark: 'scorer-v1/abc' })
      expect(second).toMatchObject({
        version: 2,
        parentDigest: first.digest,
        diff: { addedLines: 1, removedLines: 1 },
        benchmark: 'scorer-v1/abc',
      })
      // A second policy keeps its own chain.
      const other = await store.recordRevision({ policy: 'prompt:writer', body: 'x\n' })
      expect(other.version).toBe(1)
      expect(store.revisions('skill:writer').map(row => row.version)).toEqual([1, 2])
      expect(store.revisions('prompt:writer').map(row => row.version)).toEqual([1])
      expect(store.revisions('missing')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('re-recording the head body adds no revision, while restoring an older body does', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.recordRevision({ policy: 'skill:writer', body: 'one\n' })
      await store.recordRevision({ policy: 'skill:writer', body: 'two\n' })
      const unchanged = await store.recordRevision({ policy: 'skill:writer', body: 'two\n' })
      expect(unchanged.version).toBe(2)
      expect(store.revisions('skill:writer')).toHaveLength(2)
      // A revert re-commits the old bytes as a new revision rather than
      // rewriting the chain, so the revision it undoes stays readable.
      const reverted = await store.recordRevision({ policy: 'skill:writer', body: 'one\n' })
      expect(reverted).toMatchObject({ version: 3, digest: first.digest, body: 'one\n' })
      expect(reverted.parentDigest).not.toBeNull()
      expect(store.revisions('skill:writer').map(row => row.body)).toEqual(['one\n', 'two\n', 'one\n'])
    } finally {
      await fiber.dispose()
    }
  })

  it('revisions are detached, and the chain survives a restart', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.recordRevision({ policy: 'skill:writer', body: 'one\n' })
      const head = first.store.revisions('skill:writer')[0]
      if (head === undefined) throw new Error('the revision was not recorded')
      head.body = 'mutated'
      expect(first.store.revisions('skill:writer')[0]?.body).toBe('one\n')
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.revisions('skill:writer')).toHaveLength(1)
      expect(second.store.revisions('skill:writer')[0]?.body).toBe('one\n')
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionLineage(ctx, { comparedKeys: ['skill'] })
    expect(() => store.experiments()).toThrow('not started yet')
    expect(() => store.envelope('e1')).toThrow('not started yet')
    expect(() => store.compare('a', 'b')).toThrow('not started yet')
    expect(() => store.replay('e1')).toThrow('not started yet')
    expect(() => store.revisions('skill:writer')).toThrow('not started yet')
  })

  it('recording a revision throws before the store starts', async () => {
    const ctx = new Context()
    const store = new EvolutionLineage(ctx, { comparedKeys: ['skill'] })
    await expect(store.recordRevision({ policy: 'skill:writer', body: 'x\n' })).rejects.toThrow('not started yet')
  })

  it('amending throws before the store starts', async () => {
    const ctx = new Context()
    const store = new EvolutionLineage(ctx, { comparedKeys: ['skill'] })
    await expect(store.amendOutcome('e1', 'regressed')).rejects.toThrow('not started yet')
  })
})
