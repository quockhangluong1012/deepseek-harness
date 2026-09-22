import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionAdversary from '../src/index.ts'
import { GAMING_DEFENSES } from '../src/index.ts'
import type { ProbeInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionAdversary, config ?? {})
  return { ctx, fiber, store: ctx.evolutionAdversary }
}

const input = (overrides: Partial<ProbeInput> = {}): ProbeInput => ({
  probeId: 'p1',
  skill: 'writer',
  category: 'edge-case',
  probe: 'Tricky input.',
  foundWeakness: false,
  ...overrides,
})

describe('evolution adversary', () => {
  it('records a probe unrepaired with the current instant', async () => {
    const { fiber, store } = await boot()
    try {
      const stored = await store.probe(input({ foundWeakness: true }))
      expect(stored).toMatchObject({
        probeId: 'p1',
        skill: 'writer',
        category: 'edge-case',
        probe: 'Tricky input.',
        foundWeakness: true,
        repaired: false,
      })
      expect(stored.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('marks a probe repaired and rejects unknown probes', async () => {
    const { fiber, store } = await boot()
    try {
      await store.probe(input())
      const repaired = await store.setRepaired('p1')
      expect(repaired.repaired).toBe(true)
      expect(repaired.probeId).toBe('p1')
      // A regressed fix reopens the probe explicitly.
      expect((await store.setRepaired('p1', false)).repaired).toBe(false)
      await expect(store.setRepaired('ghost')).rejects.toThrow("unknown probe 'ghost'")
    } finally {
      await fiber.dispose()
    }
  })

  it('lists probes newest first, filters by skill, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.probe(input({ probeId: 'a' }))
      // A millisecond gap keeps the first two records distinguishable: the
      // newest-`at` probe sorts first, and ties fall back to probe id.
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.probe(input({ probeId: 'b' }))
      await store.probe(input({ probeId: 'reader-1', skill: 'reader' }))
      for (const probeId of ['c', 'd', 'e', 'f', 'g']) {
        await store.probe(input({ probeId }))
      }
      const writer = store.probes('writer')
      // The gapped pair is distinguishable — `b` is newer than `a` — while
      // the rapid tail may share one millisecond, so it asserts as a set.
      const ids = writer.map(entry => entry.probeId)
      expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'))
      expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
      expect(writer).toHaveLength(7)
      expect(store.probes()).toHaveLength(8)
      expect(store.probes('reader')).toHaveLength(1)
      ;(writer[0] as { probe: string }).probe = 'mutated'
      expect(store.probes('writer')[0]?.probe).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('names the next challenge end to end under the configured minimum', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.challenge('writer')).toEqual({
        skill: 'writer',
        category: 'edge-case',
        probed: 0,
        reason: 'edge-case has 0 probes, below the 1 minimum',
      })
      await store.probe(input({ probeId: 'a' }))
      expect(store.challenge('writer').category).toBe('prompt-injection')
      for (const [index, category] of (['prompt-injection', 'stale-memory', 'retrieval-trap', 'contradictory-evidence', 'tool-failure', 'ambiguous-instruction', 'evaluator-gaming'] as const).entries()) {
        await store.probe(input({ probeId: `cover-${index}`, category }))
      }
      const rotation = store.challenge('writer')
      expect(rotation.category).toBe('edge-case')
      expect(rotation.reason).toBe('all categories covered; rotating the least-probed')
    } finally {
      await fiber.dispose()
    }
  })

  it('applies a configured probe minimum to the challenge', async () => {
    const { fiber, store } = await boot(undefined, { minProbesPerCategory: 2 })
    try {
      expect(store.challenge('writer').reason).toBe('edge-case has 0 probes, below the 2 minimum')
      await store.probe(input({ probeId: 'a' }))
      const again = store.challenge('writer')
      expect(again).toMatchObject({ category: 'edge-case', probed: 1 })
      expect(again.reason).toBe('edge-case has 1 probes, below the 2 minimum')
    } finally {
      await fiber.dispose()
    }
  })

  it('tracks the defense checklist from open defaults through set rows', async () => {
    const { fiber, store } = await boot()
    try {
      const defaults = store.defenses()
      expect(defaults.map(entry => entry.defense)).toEqual([...GAMING_DEFENSES])
      expect(defaults.every(entry => ! entry.satisfied && entry.at === null)).toBe(true)
      expect(store.defenseGaps()).toEqual([...GAMING_DEFENSES])
      const set = await store.setDefense('hidden-holdout', true)
      expect(set).toMatchObject({ defense: 'hidden-holdout', satisfied: true })
      expect(set.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const gaps = store.defenseGaps()
      expect(gaps).not.toContain('hidden-holdout')
      expect(gaps).toHaveLength(5)
      await store.setDefense('hidden-holdout', false)
      expect(store.defenseGaps()).toEqual([...GAMING_DEFENSES])
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.probe(input({ foundWeakness: true }))
      await first.store.setRepaired('p1')
      await first.store.setDefense('hidden-holdout', true)
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.probes()).toHaveLength(1)
      expect(second.store.probes('writer')[0]).toMatchObject({ probeId: 'p1', repaired: true, foundWeakness: true })
      expect(second.store.defenses().find(entry => entry.defense === 'hidden-holdout')).toMatchObject({ satisfied: true })
      expect(second.store.defenseGaps()).toHaveLength(5)
      expect(second.store.challenge('writer').category).toBe('prompt-injection')
    } finally {
      await second.fiber.dispose()
    }
  })

  it('observes the defenses the mounted stores record and names the rest unobserved', async () => {
    const bare = await boot()
    try {
      expect(bare.store.observedDefenses().map(entry => entry.state)).toEqual([
        'unobserved',
        'unobserved',
        'observed-open',
        'observed-open',
        'unobserved',
        'unobserved',
      ])
    } finally {
      await bare.fiber.dispose()
    }
    const { ctx, fiber, store } = await boot()
    try {
      ctx.provide('evolutionEvaluatorStrategy', {
        strategies: () => [
          { evaluator: 'scorer-v1', independentSamples: 3 },
          { evaluator: 'ensemble-v2', independentSamples: 1 },
        ],
      } as never)
      ctx.provide('evolutionBenchmark', {
        tasks: (state: string) => (state === 'holdout' ? [{ capability: 'writer' }, { capability: 'writer' }] : []),
      } as never)
      ctx.provide('evolutionRouter', {
        effectiveness: () => [
          { taskClass: 'writer', provider: 'deepseek', model: 'chat' },
          { taskClass: 'writer', provider: 'deepseek', model: 'reasoner' },
        ],
      } as never)
      await store.probe(input({ probeId: 'gaming', category: 'evaluator-gaming' }))
      for (const category of ['edge-case', 'prompt-injection', 'stale-memory', 'retrieval-trap', 'contradictory-evidence', 'tool-failure', 'ambiguous-instruction'] as const) {
        await store.probe(input({ probeId: category, category }))
      }
      expect(store.observedDefenses()).toEqual([
        { defense: 'multiple-evaluators', state: 'observed-satisfied', evidence: '2 evaluator(s) carry an independent verdict' },
        { defense: 'hidden-holdout', state: 'observed-satisfied', evidence: '1 capability(s) hold a protected holdout task' },
        { defense: 'behavioral-metrics', state: 'observed-satisfied', evidence: '1 probe(s) exercised evaluator-gaming behavior' },
        { defense: 'adversarial-tests', state: 'observed-satisfied', evidence: '1 probe skill(s) cover every §45 category' },
        {
          defense: 'randomized-tests',
          state: 'unobserved',
          evidence: 'nothing records which tests were randomized; randomized tests and human spot checks stay operator-side',
        },
        { defense: 'evaluator-rotation', state: 'observed-satisfied', evidence: '1 task class(es) recorded two or more evaluation routes' },
      ])
    } finally {
      await fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionAdversary(ctx, { minProbesPerCategory: 1 })
    expect(() => store.probes()).toThrow('not started yet')
    expect(() => store.challenge('writer')).toThrow('not started yet')
    expect(() => store.defenses()).toThrow('not started yet')
    expect(() => store.defenseGaps()).toThrow('not started yet')
    expect(() => store.observedDefenses()).toThrow('not started yet')
  })
})
