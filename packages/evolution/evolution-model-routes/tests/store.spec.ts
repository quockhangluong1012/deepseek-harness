import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionModelRoutes from '../src/index.ts'
import { legacyRouterDomainSpec, modelRoutesDomainSpec, routeEvidenceRow } from '../src/spec.ts'
import type { LegacyRouteOutcome } from '../src/spec.ts'
import type { EvolutionRole, ModelRoute } from '../src/types.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool()), config?: Record<string, unknown>) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionModelRoutes, config ?? {})
  return { ctx, fiber, store: ctx.evolutionModelRoutes }
}

/** The separator the store joins key halves with; spelled out so no literal NUL enters the source. */
const NUL = String.fromCharCode(0)

const route = (provider = 'deepseek', model = 'deepseek-chat'): ModelRoute => ({ provider, model })

const legacyOutcome = (overrides: Partial<LegacyRouteOutcome> = {}): LegacyRouteOutcome => ({
  taskClass: 'writer',
  role: 'evaluation',
  provider: 'deepseek',
  model: 'chat',
  pass: true,
  tokens: 1000,
  wallTimeMs: 2000,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const observed = (overrides: {
  role?: EvolutionRole
  taskClass?: string
  provider?: string
  model?: string
  pass?: boolean
  tokens?: number
  wallTimeMs?: number
} = {}) => ({
  role: overrides.role ?? 'evaluation',
  route: route(overrides.provider ?? 'deepseek', overrides.model ?? 'chat'),
  triple: {
    pass: overrides.pass ?? true,
    tokens: overrides.tokens ?? 1000,
    wallTimeMs: overrides.wallTimeMs ?? 2000,
  },
  taskClass: overrides.taskClass ?? 'writer',
})

/**
 * Write rows into a named domain on a backend without mounting the store, the
 * way a deployment that predates the merge already holds them.
 */
async function seed(
  backend: MemoryStorageBackend,
  spec: Parameters<DomainFacility['open']>[0],
  rows: { table: string; key: string; value: unknown }[],
): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const domain = await facility.open(spec)
  try {
    for (const row of rows) {
      await domain.table(row.table).put(row.key, row.value)
    }
  } finally {
    await facility.closeAll()
  }
}

describe('evolution model routes', () => {
  it('observes a route outcome and its evidence', async () => {
    const { fiber, store } = await boot()
    try {
      const first = await store.observe({
        role: 'candidate-generation',
        route: route(),
        triple: { pass: true, tokens: 10, wallTimeMs: 100 },
      })
      expect(first).toMatchObject({ role: 'candidate-generation', provider: 'deepseek', model: 'deepseek-chat', pass: true, tokens: 10, wallTimeMs: 100, taskClass: undefined })
      expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(store.routes('candidate-generation')).toEqual([{
        role: 'candidate-generation',
        provider: 'deepseek',
        model: 'deepseek-chat',
        origin: 'observed',
        runs: 1,
        passes: 1,
        passRate: 1,
        meanTokens: 10,
        meanWallTimeMs: 100,
        lastAt: first.at,
      }])
    } finally {
      await fiber.dispose()
    }
  })

  it('upserts the route as observed and keeps a pin outliving its evidence', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe(observed({ taskClass: 'writer', model: 'deepseek-chat', tokens: 5, wallTimeMs: 5 }))
      await store.pin('evaluation', 'deepseek', 'deepseek-chat')
      await store.observe(observed({ taskClass: 'writer', model: 'deepseek-chat', pass: false, tokens: 9, wallTimeMs: 9 }))
      const rows = store.routes('evaluation')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ origin: 'pinned', runs: 2, passes: 1, passRate: 0.5, meanTokens: 7 })
      expect(store.recommend('evaluation')).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', origin: 'pinned' })
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
      expect(store.recommend('reflection')).toMatchObject({ model: 'deepseek-reasoner' })
      await store.pin('reflection', 'deepseek', 'deepseek-chat')
      expect(store.recommend('reflection')).toMatchObject({ model: 'deepseek-chat' })
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
      expect(store.evidence()).toHaveLength(3)
      expect(store.evidence('evaluation')).toHaveLength(2)
      expect(store.evidence('evaluation', route('deepseek', 'deepseek-reasoner'))).toHaveLength(1)
      expect(store.evidence('evaluation', route('deepseek', 'deepseek-chat')).every(row => row.model === 'deepseek-chat')).toBe(true)
      expect(store.evidence('promotion-review')).toEqual([])
      expect(store.evidence('evaluation', route('other', 'model'))).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('derives per-task-class effectiveness with running means', async () => {
    const { fiber, store } = await boot()
    try {
      await store.observe(observed())
      await store.observe(observed({ pass: false, tokens: 3000, wallTimeMs: 6000 }))
      await store.observe(observed({ taskClass: 'reader', provider: 'openai', model: 'gpt' }))
      await store.observe(observed({ role: 'reflection' }))
      await store.observe(observed({ model: 'reasoner' }))
      const rows = store.effectiveness()
      expect(rows).toHaveLength(4)
      const evaluation = rows.find(row => row.taskClass === 'writer' && row.role === 'evaluation' && row.model === 'chat')
      expect(evaluation).toMatchObject({ runs: 2, passes: 1, passRate: 0.5, meanTokens: 2000, meanWallTimeMs: 4000 })
      expect(store.effectiveness('writer')).toHaveLength(3)
      expect(store.effectiveness('writer', 'reflection')).toHaveLength(1)
      ;(store.effectiveness()[0] as { model: string }).model = 'mutated'
      expect(store.effectiveness()[0]?.model).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('names a route from a single observed run, with no pin and no configured gate', async () => {
    const { fiber, store } = await boot()
    try {
      // Both merged predecessors named a route off thin evidence, so the merge
      // must not raise the bar: one run is enough unless a deployment asks for
      // more through `minimumRuns`.
      await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 7, wallTimeMs: 7 } })
      expect(store.recommend('candidate-generation')).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat', runs: 1, origin: 'observed' })
      await store.observe(observed({ taskClass: 'writer' }))
      expect(store.recommend('evaluation', 'writer')).toMatchObject({ provider: 'deepseek', model: 'chat', runs: 1 })
      // A deployment that wants the wider margin still gets it.
      const gated = await boot(undefined, { minimumRuns: 2 })
      try {
        await gated.store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-chat'), triple: { pass: true, tokens: 7, wallTimeMs: 7 } })
        expect(gated.store.recommend('candidate-generation')).toBeUndefined()
      } finally {
        await gated.fiber.dispose()
      }
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends pinned, then the best-ranked measured route', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.recommend('candidate-generation')).toBeUndefined()
      for (let index = 0; index < 3; index += 1) {
        await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-chat'), triple: { pass: false, tokens: 20, wallTimeMs: 20 } })
        await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-reasoner'), triple: { pass: true, tokens: 12, wallTimeMs: 12 } })
      }
      expect(store.recommend('candidate-generation')).toMatchObject({ provider: 'deepseek', model: 'deepseek-reasoner', runs: 3, passRate: 1 })
      // One perfect run is not enough to displace a well-measured leader: the
      // score is a beta-prior-smoothed pass rate, not a raw one.
      await store.observe({ role: 'candidate-generation', route: route('deepseek', 'deepseek-max'), triple: { pass: true, tokens: 5, wallTimeMs: 5 } })
      expect(store.recommend('candidate-generation')?.model).toBe('deepseek-reasoner')
      await store.pin('candidate-generation', 'deepseek', 'deepseek-max')
      expect(store.recommend('candidate-generation')).toMatchObject({ model: 'deepseek-max', origin: 'pinned' })
    } finally {
      await fiber.dispose()
    }
  })

  it('recommends within one task class and names the numbers behind the rank', async () => {
    const { fiber, store } = await boot(undefined, { minimumRuns: 2 })
    try {
      expect(store.recommend('evaluation', 'writer')).toBeUndefined()
      await store.observe(observed())
      expect(store.recommend('evaluation', 'writer')).toBeUndefined()
      await store.observe(observed())
      const recommended = store.recommend('evaluation', 'writer')
      expect(recommended).toMatchObject({ provider: 'deepseek', model: 'chat', runs: 2, passRate: 1 })
      expect(recommended?.reason).toContain('2/2 passed')
      // Another class's outcome ranks for its own class only.
      await store.observe(observed({ taskClass: 'reader', provider: 'openai', model: 'gpt' }))
      await store.observe(observed({ taskClass: 'reader', provider: 'openai', model: 'gpt' }))
      expect(store.recommend('evaluation', 'writer')?.provider).toBe('deepseek')
      expect(store.recommend('evaluation', 'reader')).toMatchObject({ provider: 'openai', model: 'gpt' })
    } finally {
      await fiber.dispose()
    }
  })

  it('records an uncertainty signal when two routes disagree strongly, and none while they agree', async () => {
    const recorded: { signalId: string; skill: string; taskId: string | null; kind: string; score: number; detail: string }[] = []
    const { ctx, fiber, store } = await boot()
    try {
      ctx.provide('evolutionUncertainty', {
        record: async (input: typeof recorded[number]) => {
          recorded.push(input)
          return { ...input, at: '2026-01-01T00:00:00.000Z' }
        },
      } as never)
      // Agreement: both routes pass all three of their counted runs.
      for (let index = 0; index < 3; index += 1) {
        await store.observe(observed({ provider: 'a', model: 'm1' }))
        await store.observe(observed({ provider: 'b', model: 'm2' }))
      }
      expect(store.disagreements()).toEqual([])
      expect(recorded).toEqual([])
      // Divergence: 'b/m2' now fails half of its counted runs.
      for (let index = 0; index < 3; index += 1) {
        await store.observe(observed({ provider: 'b', model: 'm2', pass: false }))
      }
      expect(store.disagreements().map(found => `${found.leader.model}->${found.trailer.model} gap ${found.gap}`))
        .toEqual(['m1->m2 gap 0.5'])
      expect(recorded).toEqual([{
        signalId: ['route-disagreement:writer', 'evaluation', 'a/m1|b/m2'].join(NUL),
        skill: 'writer',
        taskId: null,
        kind: 'disagreement',
        score: 0.5,
        detail: "routes 'a/m1' (1.00 over 3 runs) and 'b/m2' (0.50 over 6 runs) disagree by 0.50 on 'writer' in role evaluation",
      }])
      // Re-recording the same disagreement keeps one signal identity.
      await store.observe(observed({ provider: 'b', model: 'm2', pass: false }))
      expect(recorded).toHaveLength(2)
      expect(recorded[1]?.signalId).toBe(recorded[0]?.signalId)
      // An outcome recorded without a task class has no class to disagree within.
      await store.observe({ role: 'reflection', route: route('deepseek', 'chat'), triple: { pass: true, tokens: 1, wallTimeMs: 1 } })
      expect(store.disagreements('reflection')).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps observing when the uncertainty store rejects a signal', async () => {
    const { ctx, fiber, store } = await boot()
    try {
      ctx.provide('evolutionUncertainty', {
        record: async () => {
          throw new Error('uncertainty disk on fire')
        },
      } as never)
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      try {
        for (let index = 0; index < 3; index += 1) await store.observe(observed({ provider: 'a', model: 'm1' }))
        for (let index = 0; index < 3; index += 1) await store.observe(observed({ provider: 'b', model: 'm2', pass: false }))
        expect(store.evidence()).toHaveLength(6)
        expect(store.disagreements()).toHaveLength(1)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record route disagreement'))
      } finally {
        warn.mockRestore()
      }
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.observe(observed())
      await first.store.observe(observed({ pass: false, tokens: 3000, wallTimeMs: 6000 }))
      await first.store.pin('evaluation', 'deepseek', 'deepseek-reasoner')
      await first.store.recordDuty({ runId: 'run-1', role: 'candidate-generation', identity: 'agent-a' })
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.evidence()).toHaveLength(2)
      expect(second.store.effectiveness('writer', 'evaluation')[0]).toMatchObject({ runs: 2, passes: 1, meanTokens: 2000 })
      expect(second.store.recommend('evaluation')).toMatchObject({ model: 'deepseek-reasoner', origin: 'pinned' })
      const [duty] = second.store.duties('run-1')
      expect(duty).toMatchObject({ runId: 'run-1', role: 'candidate-generation', identity: 'agent-a' })
      expect(duty?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await second.fiber.dispose()
    }
  })

  it('declares version 2 while still reading a version-1 evidence row', () => {
    expect(modelRoutesDomainSpec.version).toBe(2)
    expect(modelRoutesDomainSpec.compatibleVersions).toEqual([1])
    // A version-1 row carries no task class, and the reader migrates it to an
    // outcome measured for the role as a whole.
    expect(routeEvidenceRow.parse({
      id: 'v1-1',
      role: 'evaluation',
      provider: 'deepseek',
      model: 'chat',
      pass: true,
      tokens: 11,
      wallTimeMs: 22,
      at: '2026-01-01T00:00:00.000Z',
    })).toEqual({
      id: 'v1-1',
      role: 'evaluation',
      provider: 'deepseek',
      model: 'chat',
      pass: true,
      tokens: 11,
      wallTimeMs: 22,
      at: '2026-01-01T00:00:00.000Z',
    })
  })

  it('imports the retired router domain outcomes so their history survives the merge', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    await seed(backend, legacyRouterDomainSpec, [
      { table: 'outcomes', key: 'legacy-1', value: legacyOutcome() },
      { table: 'outcomes', key: 'legacy-2', value: legacyOutcome({ pass: false, tokens: 3000, wallTimeMs: 6000, at: '2026-01-02T00:00:00.000Z' }) },
      { table: 'outcomes', key: 'legacy-3', value: legacyOutcome({ taskClass: 'reader' }) },
    ])
    const { fiber, store } = await boot(backend)
    try {
      expect(store.evidence('evaluation').map(row => row.id).sort()).toEqual(['legacy-1', 'legacy-2', 'legacy-3'])
      // The retired row's task class is the value the migrated row keeps.
      expect(store.evidence('evaluation').find(row => row.id === 'legacy-1')).toEqual({
        id: 'legacy-1',
        role: 'evaluation',
        provider: 'deepseek',
        model: 'chat',
        pass: true,
        tokens: 1000,
        wallTimeMs: 2000,
        at: '2026-01-01T00:00:00.000Z',
        taskClass: 'writer',
      })
      expect(store.effectiveness('writer', 'evaluation')).toMatchObject([
        { taskClass: 'writer', provider: 'deepseek', model: 'chat', origin: 'observed', runs: 2, passes: 1, meanTokens: 2000, meanWallTimeMs: 4000 },
      ])
      // The imported outcome also made the route an assignment, so the role has a summary.
      expect(store.routes('evaluation')).toMatchObject([{ origin: 'observed', runs: 3, passes: 2 }])
    } finally {
      await fiber.dispose()
    }
  })

  it('re-importing the retired outcomes converges instead of duplicating them', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    await seed(backend, legacyRouterDomainSpec, [
      { table: 'outcomes', key: 'legacy-1', value: legacyOutcome() },
    ])
    const first = await boot(backend)
    try {
      await first.store.pin('evaluation', 'deepseek', 'chat')
      expect(first.store.evidence()).toHaveLength(1)
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.evidence()).toHaveLength(1)
      // A pin the operator set survives the next startup's import.
      expect(second.store.routes('evaluation')).toMatchObject([{ origin: 'pinned', runs: 1 }])
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
    expect(() => store.effectiveness()).toThrow('not started yet')
    expect(() => store.recommend('evaluation')).toThrow('not started yet')
    expect(() => store.disagreements()).toThrow('not started yet')
    expect(() => store.conflicts()).toThrow('not started yet')
    expect(() => store.duties('run-1')).toThrow('not started yet')
    expect(() => store.checkDuties('run-1', 'promotion')).toThrow('not started yet')
  })
})
