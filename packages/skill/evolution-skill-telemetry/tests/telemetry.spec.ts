import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionSkillTelemetry, { isExcludedSkillSource, resolveConfig, skillCreationEvidence, skillProposalMergeKey } from '../src/index.ts'

interface FakeSkill {
  name: string
  source: string
}

async function harness(sources: Record<string, string> = {}, config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const skills: FakeSkill[] = Object.entries(sources).map(([name, source]) => ({ name, source }))
  ctx.provide('skills', {
    list: async () => skills.map(skill => ({ ...skill })),
  } as never)
  const fiber = await ctx.plugin(EvolutionSkillTelemetry, config)
  return { ctx, fiber, store: ctx.evolutionSkillTelemetry }
}

describe('evolution skill telemetry', () => {
  it('resolves the correlation bound', () => {
    expect(resolveConfig({})).toEqual({ maxSessionIds: 20, trustPromotionSessions: 2 })
    expect(resolveConfig({ maxSessionIds: 3, trustPromotionSessions: 4 }))
      .toEqual({ maxSessionIds: 3, trustPromotionSessions: 4 })
  })

  it('correlates uses with their sessions, newest first', async () => {
    const { fiber, store } = await harness({ catalog: 'user-dsh' })
    try {
      expect((await store.markUsed('catalog', undefined, 'session-1'))?.sessionIds).toEqual(['session-1'])
      expect((await store.markUsed('catalog', undefined, 'session-2'))?.sessionIds).toEqual(['session-2', 'session-1'])
      // A repeat moves its session to the front instead of duplicating it.
      expect((await store.markUsed('catalog', undefined, 'session-1'))?.sessionIds).toEqual(['session-1', 'session-2'])
      // A caller with no session leaves the recorded list untouched.
      expect((await store.markUsed('catalog'))?.sessionIds).toEqual(['session-1', 'session-2'])
    } finally {
      await fiber.dispose()
    }
  })

  it('bounds the correlated session list', async () => {
    const { fiber, store } = await harness({ catalog: 'user-dsh' }, { maxSessionIds: 2 })
    try {
      await store.markUsed('catalog', undefined, 'session-1')
      await store.markUsed('catalog', undefined, 'session-2')
      const capped = await store.markUsed('catalog', undefined, 'session-3')
      expect(capped?.sessionIds).toEqual(['session-3', 'session-2'])
      expect(capped?.useCount).toBe(3)
    } finally {
      await fiber.dispose()
    }
  })

  it('classifies excluded sources', () => {
    expect(isExcludedSkillSource('bundled')).toBe(true)
    expect(isExcludedSkillSource('hub')).toBe(true)
    expect(isExcludedSkillSource('hub-community')).toBe(true)
    expect(isExcludedSkillSource('user-dsh')).toBe(false)
    expect(isExcludedSkillSource('project-dsh')).toBe(false)
    expect(isExcludedSkillSource('custom')).toBe(false)
  })

  it('reads absent skills as undefined', async () => {
    const { fiber, store } = await harness()
    expect(store.read('missing')).toBeUndefined()
    expect(store.entries()).toEqual([])
    await fiber.dispose()
  })

  it('counts uses, views, and patches with timestamps', async () => {
    const { fiber, store } = await harness({ catalog: 'user-dsh' })
    const used = await store.markUsed('catalog')
    expect(used).toMatchObject({ useCount: 1, viewCount: 0, patchCount: 0 })
    expect(typeof used?.createdAt).toBe('string')
    expect(typeof used?.lastUsedAt).toBe('string')
    expect(used?.lastViewedAt).toBeNull()
    const viewed = await store.markViewed('catalog')
    expect(viewed).toMatchObject({ useCount: 1, viewCount: 1 })
    expect(typeof viewed?.lastViewedAt).toBe('string')
    const patched = await store.markPatched('catalog')
    expect(patched).toMatchObject({ patchCount: 1 })
    expect(typeof patched?.lastPatchedAt).toBe('string')
    expect(store.entries()).toHaveLength(1)
    expect(store.entries()[0]).toMatchObject({ name: 'catalog' })
    await fiber.dispose()
  })

  it('tracks load outcomes and counts failures', async () => {
    const { fiber, store } = await harness({ catalog: 'user-dsh' })
    try {
      const failed = await store.markFailed('catalog')
      expect(failed).toMatchObject({ useCount: 0, failureCount: 1, lastOutcome: 'failed' })
      const used = await store.markUsed('catalog')
      expect(used).toMatchObject({ useCount: 1, failureCount: 1, lastOutcome: 'ok' })
      const failedAgain = await store.markFailed('catalog')
      expect(failedAgain).toMatchObject({ useCount: 1, failureCount: 2, lastOutcome: 'failed' })
    } finally {
      await fiber.dispose()
    }
  })

  it('correlates failed loads with their session', async () => {
    const { fiber, store } = await harness({ catalog: 'user-dsh' })
    try {
      expect((await store.markFailed('catalog', undefined, 'session-1'))?.sessionIds).toEqual(['session-1'])
      expect((await store.markFailed('catalog', undefined, 'session-2'))?.sessionIds).toEqual(['session-2', 'session-1'])
      // A caller with no session leaves the recorded list untouched.
      expect((await store.markFailed('catalog'))?.sessionIds).toEqual(['session-2', 'session-1'])
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps the load counters and the state across a reopen', async () => {
    const pool = new MemoryMediaPool()
    {
      const ctx = new Context()
      await ctx.plugin(Storage)
      ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
      const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
      ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      ctx.provide('skills', { list: async () => [{ name: 'catalog', source: 'user-dsh' }] } as never)
      const fiber = await ctx.plugin(EvolutionSkillTelemetry)
      await ctx.evolutionSkillTelemetry.markFailed('catalog')
      await ctx.evolutionSkillTelemetry.markFailed('catalog')
      await ctx.evolutionSkillTelemetry.markUsed('catalog')
      await ctx.evolutionSkillTelemetry.setState('catalog', 'suspect')
      await fiber.dispose()
    }
    const ctx = new Context()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    ctx.provide('skills', { list: async () => [{ name: 'catalog', source: 'user-dsh' }] } as never)
    const fiber = await ctx.plugin(EvolutionSkillTelemetry)
    try {
      expect(ctx.evolutionSkillTelemetry.read('catalog'))
        .toMatchObject({ state: 'suspect', failureCount: 2, lastOutcome: 'ok', useCount: 1 })
    } finally {
      await fiber.dispose()
    }
  })

  it('skips outcome writes for excluded sources', async () => {
    const { fiber, store } = await harness({ box: 'bundled' })
    try {
      expect(await store.markFailed('box')).toBeUndefined()
      expect(store.read('box')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })


  it('skips bundled and hub skills without writing', async () => {
    const { fiber, store } = await harness({ box: 'bundled', shared: 'hub-nightly' })
    expect(await store.markUsed('box')).toBeUndefined()
    expect(await store.markViewed('box', 'bundled')).toBeUndefined()
    expect(await store.markPatched('shared')).toBeUndefined()
    expect(store.read('box')).toBeUndefined()
    expect(store.read('shared')).toBeUndefined()
    expect(store.entries()).toEqual([])
    await fiber.dispose()
  })

  it('records unknown skills under a recordable source', async () => {
    const { fiber, store } = await harness()
    const record = await store.markUsed('ghost')
    expect(record).toMatchObject({ useCount: 1 })
    const failing = new Context()
    await failing.plugin(Storage)
    failing.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(failing, { backend: 'memory', routes: {} })
    failing.storage.mount('domain', facility)
    failing.provide('storageDomain', facility)
    failing.provide('skills', {
      list: async () => {
        throw new Error('catalog offline')
      },
    } as never)
    const other = await failing.plugin(EvolutionSkillTelemetry)
    try {
      expect(await failing.evolutionSkillTelemetry.markUsed('ghost')).toMatchObject({ useCount: 1 })
    } finally {
      await other.dispose()
    }
    await fiber.dispose()
  })

  it('marks background authorship once', async () => {
    const { fiber, store } = await harness()
    const first = await store.markAgentCreated('writer')
    expect(first.createdBy).toBe('agent')
    const second = await store.markAgentCreated('writer')
    expect(second).toEqual(first)
    await fiber.dispose()
  })

  it('adopts agent-created skills without resetting clocks', async () => {
    const { fiber, store } = await harness()
    await expect(store.markAdopted('ghost')).rejects.toThrow("has no record for 'ghost'")
    const seeded = await store.markAgentCreated('writer')
    const adopted = await store.markAdopted('writer')
    expect(adopted).toMatchObject({ createdBy: 'foreground' })
    expect(adopted.createdAt).toBe(seeded.createdAt)
    await expect(store.markAdopted('writer')).rejects.toThrow('without model authorship')
    await store.markUsed('plain')
    await expect(store.markAdopted('plain')).rejects.toThrow('without model authorship')
    await fiber.dispose()
  })

  it('tracks body revisions as a hash chain and resets trust on every edit', async () => {
    const { fiber, store } = await harness()
    try {
      const used = await store.markUsed('writer')
      expect(used).toMatchObject({ trust: 'trusted', revision: 0, contentSha: null, parentRevisionSha: null })
      const first = await store.markRevised('writer', 'body-1')
      expect(first).toMatchObject({
        revision: 1,
        parentRevisionSha: null,
        trust: 'provisional',
        contentSha: createHash('sha256').update('body-1').digest('hex'),
      })
      // The same bytes again is not a new revision.
      expect(await store.markRevised('writer', 'body-1')).toMatchObject({ revision: 1 })
      const second = await store.markRevised('writer', 'body-2')
      expect(second).toMatchObject({ revision: 2, parentRevisionSha: first?.contentSha })
      expect((await store.markPatched('writer'))?.trust).toBe('provisional')
    } finally {
      await fiber.dispose()
    }
  })

  it('promotes trust from sessions newer than the last demotion, and from nothing else', async () => {
    const { fiber, store } = await harness()
    try {
      await store.markUsed('writer', undefined, 's1')
      // An edit demotes the skill and anchors it at the newest session seen then.
      expect((await store.markPatched('writer'))?.trust).toBe('provisional')
      const before = await store.recordTrustObservation('writer', 'success', 's1')
      expect(before).toMatchObject({ trust: 'provisional', trustObservedSessions: [] })
      // A session the record never listed cannot count either.
      expect(await store.recordTrustObservation('writer', 'success', 'unknown'))
        .toMatchObject({ trust: 'provisional', trustObservedSessions: [] })
      await store.markUsed('writer', undefined, 's2')
      expect(await store.recordTrustObservation('writer', 'success', 's2'))
        .toMatchObject({ trust: 'provisional', trustObservedSessions: ['s2'] })
      // One session counts once, however many turns it loads the skill.
      expect(await store.recordTrustObservation('writer', 'success', 's2'))
        .toMatchObject({ trust: 'provisional', trustObservedSessions: ['s2'] })
      await store.markUsed('writer', undefined, 's3')
      expect(await store.recordTrustObservation('writer', 'success', 's3'))
        .toMatchObject({ trust: 'trusted', trustObservedSessions: ['s3', 's2'] })
      const demoted = await store.recordTrustObservation('writer', 'failure', 's3', {
        mergeKey: 'bash\u0000denied',
        message: 'denied',
        at: '2026-09-16T00:00:00.000Z',
      })
      expect(demoted).toMatchObject({
        trust: 'provisional',
        trustFailures: 1,
        trustObservedSessions: [],
        trustAnchorSessionId: 's3',
        lastTrustFailure: { mergeKey: 'bash\u0000denied', message: 'denied', at: '2026-09-16T00:00:00.000Z' },
      })
      // A failure reported without attribution keeps the last attributed one.
      expect(await store.recordTrustObservation('writer', 'failure', 's3'))
        .toMatchObject({ trustFailures: 2, lastTrustFailure: { mergeKey: 'bash\u0000denied' } })
    } finally {
      await fiber.dispose()
    }
  })

  it('seeds an unrecorded skill from its first success observation', async () => {
    const { fiber, store } = await harness()
    try {
      expect(await store.recordTrustObservation('ghost', 'success', 's1'))
        .toMatchObject({ trust: 'trusted', trustObservedSessions: ['s1'] })
    } finally {
      await fiber.dispose()
    }
  })

  it('skips trust and revision writes for excluded sources', async () => {
    const { fiber, store } = await harness({ box: 'bundled' })
    try {
      expect(await store.recordTrustObservation('box', 'success', 's1')).toBeUndefined()
      expect(await store.markRevised('box', 'body')).toBeUndefined()
      expect(store.read('box')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('drops records reporting whether one existed', async () => {
    const { fiber, store } = await harness()
    await store.markUsed('dust')
    expect(await store.drop('dust')).toBe(true)
    expect(store.read('dust')).toBeUndefined()
    expect(await store.drop('dust')).toBe(false)
    await fiber.dispose()
  })
  it('pins and unpins without rewriting unchanged state', async () => {
    const { fiber, store } = await harness()
    expect((await store.setPinned('keep', true)).pinned).toBe(true)
    expect((await store.setPinned('keep', true)).pinned).toBe(true)
    expect(store.read('keep')).toMatchObject({ pinned: true })
    expect((await store.setPinned('keep', false)).pinned).toBe(false)
    await fiber.dispose()
  })

  it('moves lifecycle states with archive and suspect stamps', async () => {
    const { fiber, store } = await harness()
    expect(await store.setState('old', 'active')).toMatchObject({ state: 'active', archivedAt: null, suspectAt: null })
    expect(await store.setState('old', 'stale')).toMatchObject({ state: 'stale', archivedAt: null, suspectAt: null })
    const archived = await store.setState('old', 'archived', 'umbrella')
    expect(archived).toMatchObject({ state: 'archived', absorbedInto: 'umbrella' })
    expect(typeof archived.archivedAt).toBe('string')
    const revived = await store.setState('old', 'active')
    expect(revived).toMatchObject({ state: 'active', absorbedInto: null, archivedAt: null, suspectAt: null })

    // The evidence rung stamps its own instant, keeps it while the state
    // holds, and clears it on the way out.
    const suspect = await store.setState('old', 'suspect')
    expect(typeof suspect.suspectAt).toBe('string')
    expect(await store.setState('old', 'suspect')).toMatchObject({ suspectAt: suspect.suspectAt })
    const quiet = await store.setState('old', 'active')
    expect(quiet).toMatchObject({ state: 'active', suspectAt: null })
    const archivedFromSuspect = await store.setState('old', 'suspect')
    expect(typeof archivedFromSuspect.suspectAt).toBe('string')
    expect(await store.setState('old', 'archived')).toMatchObject({ state: 'archived', suspectAt: null })
    await fiber.dispose()
  })
  it('counts skill-tool loads and ignores foreign tools', async () => {
    const { ctx, fiber, store } = await harness({ catalog: 'user-dsh' })
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const signal = new AbortController().signal
      const nameParam = { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'd' } as const
      ctx.tools.register(defineContentToolFixture({
        name: 'skill',
        description: 'd',
        parameters: { name: nameParam },
        execute: async () => [{ type: 'text' as const, text: 'body' }],
      }))
      ctx.tools.register(defineContentToolFixture({
        name: 'other',
        description: 'd',
        parameters: {},
        execute: async () => [{ type: 'text' as const, text: 'other' }],
      }))
      ctx.tools.register(defineContentToolFixture({
        name: 'broken',
        description: 'd',
        parameters: {},
        execute: async () => {
          throw new Error('tool offline')
        },
      }))
      await ctx.tools.execute({ callId: ToolCallId('c1'), name: 'other', arguments: {}, signal })
      await ctx.tools.execute({ callId: ToolCallId('c2'), name: 'broken', arguments: {}, signal })
      await ctx.tools.execute({ callId: ToolCallId('c3'), name: 'skill', arguments: { name: 'catalog' }, signal })
      await ctx.tools.execute({
        callId: ToolCallId('c5'),
        name: 'skill',
        arguments: { name: 'catalog' },
        signal,
        agent: { session: { id: 'session-9' } } as never,
      })
      await vi.waitFor(() => {
        expect(store.read('catalog')?.useCount).toBe(2)
      })
      expect(store.read('catalog')?.sessionIds).toEqual(['session-9'])
      expect(store.read('other')).toBeUndefined()
      expect(store.read('broken')).toBeUndefined()
      // A successful load without a skill name records nothing.
      await ctx.tools.execute({ callId: ToolCallId('c4'), name: 'skill', arguments: {}, signal })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(store.read('catalog')?.useCount).toBe(2)
    } finally {
      await fiber.dispose()
    }
  })

  it('records failed skill-tool loads as outcomes', async () => {
    const { ctx, fiber, store } = await harness({ catalog: 'user-dsh' })
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const signal = new AbortController().signal
      ctx.tools.register(defineContentToolFixture({
        name: 'skill',
        description: 'd',
        parameters: { name: { type: 'string', description: 'd' } },
        execute: async (args) => {
          if ((args as { name?: unknown }).name === 'doomed') throw new Error('load offline')
          return [{ type: 'text' as const, text: 'body' }]
        },
      }))
      await ctx.tools.execute({
        callId: ToolCallId('c1'),
        name: 'skill',
        arguments: { name: 'doomed' },
        signal,
        agent: { session: { id: 'fail-session' } } as never,
      })
      await vi.waitFor(() => {
        expect(store.read('doomed')).toMatchObject({
          useCount: 0,
          failureCount: 1,
          lastOutcome: 'failed',
          sessionIds: ['fail-session'],
        })
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('warns instead of rejecting when use recording fails', async () => {
    const { ctx, fiber, store } = await harness({ catalog: 'user-dsh' })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.tools.register(defineContentToolFixture({
        name: 'skill',
        description: 'd',
        parameters: { name: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'd' } },
        execute: async () => [{ type: 'text' as const, text: 'body' }],
      }))
      const broken = vi.spyOn(store, 'markUsed').mockRejectedValueOnce(new Error('store offline'))
      const result = await ctx.tools.execute({
        callId: ToolCallId('c1'),
        name: 'skill',
        arguments: { name: 'catalog' },
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('use recording failed'))
      })
      expect(broken).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      await fiber.dispose()
    }
  })

  it('stored objects never leak by reference', async () => {
    const { fiber, store } = await harness()
    const record = await store.markUsed('catalog')
    if (record === undefined) throw new Error('expected a stored record')
    record.useCount = 99
    expect(store.read('catalog')?.useCount).toBe(1)
    await fiber.dispose()
  })

  it('reads fail before the store starts', async () => {
    const ctx = new Context()
    const store = new EvolutionSkillTelemetry(ctx)
    expect(() => store.read('x')).toThrow('not started yet')
    expect(() => store.entries()).toThrow('not started yet')
  })
})

describe('skill creation evidence', () => {
  it('counts nothing as evidence without produced outputs', () => {
    expect(skillCreationEvidence([])).toEqual({ repeated: [], fires: false })
    expect(skillCreationEvidence(['out/report.md'])).toEqual({ repeated: [], fires: false })
  })

  it('fires at the third similar output and not before', () => {
    const twice = skillCreationEvidence(['out/report.md', 'out/report.md'])
    expect(twice).toEqual({ repeated: [], fires: false })
    const thrice = skillCreationEvidence(['out/report.md', 'out/report.md', 'out/report.md'])
    expect(thrice.fires).toBe(true)
    expect(thrice.repeated).toEqual([{ path: 'out/report.md', count: 3 }])
  })

  it('groups outputs by normalized path without reading their content', () => {
    const evidence = skillCreationEvidence([
      'out\\Report.md',
      'OUT/report.md',
      'out/report.md/',
      'out/other.md',
      'out/other.md',
    ])
    expect(evidence.fires).toBe(true)
    // Most produced first, ties in first-seen order; the first-seen spelling is reported.
    expect(evidence.repeated).toEqual([
      { path: 'out\\Report.md', count: 3 },
    ])
  })

  it('orders repeated groups by count', () => {
    const evidence = skillCreationEvidence([
      'a.md', 'a.md', 'a.md',
      'b.md', 'b.md', 'b.md', 'b.md',
      'c.md', 'c.md', 'c.md',
    ])
    expect(evidence.repeated).toEqual([
      { path: 'b.md', count: 4 },
      { path: 'a.md', count: 3 },
      { path: 'c.md', count: 3 },
    ])
  })
})

describe('skill proposal merge key', () => {
  it('keys the same outputs identically regardless of order', () => {
    expect(skillProposalMergeKey(['b.md', 'a.md'])).toBe(skillProposalMergeKey(['a.md', 'b.md']))
    expect(skillProposalMergeKey(['a.md'])).not.toBe(skillProposalMergeKey(['b.md']))
  })

  it('normalizes paths the way the evidence counter groups them', () => {
    expect(skillProposalMergeKey(['out\\Report.md'])).toBe(skillProposalMergeKey(['OUT/report.md/']))
  })

  it('refuses an empty path list loudly', () => {
    expect(() => skillProposalMergeKey([])).toThrow('at least one path')
  })
})

describe('skill utility', () => {
  it('counts uses, assisted tasks, and successful tasks from recorded outcomes', async () => {
    const { fiber, store } = await harness({ writer: 'user-dsh' })
    try {
      await store.markUsed('writer', undefined, 'session-1')
      await store.markUsed('writer', undefined, 'session-1')
      await store.markUsed('writer', undefined, 'session-2')
      await store.recordTrustObservation('writer', 'success', 'session-1')
      await store.recordTrustObservation('writer', 'failure', 'session-2', {
        mergeKey: 'bash\u0000denied',
        message: 'denied',
        at: '2026-09-16T00:00:00.000Z',
      })
      // Three loads, two graded sessions, one of them clean: the cost of one
      // success is the recorded load count, not an estimate.
      expect(store.utility('writer')).toEqual({
        uses: 3,
        assistedTasks: 2,
        successfulTasks: 1,
        incrementalGain: null,
        costOverhead: 3,
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('derives the library-relative gain from the peers that carry outcomes', async () => {
    const { fiber, store } = await harness({ writer: 'user-dsh', rival: 'user-dsh' })
    try {
      await store.markUsed('writer', undefined, 'w1')
      await store.markUsed('writer', undefined, 'w2')
      await store.recordTrustObservation('writer', 'success', 'w1')
      await store.recordTrustObservation('writer', 'success', 'w2')
      await store.markUsed('rival', undefined, 'r1')
      await store.markUsed('rival', undefined, 'r2')
      await store.recordTrustObservation('rival', 'success', 'r1')
      await store.recordTrustObservation('rival', 'failure', 'r2', {
        mergeKey: 'bash\u0000slow',
        message: 'slow',
        at: '2026-09-16T00:00:00.000Z',
      })
      // Writer is 2/2 clean while the only peer is 1/2, so the writer's stored
      // gain is its excess over the peer's pooled share — and the peer's is
      // negative against the writer's clean record.
      expect(store.utility('writer')).toMatchObject({ incrementalGain: 1 - 1 / 2 })
      expect(store.utility('rival')).toMatchObject({ incrementalGain: 1 / 2 - 1 })
      expect(store.utility('absent')).toBeUndefined()
      await store.markUsed('rival', undefined, 'r3')
      await store.recordTrustObservation('rival', 'failure', 'r3', {
        mergeKey: 'bash\u0000slow',
        message: 'slow',
        at: '2026-09-16T00:00:00.000Z',
      })
      // A third failed peer session grows the pooled arm to 1 of 3.
      expect(store.utility('writer')).toMatchObject({ incrementalGain: 1 - 1 / 3 })
    } finally {
      await fiber.dispose()
    }
  })

  it('leaves both derived numbers unset when no comparison exists', async () => {
    const { fiber, store } = await harness({ writer: 'user-dsh', peer: 'user-dsh' })
    try {
      // Loads without a graded outcome are not assisted tasks, and a skill
      // with no clean outcome has no success to divide the cost by.
      await store.markUsed('writer', undefined, 'w1')
      await store.markUsed('peer', undefined, 'p1')
      await store.recordTrustObservation('writer', 'failure', 'w1', {
        mergeKey: 'bash\u0000denied',
        message: 'denied',
        at: '2026-09-16T00:00:00.000Z',
      })
      expect(store.utility('writer')).toEqual({
        uses: 1,
        assistedTasks: 1,
        successfulTasks: 0,
        incrementalGain: null,
        costOverhead: null,
      })
      // The peer has no graded outcome at all, so it is not an assisted task.
      expect(store.utility('peer')).toMatchObject({ assistedTasks: 0, successfulTasks: 0, costOverhead: null })
    } finally {
      await fiber.dispose()
    }
  })

  it('clears outcome evidence when the body changes', async () => {
    const { fiber, store } = await harness({ writer: 'user-dsh' })
    try {
      await store.markUsed('writer', undefined, 'w1')
      await store.recordTrustObservation('writer', 'success', 'w1')
      expect(store.read('writer')?.sessionOutcomes).toEqual([{ sessionId: 'w1', outcome: 'ok' }])
      // The outcomes describe the body that changed, so the reading restarts.
      await store.markRevised('writer', 'new body')
      expect(store.read('writer')?.sessionOutcomes).toEqual([])
      expect(store.utility('writer')).toMatchObject({ assistedTasks: 0, successfulTasks: 0 })
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps one outcome per session, newest first and bounded', async () => {
    const { fiber, store } = await harness({ writer: 'user-dsh' }, { maxSessionIds: 2 })
    try {
      await store.markUsed('writer', undefined, 'w1')
      await store.markUsed('writer', undefined, 'w2')
      await store.recordTrustObservation('writer', 'success', 'w1')
      await store.recordTrustObservation('writer', 'success', 'w2')
      // Re-observing the same outcome rewrites nothing.
      await store.recordTrustObservation('writer', 'success', 'w2')
      expect(store.read('writer')?.sessionOutcomes).toEqual([
        { sessionId: 'w2', outcome: 'ok' },
        { sessionId: 'w1', outcome: 'ok' },
      ])
      // A later demotion of the same session replaces its entry in place.
      await store.recordTrustObservation('writer', 'failure', 'w2', {
        mergeKey: 'bash\u0000denied',
        message: 'denied',
        at: '2026-09-16T00:00:00.000Z',
      })
      expect(store.read('writer')?.sessionOutcomes).toEqual([
        { sessionId: 'w2', outcome: 'failed' },
        { sessionId: 'w1', outcome: 'ok' },
      ])
      await store.markUsed('writer', undefined, 'w3')
      await store.recordTrustObservation('writer', 'success', 'w3')
      expect(store.read('writer')?.sessionOutcomes).toEqual([
        { sessionId: 'w3', outcome: 'ok' },
        { sessionId: 'w2', outcome: 'failed' },
      ])
    } finally {
      await fiber.dispose()
    }
  })

  it('writes the utility reading only for tracked skills', async () => {
    const { fiber, store } = await harness({ box: 'bundled' })
    try {
      expect(await store.markUsed('box')).toBeUndefined()
      expect(store.utility('box')).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })
})

describe('consolidation cost row', () => {
  it('records the frozen row shape and reads a detached copy', async () => {
    const { fiber, store } = await harness()
    expect(store.readConsolidationCost()).toBeUndefined()

    store.recordConsolidationCost({
      inputBytes: 131_072,
      maxOutputTokens: 1_024,
      provider: 'deepseek',
      model: 'deepseek-chat',
      truncated: false,
    })
    expect(store.readConsolidationCost()).toEqual({
      inputBytes: 131_072,
      maxOutputTokens: 1_024,
      provider: 'deepseek',
      model: 'deepseek-chat',
      truncated: false,
    })
    expect(store.readConsolidationCost()).not.toBe(store.readConsolidationCost())

    store.recordConsolidationCost({
      inputBytes: 4_096,
      maxOutputTokens: 512,
      provider: 'openrouter',
      model: 'aux/flash',
      truncated: true,
    })
    expect(store.readConsolidationCost()).toMatchObject({ inputBytes: 4_096, truncated: true, provider: 'openrouter' })
    await fiber.dispose()
  })

  it('records one version row per committed body revision, oldest first', async () => {
    const { fiber, store } = await harness({ writer: 'user-dsh' })
    try {
      expect(store.versions('writer')).toEqual([])
      const sha1 = createHash('sha256').update('body-1').digest('hex')
      const sha2 = createHash('sha256').update('body-2').digest('hex')
      await store.markRevised('writer', 'body-1')
      await store.markRevised('writer', 'body-2')
      const rows = store.versions('writer')
      expect(rows.map(row => ({ ...row, at: '' }))).toEqual([
        { name: 'writer', revision: 1, contentSha: sha1, parentRevisionSha: null, at: '' },
        { name: 'writer', revision: 2, contentSha: sha2, parentRevisionSha: sha1, at: '' },
      ])
      expect(rows[0]?.at).toEqual(expect.any(String))
      expect(store.read('writer')).toMatchObject({ revision: 2, contentSha: sha2, parentRevisionSha: sha1 })
    } finally {
      await fiber.dispose()
    }
  })

  it('does not record a version when the body is unchanged', async () => {
    const { fiber, store } = await harness({ writer: 'user-dsh' })
    try {
      await store.markRevised('writer', 'body-1')
      await store.markRevised('writer', 'body-1')
      expect(store.versions('writer')).toHaveLength(1)
      expect(store.read('writer')).toMatchObject({ revision: 1 })
    } finally {
      await fiber.dispose()
    }
  })

  it('returns detached version rows', async () => {
    const { fiber, store } = await harness({ writer: 'user-dsh' })
    try {
      await store.markRevised('writer', 'body-1')
      const rows = store.versions('writer')
      ;(rows[0] as { name: string }).name = 'mutated'
      expect(store.versions('writer')[0]?.name).toBe('writer')
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps version history out of excluded sources and clears it on drop', async () => {
    const { fiber, store } = await harness({ builtin: 'bundled', writer: 'user-dsh', other: 'user-dsh' })
    try {
      expect(await store.markRevised('builtin', 'body')).toBeUndefined()
      expect(store.versions('builtin')).toEqual([])
      await store.markRevised('writer', 'body-1')
      await store.markRevised('writer', 'body-2')
      await store.markRevised('other', 'body-x')
      expect(store.versions('writer')).toHaveLength(2)
      expect(await store.drop('writer')).toBe(true)
      expect(store.read('writer')).toBeUndefined()
      expect(store.versions('writer')).toEqual([])
      // A sibling skill's history survives the drop's prefix sweep.
      expect(store.versions('other')).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionSkillTelemetry(ctx, {})
    expect(() => store.versions('writer')).toThrow('not started yet')
  })
})
