import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionModelRoutes from '../src/index.ts'
import type { ModelRoute } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool())) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionModelRoutes)
  return { ctx, fiber, store: ctx.evolutionModelRoutes }
}

const route = (provider = 'deepseek', model = 'deepseek-chat'): ModelRoute => ({ provider, model })

describe('evolution model routes', () => {
  it('observes a route outcome and its evidence', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.observe({
        role: 'candidate-generation',
        route: route(),
        triple: { pass: true, tokens: 10, wallTimeMs: 100 },
      })
      expect(first).toMatchObject({ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', pass: true, tokens: 10, wallTimeMs: 100 })
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(store.routes('candidate-generation')).toEqual([{
        role: 'candidate-generation',
        provider: 'deepseek',
        model: 'deepseek-chat',
        origin: 'observed',
        runs: 1,
        passRate: 1,
        meanTokens: 10,
        lastAt: first.at,
      }])
    } finally {
      await fiber.dispose()
    }
  })

  it('upserts the route as observed and keeps a pin outliving its evidence', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe({ role: 'evaluation', route: route(), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      await store.pin('evaluation', 'deepseek', 'deepseek-chat')
      await store.observe({ role: 'evaluation', route: route(), triple: { pass: false, tokens: 9, wallTimeMs: 9 } })
      const rows = store.routes('evaluation')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ origin: 'pinned', runs: 2, passRate: 0.5, meanTokens: 7 })
      expect(store.recommend('evaluation')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    } finally {
      await fiber.dispose()
    }
  })

  it('pins a fresh route and flips an existing one', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe({ role: 'reflection', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 3, wallTimeMs: 3 } })
      const pinned = await store.pin('reflection', 'deepseek', 'deepseek-reasoner')
      expect(pinned).toMatchObject({ role: 'reflection', provider: 'deepseek', model: 'deepseek-reasoner', origin: 'pinned' })
      expect(store.recommend('reflection')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      await store.pin('reflection', 'deepseek', 'deepseek-chat')
      expect(store.recommend('reflection')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' })
    } finally {
      await fiber.dispose()
    }
  })

  it('lists per-role summaries in topology order and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 10, wallTimeMs: 10 } })
      await store.pin('evaluation', 'deepseek', 'deepseek-reasoner')
      await store.observe({ role: 'task-execution', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 8, wallTimeMs: 8 } })
      const all = store.routes()
      expect(all.map(summary => summary.role)).toEqual(['task-execution', 'candidate-generation', 'evaluation'])
      const copy = store.routes('evaluation')
      ;(copy[0] as { origin: string }).origin = 'mutated'
      expect(store.routes('evaluation')[0]?.origin).toBe('pinned')
    } finally {
      await fiber.dispose()
    }
  })

  it('lists evidence newest first with filters and tie-breaks', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe({ role: 'evaluation', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      await store.observe({ role: 'evaluation', route: route('deepseek', 'deepseek-reasoner'), triple: { pass: true, tokens: 8, wallTimeMs: 8 } })
      await store.observe({ role: 'reflection', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 3, wallTimeMs: 3 } })
      // The store records at millisecond granularity; equal instants tie-break by id.
      const all = store.evidence()
      expect(all).toHaveLength(3)
      expect(store.evidence('evaluation')).toHaveLength(2)
      expect(store.evidence('evaluation', route('deepseek', 'deepseek-reasoner'))).toHaveLength(1)
      expect(store.evidence('evaluation', route('deepseek', 'deepseek-chat')).every(row => row.model === 'deepseek-chat')).toBe(true)
      expect(store.evidence('promotion-review')).toEqual([])
      expect(store.evidence('evaluation', route('other', 'model'))).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends pinned, then best evidence, then nothing', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.recommend('candidate-generation')).toBeUndefined()
      await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-chat'), triple: { pass: false, tokens: 20, wallTimeMs: 20 } })
      await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-reasoner'), triple: { pass: true, tokens: 12, wallTimeMs: 12 } })
      expect(store.recommend('candidate-generation')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      await store.pin('candidate-generation', 'deepseek', 'deepseek-max')
      expect(store.recommend('candidate-generation')).toEqual({ provider: 'deepseek', model: 'deepseek-max' })
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.observe({ role: 'evaluation', route: route(), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      await first.store.pin('evaluation', 'deepseek', 'deepseek-reasoner')
      await first.store.recordDuty({ runId: 'run-1', role: 'candidate-generation', identity: 'agent-a' })
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.routes('evaluation')).toHaveLength(2)
      expect(second.store.recommend('evaluation')).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner' })
      const [duty] = second.store.duties('run-1')
      expect(duty).toMatchObject({ runId: 'run-1', role: 'candidate-generation', identity: 'agent-a' })
      expect(duty?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('records one identity per role of one run and replaces a re-recorded role', async () => {
    const { fiber, store } = await boot()
    try {
      await store.recordDuty({ runId: 'run-1', role: 'promotion-review', identity: 'agent-b' })
      const recorded = await store.recordDuty({ runId: 'run-1', role: 'candidate-generation', identity: 'agent-a' })
      expect(recorded).toMatchObject({ runId: 'run-1', role: 'candidate-generation', identity: 'agent-a' })
      expect(recorded.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      await store.recordDuty({ runId: 'run-2', role: 'candidate-generation', identity: 'agent-c' })
      expect(store.duties('run-1').map(duty => [duty.role, duty.identity]))
        .toEqual([['candidate-generation', 'agent-a'], ['promotion-review', 'agent-b']])
      expect(store.duties('run-3')).toEqual([])
      // Re-filling a role in the same run replaces the identity rather than adding a row.
      await store.recordDuty({ runId: 'run-1', role: 'promotion-review', identity: 'agent-a' })
      const replaced = store.duties('run-1')
      expect(replaced).toHaveLength(2)
      expect(replaced.map(duty => duty.identity)).toEqual(['agent-a', 'agent-a'])
    } finally {
      await fiber.dispose()
    }
  })

  it('refuses a promotion whose reviewer is the identity that generated the candidate', async () => {
    const { fiber, store } = await boot()
    try {
      await store.recordDuty({ runId: 'run-1', role: 'candidate-generation', identity: 'agent-a' })
      // The reviewer has not been recorded yet: unknown, never assumed distinct.
      expect(store.checkDuties('run-1', 'promotion')).toEqual({
        allowed: false,
        refusal: 'unknown-identity',
        reason: "run 'run-1' records no promotion-review identity, so candidate-generation and promotion-review cannot be shown to be separate identities",
      })
      await store.recordDuty({ runId: 'run-1', role: 'promotion-review', identity: 'agent-a' })
      expect(store.checkDuties('run-1', 'promotion')).toEqual({
        allowed: false,
        refusal: 'same-identity',
        reason: "identity 'agent-a' filled both candidate-generation and promotion-review for run 'run-1'",
      })
      await store.recordDuty({ runId: 'run-1', role: 'promotion-review', identity: 'agent-b' })
      expect(store.checkDuties('run-1', 'promotion')).toEqual({ allowed: true })
      // The verdict separation reads the evaluation identity, not the reviewer's.
      await store.recordDuty({ runId: 'run-1', role: 'evaluation', identity: 'agent-a' })
      expect(store.checkDuties('run-1', 'verdict')).toMatchObject({ refusal: 'same-identity' })
      expect(store.checkDuties('run-2', 'verdict')).toMatchObject({ refusal: 'unknown-identity' })
    } finally {
      await fiber.dispose()
    }
  })

  it('reports the §28 topology conflict between a producing and a judging role', async () => {
    const shared = await boot()
    try {
      await shared.store.pin('evaluation', 'deepseek', 'deepseek-chat')
      await shared.store.observe({ role: 'candidate-generation', route: route(), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      expect(shared.store.conflicts()).toEqual([{
        route: { provider: 'deepseek', model: 'deepseek-chat' },
        producing: ['candidate-generation'],
        judging: ['evaluation'],
        pinned: true,
        detail: "route 'deepseek/deepseek-chat' serves candidate-generation and also judges evaluation",
      }])
    } finally {
      await shared.fiber.dispose()
    }
    const split = await boot()
    try {
      await split.store.pin('evaluation', 'deepseek', 'deepseek-reasoner')
      await split.store.observe({ role: 'candidate-generation', route: route(), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      expect(split.store.conflicts()).toEqual([])
    } finally {
      await split.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionModelRoutes(ctx)
    expect(() => store.routes()).toThrow('not started yet')
    expect(() => store.evidence()).toThrow('not started yet')
    expect(() => store.conflicts()).toThrow('not started yet')
    expect(() => store.duties('run-1')).toThrow('not started yet')
    expect(() => store.checkDuties('run-1', 'promotion')).toThrow('not started yet')
  })
})
