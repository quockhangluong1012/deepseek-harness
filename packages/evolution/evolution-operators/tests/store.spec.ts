import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionOperators, { MUTATION_OPERATORS } from '../src/index.ts'
import type { InstructionInput, InstructionVerdict, OperatorOutcome } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionOperators, config ?? {})
  return { ctx, fiber, store: ctx.evolutionOperators }
}

const outcome = (overrides: Partial<OperatorOutcome> = {}): OperatorOutcome => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  delta: 1,
  ...overrides,
})

const instruction = (overrides: Partial<InstructionInput> = {}): InstructionInput => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  instruction: 'Rewrite the body in the order the evidence supports.',
  reason: 'two runs regressed on rule order',
  ...overrides,
})

const verdict = (overrides: Partial<InstructionVerdict> = {}): InstructionVerdict => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  reason: 'the reordered body passed the holdout',
  ...overrides,
})

describe('evolution operators', () => {
  it('records an outcome as a stats row with now as its instant', async () => {
    const { fiber, store } = await boot()
    try {
      const row = await store.record(outcome())
      expect(row).toMatchObject({ operator: 'rewrite', artifactClass: 'writer', attempts: 1, accepted: 1, meanDelta: 1, regressionRate: 0 })
      expect(row.lastAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await fiber.dispose()
    }
  })

  it('upserts by operator and class, advancing attempts', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(outcome())
      const second = await store.record(outcome({ accepted: false, delta: -1 }))
      expect(second).toMatchObject({ attempts: 2, accepted: 1, meanDelta: 0 })
      expect(store.stats()).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('lists stats in canonical operator order, filters by class, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(outcome({ operator: 'change-tool' }))
      await store.record(outcome({ operator: 'guard' }))
      await store.record(outcome({ operator: 'rewrite', artifactClass: 'reader' }))
      expect(store.stats().map(row => row.operator)).toEqual(['rewrite', 'guard', 'change-tool'])
      expect(store.stats('reader').map(row => row.operator)).toEqual(['rewrite'])
      expect(store.stats('ghost')).toEqual([])
      ;(store.stats()[0] as { artifactClass: string }).artifactClass = 'mutated'
      expect(store.stats()[0]?.artifactClass).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('ranks all canonical operators for a class and recommends the leader', async () => {
    const { fiber, store } = await boot(undefined, { exploration: 0.2 })
    try {
      const empty = store.ranking('writer')
      expect(empty).toHaveLength(MUTATION_OPERATORS.length)
      expect(store.recommend('writer')?.operator).toBe('rewrite')
      await store.record(outcome({ operator: 'compose', accepted: true, delta: 1 }))
      await store.record(outcome({ operator: 'compose', accepted: true, delta: 1 }))
      await store.record(outcome({ operator: 'compose', accepted: true, delta: 1 }))
      const ranked = store.ranking('writer')
      expect(ranked[0]?.operator).toBe('compose')
      expect(store.recommend('writer')?.operator).toBe('compose')
      // A different class still ranks the canonical first operator.
      expect(store.recommend('ghost')?.operator).toBe('rewrite')
    } finally {
      await fiber.dispose()
    }
  })

  it('records a proposed instruction and the verdict that decided it', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.recordInstruction(instruction())
      expect(first).toMatchObject({
        operator: 'rewrite',
        artifactClass: 'writer',
        instruction: 'Rewrite the body in the order the evidence supports.',
        reason: 'two runs regressed on rule order',
        proposals: 1,
        accepted: 0,
        rejected: 0,
        lastVerdict: null,
        decidedAt: null,
      })
      expect(first.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      await expect(store.judgeInstruction(verdict({ operator: 'change-tool' }))).rejects
        .toThrow("no instruction proposed for 'change-tool' on 'writer'")

      const judged = await store.judgeInstruction(verdict())
      expect(judged).toMatchObject({ accepted: 1, lastVerdict: 'the reordered body passed the holdout' })
      expect(judged.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(store.instruction('rewrite', 'writer')).toMatchObject({ accepted: 1 })
      expect(store.instruction('change-tool', 'writer')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('replaces a re-proposed instruction and its verdict tally', async () => {
    const { fiber, store } = await boot()
    try {
      await store.recordInstruction(instruction())
      await store.judgeInstruction(verdict({ accepted: false, reason: 'the holdout failed twice' }))
      const same = await store.recordInstruction(instruction({ reason: 'still the best reading' }))
      expect(same).toMatchObject({ proposals: 2, rejected: 1, lastVerdict: 'the holdout failed twice' })
      const replaced = await store.recordInstruction(instruction({ instruction: 'Add the precondition the failures share.' }))
      expect(replaced).toMatchObject({ proposals: 3, accepted: 0, rejected: 0, lastVerdict: null, decidedAt: null })
    } finally {
      await fiber.dispose()
    }
  })

  it('lists instructions in canonical operator order and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.recordInstruction(instruction({ operator: 'change-tool' }))
      await store.recordInstruction(instruction({ operator: 'guard' }))
      await store.recordInstruction(instruction({ operator: 'rewrite', artifactClass: 'reader' }))
      expect(store.instructions().map(row => row.operator)).toEqual(['rewrite', 'guard', 'change-tool'])
      expect(store.instructions('reader').map(row => row.operator)).toEqual(['rewrite'])
      expect(store.instructions('ghost')).toEqual([])
      ;(store.instructions()[0] as { instruction: string }).instruction = 'mutated'
      expect(store.instructions()[0]?.instruction).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('orders rows of one operator by artifact class', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record(outcome({ artifactClass: 'writer' }))
      await store.record(outcome({ artifactClass: 'reader' }))
      await store.recordInstruction(instruction({ artifactClass: 'writer' }))
      await store.recordInstruction(instruction({ artifactClass: 'reader' }))
      expect(store.stats().map(row => row.artifactClass)).toEqual(['reader', 'writer'])
      expect(store.instructions().map(row => row.artifactClass)).toEqual(['reader', 'writer'])
      expect(store.stats('reader').map(row => row.artifactClass)).toEqual(['reader'])
    } finally {
      await fiber.dispose()
    }
  })

  it('moves the ranking by the instruction verdicts the class recorded', async () => {
    const { fiber, store } = await boot(undefined, { exploration: 0.2, instructionWeight: 0.2 })
    try {
      await store.recordInstruction(instruction({ operator: 'compose', instruction: 'Merge each pair of overlapping rules into one that states both.' }))
      await store.judgeInstruction(verdict({ operator: 'compose', reason: 'the merged rule kept both behaviors' }))
      await store.recordInstruction(instruction({ operator: 'rewrite' }))
      await store.judgeInstruction(verdict({ accepted: false }))
      const ranked = store.ranking('writer')
      expect(ranked[0]?.operator).toBe('compose')
      expect(ranked[0]?.instructionAdjustment).toBeCloseTo(0.2, 10)
      expect(ranked.find(entry => entry.operator === 'rewrite')?.instructionAdjustment).toBeCloseTo(-0.2, 10)
      expect(store.recommend('writer')?.operator).toBe('compose')
      expect(store.recommendedInstruction('writer')).toMatchObject({
        operator: 'compose',
        instruction: 'Merge each pair of overlapping rules into one that states both.',
        lastVerdict: 'the merged rule kept both behaviors',
      })
      // A class whose leader holds no proposal recommends no instruction.
      expect(store.recommendedInstruction('ghost')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.record(outcome())
      await first.store.record(outcome({ accepted: false, delta: -1 }))
      await first.store.recordInstruction(instruction())
      await first.store.judgeInstruction(verdict())
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.stats()).toHaveLength(1)
      expect(second.store.stats('writer')[0]).toMatchObject({ attempts: 2, accepted: 1 })
      expect(second.store.recommend('writer')?.operator).toBe('rewrite')
      expect(second.store.instruction('rewrite', 'writer')).toMatchObject({ accepted: 1, proposals: 1 })
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionOperators(ctx, { exploration: 0.2 })
    expect(() => store.stats()).toThrow('not started yet')
    expect(() => store.ranking('writer')).toThrow('not started yet')
    expect(() => store.recommend('writer')).toThrow('not started yet')
    expect(() => store.instruction('rewrite', 'writer')).toThrow('not started yet')
    expect(() => store.instructions()).toThrow('not started yet')
    expect(() => store.recommendedInstruction('writer')).toThrow('not started yet')
  })
})
