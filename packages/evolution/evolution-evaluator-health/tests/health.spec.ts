import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionEvaluatorHealth, { resolveConfig } from '../src/index.ts'
import type { EvaluatorRunInput } from '../src/index.ts'

async function boot(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionEvaluatorHealth, config)
  return { fiber, store: ctx.evolutionEvaluatorHealth }
}

const input = (overrides: Partial<EvaluatorRunInput> = {}): EvaluatorRunInput => ({
  skill: 'writer',
  unanimous: true,
  status: 'evaluated',
  approved: true,
  approving: ['contract', 'routing', 'replay'],
  dissenting: [],
  ...overrides,
})

describe('evolution evaluator health', () => {
  it('resolves the drift window', () => {
    expect(resolveConfig({})).toEqual({ driftWindow: 20 })
    expect(resolveConfig({ driftWindow: 5 })).toEqual({ driftWindow: 5 })
  })

  it('records verdicts and lists with a skill filter', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.observe(input())
      const rejected = await store.observe(input({ approved: false, unanimous: false, dissenting: ['replay'], approving: [] }))
      const polish = await store.observe(input({ skill: 'polish', approved: false, unanimous: false, dissenting: ['routing', 'replay', 'contract'], approving: [] }))
      const all = store.runs()
      expect(all).toHaveLength(3)
      // Every recorded id is present, newest first when timestamps differ.
      expect(new Set(all.map(run => run.id))).toEqual(new Set([first.id, rejected.id, polish.id]))
      expect(all[0]?.at >= all[2]?.at).toBe(true)
      expect(store.runs('polish')).toHaveLength(1)
      // Detached copies.
      const rows = store.runs('polish')
      ;(rows[0] as { skill: string }).skill = 'mutated'
      expect(store.runs('polish')[0]?.skill).toBe('polish')
    } finally {
      await fiber.dispose()
    }
  })

  it('rejects a skipped evaluation and summarizes recorded verdicts', async () => {
    const { fiber, store } = await boot({ driftWindow: 2 })
    try {
      await expect(store.observe(input({ status: 'skipped' as never }))).rejects.toThrow('no health verdict')
      const empty = store.summary()
      expect(empty.runs).toBe(0)
      await store.observe(input({ approved: true }))
      await store.observe(input({ approved: false, unanimous: false, dissenting: ['replay'], approving: [] }))
      const summary = store.summary()
      expect(summary.runs).toBe(2)
      expect(summary.approvalRate).toBeCloseTo(1 / 2)
      expect(summary.recentApprovalRate).toBeCloseTo(1 / 2)
      expect(summary.channels[2]).toMatchObject({ channel: 'replay', approved: 1 })
    } finally {
      await fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionEvaluatorHealth(ctx, {})
    expect(() => store.runs()).toThrow('not started yet')
  })
})
