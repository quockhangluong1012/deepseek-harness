import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionRetrieval, { configurationKey, resolveConfig } from '../src/index.ts'
import type { RetrievalConfiguration } from '../src/index.ts'

const configuration = (overrides: Partial<RetrievalConfiguration> = {}): RetrievalConfiguration => ({
  source: 'hybrid',
  queryExpansion: 'graph-entities',
  weights: { vector: 1, graph: 1 },
  reranker: 'none',
  mmr: { enabled: false, lambda: 1 },
  memoryScope: 'workspace',
  graphDepth: 1,
  threshold: 0.7,
  ...overrides,
})

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionRetrieval, config ?? {})
  return { ctx, fiber, store: ctx.evolutionRetrieval }
}

/** Skill-telemetry seam double: one skill per entry, as the store records them. */
function provideTelemetry(ctx: Context, entries: readonly { name: string; sessionIds?: readonly string[]; outcomes?: readonly { sessionId: string; outcome: 'ok' | 'failed' }[] }[]): void {
  ctx.provide('evolutionSkillTelemetry', {
    entries: () => entries.map(entry => ({
      name: entry.name,
      usage: { sessionIds: entry.sessionIds ?? [], sessionOutcomes: entry.outcomes ?? [] },
    })),
  } as never)
}

/** Feedback seam double: the sessions it grades with an attributable failure. */
function provideFeedback(ctx: Context, failed: readonly string[]): void {
  ctx.provide('evolutionFeedback', {
    signals: (sessionIds: readonly string[]) => [{
      evidenceStatus: failed.includes(String(sessionIds[0])) ? 'complete' : 'actionable_partial',
    }],
  } as never)
}

describe('retrieval configuration store', () => {
  it('resolves the evidence gate', () => {
    expect(resolveConfig({})).toEqual({ minimumSessions: 5 })
    expect(resolveConfig({ minimumSessions: 2 })).toEqual({ minimumSessions: 2 })
  })

  it('records one attribution per session and configuration, detached and newest first', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.record({ configuration: configuration(), sessionId: 's1' })
      await store.record({ configuration: configuration({ graphDepth: 2 }), sessionId: 's2' })
      expect(first.configKey).toBe(configurationKey(configuration()))
      expect(store.attributions()).toHaveLength(2)
      expect(store.attributions(first.configKey)).toHaveLength(1)
      expect(store.attributions('ghost')).toEqual([])
      const rows = store.attributions()
      ;(rows[0] as { sessionId: string }).sessionId = 'mutated'
      expect(store.attributions().map(row => row.sessionId)).not.toContain('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('does not double-count a session recorded twice under one configuration', async () => {
    const { ctx, fiber, store } = await boot()
    try {
      provideTelemetry(ctx, [{ name: 'writer', sessionIds: ['s1'], outcomes: [{ sessionId: 's1', outcome: 'ok' }] }])
      const first = await store.record({ configuration: configuration(), sessionId: 's1' })
      const second = await store.record({ configuration: configuration(), sessionId: 's1' })
      expect(second.at).toBe(first.at)
      expect(store.attributions()).toHaveLength(1)
      expect(store.effectiveness('writer')).toMatchObject([{ samples: 1, passes: 1, successRate: 1 }])
    } finally {
      await fiber.dispose()
    }
  })

  it('derives effectiveness from the graded skill outcomes and the feedback store', async () => {
    const { ctx, fiber, store } = await boot()
    try {
      provideTelemetry(ctx, [
        { name: 'writer', sessionIds: ['s1'], outcomes: [{ sessionId: 's1', outcome: 'ok' }] },
        { name: 'polish', sessionIds: ['s2'] },
        { name: 'unused', sessionIds: ['s9'] },
      ])
      provideFeedback(ctx, ['s2'])
      const key = configurationKey(configuration())
      await store.record({ configuration: configuration(), sessionId: 's1' })
      await store.record({ configuration: configuration(), sessionId: 's2' })
      await store.record({ configuration: configuration(), sessionId: 's3' })
      expect(store.effectiveness()).toEqual([
        { configKey: key, configuration: configuration(), taskClass: 'polish', samples: 1, passes: 0, successRate: 0, lastAt: expect.any(String) as unknown },
        { configKey: key, configuration: configuration(), taskClass: 'writer', samples: 1, passes: 1, successRate: 1, lastAt: expect.any(String) as unknown },
      ])
      expect(store.effectiveness('ghost')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('derives nothing while neither evidence store is mounted', async () => {
    const { fiber, store } = await boot()
    try {
      await store.record({ configuration: configuration(), sessionId: 's1' })
      expect(store.effectiveness()).toEqual([])
      expect(store.recommend('writer')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends the configuration whose sessions succeeded, and nothing below the gate', async () => {
    const { ctx, fiber, store } = await boot(undefined, { minimumSessions: 2 })
    try {
      provideTelemetry(ctx, [{
        name: 'writer',
        sessionIds: ['a1', 'a2', 'b1', 'b2'],
        outcomes: [
          { sessionId: 'a1', outcome: 'ok' },
          { sessionId: 'a2', outcome: 'ok' },
          { sessionId: 'b1', outcome: 'ok' },
          { sessionId: 'b2', outcome: 'failed' },
        ],
      }])
      const better = configuration({ graphDepth: 2 })
      const worse = configuration({ graphDepth: 3 })
      for (const sessionId of ['a1', 'a2']) await store.record({ configuration: better, sessionId })
      for (const sessionId of ['b1', 'b2']) await store.record({ configuration: worse, sessionId })
      expect(store.recommend('writer')).toMatchObject({
        configKey: configurationKey(better),
        samples: 2,
        passes: 2,
        reason: '2/2 graded sessions succeeded (1.00), score 0.750',
      })
      expect(store.recommend('ghost')).toBeUndefined()
      // The worse configuration loses on measured task success, not on how its retrieval scored.
      expect(store.effectiveness()).toMatchObject([
        { configKey: configurationKey(better), passes: 2 },
        { configKey: configurationKey(worse), passes: 1 },
      ])
      await store.record({ configuration: configuration({ graphDepth: 9 }), sessionId: 'c1' })
      expect(store.recommend('writer')?.configKey).toBe(configurationKey(better))
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    const stored = await first.store.record({ configuration: configuration({ threshold: 0.5 }), sessionId: 's1' })
    await first.fiber.dispose()

    const second = await boot(backend)
    try {
      expect(second.store.attributions()).toEqual([stored])
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionRetrieval(ctx, {})
    expect(() => store.attributions()).toThrow('not started yet')
  })
})
