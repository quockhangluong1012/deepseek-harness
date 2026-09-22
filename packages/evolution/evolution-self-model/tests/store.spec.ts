import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionSelfModel from '../src/index.ts'
import type { CapabilityObservation, SelfModelInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionSelfModel, config ?? {})
  return { ctx, fiber, store: ctx.evolutionSelfModel }
}

const assessment = (overrides: Partial<SelfModelInput> = {}): SelfModelInput => ({
  skill: 'writer',
  strengths: ['draft'],
  weaknesses: ['brevity'],
  uncertainAreas: ['humor'],
  failureModes: ['rambling'],
  preferredTools: ['search'],
  evaluatorBlindspots: ['tone'],
  confidence: 0.6,
  ...overrides,
})

const observation = (overrides: Partial<CapabilityObservation> = {}): CapabilityObservation => ({
  capability: 'lint',
  skill: 'writer',
  pass: true,
  ...overrides,
})

describe('evolution self-model', () => {
  it('records an assessment at revision 1 then upserts the revision', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.record(assessment())
      expect(first).toMatchObject({ skill: 'writer', strengths: ['draft'], revision: 1, confidence: 0.6 })
      expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const second = await store.record(assessment({ strengths: ['draft', 'outline'], confidence: 0.8 }))
      expect(second.revision).toBe(2)
      expect(second.strengths).toEqual(['draft', 'outline'])
      expect(store.assessment('writer')).toMatchObject({ revision: 2, confidence: 0.8 })
      expect(store.assessment('reader')).toBeUndefined()
      second.strengths.push('mutated')
      expect(store.assessment('writer')?.strengths).toEqual(['draft', 'outline'])
    } finally {
      await fiber.dispose()
    }
  })

  it('lists assessments by skill and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(assessment())
      // A millisecond gap keeps the writes distinguishable even though the
      // list order comes from the skill sort, not the clock.
      await new Promise(resolve => setTimeout(resolve, 5))
      await store.record(assessment({ skill: 'reader', strengths: ['summarize'] }))
      const rows = store.assessments()
      expect(rows.map(row => row.skill)).toEqual(['reader', 'writer'])
      ;(rows[0] as { skill: string }).skill = 'mutated'
      expect(store.assessments()[0]?.skill).toBe('reader')
    } finally {
      await fiber.dispose()
    }
  })

  it('observes a capability then updates the running entry', async () => {
    const { fiber, store } = await boot()
    try {
      const created = await store.observe(observation())
      expect(created).toMatchObject({
        capability: 'lint',
        score: 1,
        confidence: 0.1,
        failures: [],
        coveringSkills: ['writer'],
        observations: 1,
      })
      expect(created.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      const updated = await store.observe(observation({ pass: false, skill: 'reader', failure: 'missed rule' }))
      expect(updated).toMatchObject({
        score: 0.5,
        confidence: 0.2,
        failures: ['missed rule'],
        coveringSkills: ['writer', 'reader'],
        observations: 2,
      })
      expect(store.capability('lint')).toMatchObject({ score: 0.5 })
      expect(store.capability('ghost')).toBeUndefined()
      await store.observe(observation({ capability: 'format' }))
      // Capability order is the name sort, never the write clock, so the
      // assertion is a stable set comparison.
      expect(store.capabilities().map(row => row.capability).sort()).toEqual(['format', 'lint'])
      ;(store.capabilities()[0] as { score: number }).score = -1
      expect(store.capability('format')?.score).toBe(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('ranks gaps weakest first and names what to learn next', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.gaps()).toEqual([])
      expect(store.nextToLearn()).toBeNull()
      await store.observe(observation({ capability: 'strong' }))
      await store.observe(observation({ capability: 'strong' }))
      await store.observe(observation({ capability: 'weak', pass: false, failure: 'stuck' }))
      const gaps = store.gaps()
      expect(gaps.map(gap => gap.capability)).toEqual(['weak', 'strong'])
      expect(gaps[0]).toMatchObject({ score: 0, coveringSkills: ['writer'], observations: 1 })
      expect(store.nextToLearn()?.capability).toBe('weak')
    } finally {
      await fiber.dispose()
    }
  })

  it('honors the configured observation and failure caps', async () => {
    const { fiber, store } = await boot(undefined, { maxObservations: 2, maxFailures: 1 })
    try {
      const first = await store.observe(observation())
      expect(first.confidence).toBe(0.5)
      const second = await store.observe(observation({ pass: false, failure: 'a' }))
      expect(second.confidence).toBe(1)
      expect(second.failures).toEqual(['a'])
      const third = await store.observe(observation({ pass: false, failure: 'b' }))
      expect(third.confidence).toBe(1)
      expect(third.failures).toEqual(['b'])
    } finally {
      await fiber.dispose()
    }
  })

  it('domain rows survive a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.record(assessment())
      await first.store.observe(observation({ pass: false, failure: 'stuck' }))
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.assessments()).toHaveLength(1)
      expect(second.store.assessment('writer')).toMatchObject({ revision: 1, strengths: ['draft'] })
      expect(second.store.capability('lint')).toMatchObject({
        score: 0,
        confidence: 0.1,
        failures: ['stuck'],
        observations: 1,
      })
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionSelfModel(ctx, { maxObservations: 10, maxFailures: 10 })
    expect(() => store.assessment('writer')).toThrow('not started yet')
    expect(() => store.assessments()).toThrow('not started yet')
    expect(() => store.capability('lint')).toThrow('not started yet')
    expect(() => store.capabilities()).toThrow('not started yet')
    expect(() => store.gaps()).toThrow('not started yet')
    expect(() => store.nextToLearn()).toThrow('not started yet')
  })
})
