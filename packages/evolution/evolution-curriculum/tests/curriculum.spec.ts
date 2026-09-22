import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionCurriculum, { resolveConfig } from '../src/index.ts'
import type { CurriculumGap, CurriculumProposal } from '../src/index.ts'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { LearningTraceRow } from '@deepseek-ai/dsh-evolution-trace'

async function boot(config: Record<string, unknown> = {}, seams: {
  telemetry?: { entries(): { name: string; usage: SkillUsageRecord }[] }
  trace?: { summary(sessionIds: readonly string[], limit: number): Promise<readonly LearningTraceRow[]> }
} = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  if (seams.telemetry !== undefined) ctx.provide('evolutionSkillTelemetry', seams.telemetry)
  if (seams.trace !== undefined) ctx.provide('evolutionTrace', seams.trace)
  const fiber = await ctx.plugin(EvolutionCurriculum, config)
  return { ctx, fiber, store: ctx.evolutionCurriculum }
}

/** One tracked-skill usage record stub; sessions are all the service reads. */
function usageRecord(sessionIds: string[]): SkillUsageRecord {
  return {
    useCount: 0,
    viewCount: 0,
    patchCount: 0,
    lastUsedAt: null,
    sessionIds,
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: 't0',
    state: 'active',
    pinned: false,
    createdBy: null,
    absorbedInto: null,
    archivedAt: null,
    trust: 'trusted',
    trustFailures: 0,
    trustObservedSessions: [],
    trustAnchorSessionId: null,
    lastTrustFailure: null,
    revision: 0,
    contentSha: null,
    parentRevisionSha: null,
  }
}

/** One compressed trace row stub carrying the given failure gists. */
function traceRow(gists: string[]): LearningTraceRow {
  return {
    sessionId: 's1',
    turns: 1,
    calls: 1,
    failures: gists.length,
    retries: 0,
    tokens: 0,
    latencyMs: 0,
    failureGists: gists,
    updatedAt: 't1',
  }
}

const gap = (capability: string, gists: readonly string[], sessions = 2): CurriculumGap => ({
  capability,
  sourceSessions: sessions === 0 ? [] : Array.from({ length: sessions }, (_, i) => `s${i}`),
  failureGists: gists,
})

describe('evolution curriculum', () => {
  it('resolves the evidence floor', () => {
    expect(resolveConfig({})).toEqual({ minGists: 1 })
    expect(resolveConfig({ minGists: 2 })).toEqual({ minGists: 2 })
  })

  it('stages one durable proposal per evidenced gap and lists open first', async () => {
    const { fiber, store } = await boot()
    try {
      const staged = await store.propose([
        gap('writer', ['boom'], 1),
        gap('polish', ['stale context'], 2),
      ])
      expect(staged).toHaveLength(2)
      expect(staged[0]?.capability).toBe('polish')
      expect(staged[0]).toMatchObject({ state: 'open', task: expect.stringContaining("'stale context'") as string })
      const listed = store.proposals()
      expect(listed).toHaveLength(2)
      expect(listed[0]?.id).toBe(staged[0]?.id)
      expect(listed[0]?.gists).toEqual(['stale context'])
    } finally {
      await fiber.dispose()
    }
  })

  it('skips proposals already open for the same capability and task', async () => {
    const { fiber, store } = await boot()
    try {
      await store.propose([gap('writer', ['boom'])])
      const again = await store.propose([gap('writer', ['boom'])])
      expect(again).toEqual([])
      expect(store.proposals()).toHaveLength(1)
      // A different task for the same capability still stages.
      const other = await store.propose([gap('writer', ['stale context'])])
      expect(other).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('enforces the evidence floor and retires proposals', async () => {
    const { fiber, store } = await boot({ minGists: 2 })
    try {
      const staged = await store.propose([
        gap('writer', ['single']),
        gap('polish', ['a', 'b']),
      ])
      expect(staged.map(p => p.capability)).toEqual(['polish'])
      const id = staged[0]?.id as string
      expect(store.proposals()[0]?.state).toBe('open')
      const retired = await store.retire(id)
      expect(retired.state).toBe('retired')
      await expect(store.retire(id)).resolves.toMatchObject({ state: 'retired' })
      await expect(store.retire('ghost')).rejects.toThrow("unknown proposal 'ghost'")
      const listed = store.proposals()
      expect(listed[0]?.state).toBe('retired')
    } finally {
      await fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionCurriculum(ctx, {})
    expect(() => store.proposals()).toThrow('not started yet')
  })

  it('measures gaps from telemetry and trace rows when both seams are mounted', async () => {
    const { fiber, store } = await boot({}, {
      telemetry: {
        entries: () => [
          { name: 'writer', usage: usageRecord(['s1', 's2']) },
          { name: 'idle', usage: usageRecord([]) },
        ],
      },
      trace: {
        summary: async (sessionIds: readonly string[]) => sessionIds.length === 0
          ? []
          : [traceRow(['boom', 'stale context']), traceRow(['boom'])],
      },
    })
    try {
      const gaps = await store.gaps()
      expect(gaps).toEqual([{
        capability: 'writer',
        sourceSessions: ['s1', 's2'],
        failureGists: ['boom', 'stale context'],
      }])
    } finally {
      await fiber.dispose()
    }
  })

  it('measures no gaps when either seam is missing', async () => {
    const { fiber, store } = await boot()
    try {
      expect(await store.gaps()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('skips skills whose traces carry no failure gists', async () => {
    const { fiber, store } = await boot({}, {
      telemetry: { entries: () => [{ name: 'clean', usage: usageRecord(['s9']) }] },
      trace: { summary: async () => [traceRow([])] },
    })
    try {
      expect(await store.gaps()).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('stages proposals derived from measured gaps in one pass', async () => {
    const { fiber, store } = await boot({}, {
      telemetry: { entries: () => [{ name: 'writer', usage: usageRecord(['s1']) }] },
      trace: { summary: async () => [traceRow(['boom'])] },
    })
    try {
      const gaps = await store.gaps()
      const staged = await store.propose(gaps)
      expect(staged).toHaveLength(1)
      expect(staged[0]?.capability).toBe('writer')
      expect((staged[0] as CurriculumProposal).gists).toEqual(['boom'])
    } finally {
      await fiber.dispose()
    }
  })
})
