import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import EvolutionSkillTelemetry from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionCurator, { resolveConfig } from '../src/index.ts'
import { curatorHome, readLedger } from '../src/safety.ts'

const DAY = 24 * 3600 * 1000
const HOUR = 3600 * 1000
const T0 = Date.parse('2026-06-01T00:00:00.000Z')

const savedHome = process.env['DSH_HOME']
const homeDirs: string[] = []

afterAll(async () => {
  if (savedHome === undefined) delete process.env['DSH_HOME']
  else process.env['DSH_HOME'] = savedHome
  for (const dir of homeDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

afterEach(async () => {
  vi.useRealTimers()
  for (const dir of homeDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface FakeSkill {
  name: string
  source: string
  description?: string
}

async function harness(options: {
  sources?: Record<string, string>
  telemetry?: boolean
  feedFailures?: boolean
  feedSignals?: FeedbackSignal[]
  curatorConfig?: Record<string, unknown>
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'curator-home-'))
  homeDirs.push(home)
  process.env['DSH_HOME'] = home
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const skills: FakeSkill[] = Object.entries(options.sources ?? {})
    .map(([name, source]) => ({ name, source, description: `${name} skill` }))
  const state = { failList: false }
  const feedbackCalls: { sessionIds: string[]; limit: number }[] = []
  const signals: FeedbackSignal[] = options.feedFailures === true
    ? [{
      tool: 'bash',
      message: 'command not found',
      count: 4,
      sessions: 2,
      firstAt: 't0',
      lastAt: 't1',
      actionability: 'trigger_review',
      evidenceStatus: 'complete',
      mergeKey: 'bash\u0000command not found',
    }]
    : options.feedSignals ?? []
  ctx.provide('skills', {
    list: async () => {
      if (state.failList) throw new Error('catalog unavailable')
      return skills.map(skill => ({ ...skill }))
    },
  } as never)
  if (options.feedFailures === true || options.feedSignals !== undefined) {
    ctx.provide('evolutionFeedback', {
      signals: (sessionIds: readonly string[], limit: number) => {
        feedbackCalls.push({ sessionIds: [...sessionIds], limit })
        return signals
      },
    } as never)
  }
  if (options.telemetry !== false) {
    await ctx.plugin(EvolutionSkillTelemetry)
  }
  const baseline = vi.isFakeTimers() ? vi.getTimerCount() : 0
  const fiber = await ctx.plugin(EvolutionCurator, options.curatorConfig ?? {})
  const curator = ctx.evolutionCurator
  const telemetry = ctx.get('evolutionSkillTelemetry')
  return { ctx, fiber, curator, telemetry, skills, baseline, state, feedbackCalls }
}

describe('evolution curator', () => {
  it('resolves defaults and rejects an inverted threshold pair', () => {
    expect(resolveConfig({})).toMatchObject({
      enabled: true,
      intervalHours: 168,
      minIdleHours: 2,
      tickMinutes: 15,
      staleAfterDays: 30,
      archiveAfterDays: 90,
      protectedNames: [],
      pruneBuiltins: true,
      archiveTtlDays: 0,
      consolidate: false,
      provider: undefined,
      model: undefined,
      maxInputBytes: 65536,
      maxOutputTokens: 2048,
      maxSteps: 4,
      timeoutMs: 60000,
      stageMinUses: 20,
      stageFailureRate: 0.3,
      staleTrustFailureFloor: 3,
    })
    expect(() => resolveConfig({ staleAfterDays: 90, archiveAfterDays: 30 }))
      .toThrow('must not be below staleAfterDays')
  })

  it('surveys agent-created skills with verdict evidence', async () => {
    const h = await harness({ sources: { writer: 'user-dsh', midnight: 'user-dsh', alpha: 'user-dsh', mine: 'user-dsh' } })
    try {
      await h.telemetry?.markAgentCreated('writer')
      await h.telemetry?.markUsed('writer')
      await h.telemetry?.markAgentCreated('midnight')
      await h.telemetry?.markAgentCreated('alpha')
      await h.telemetry?.markUsed('mine')
      h.skills.push({ name: 'bare', source: 'user-dsh' })
      await h.telemetry?.markAgentCreated('bare')
      await h.telemetry?.markAgentCreated('stray')
      const survey = await h.curator.surveyCandidates({ now: Date.now() })
      expect(survey.candidates.map(candidate => candidate.name))
        .toEqual(['alpha', 'bare', 'midnight', 'stray', 'writer'])
      const byName = new Map(survey.candidates.map(candidate => [candidate.name, candidate]))
      expect(byName.get('writer')).toMatchObject({
        description: 'writer skill',
        source: 'user-dsh',
        state: 'active',
        idleDays: 0,
        useCount: 1,
        trust: 'provisional',
        revision: 0,
        contentSha: null,
        lastTrustFailure: null,
      })
      expect(typeof byName.get('writer')?.lastUsedAt).toBe('string')
      expect(byName.get('midnight')).toMatchObject({ lastUsedAt: null, useCount: 0 })
      expect(byName.get('bare')).toMatchObject({ description: '', source: 'user-dsh' })
      expect(byName.get('stray')).toMatchObject({ description: '', source: 'custom' })
      expect(typeof survey.at).toBe('string')
      const defaulted = await h.curator.surveyCandidates()
      expect(defaulted.candidates).toHaveLength(5)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('carries recorded failures from the correlated sessions', async () => {
    const h = await harness({ sources: { writer: 'user-dsh' }, feedFailures: true, curatorConfig: { maxCandidateFailures: 3 } })
    try {
      await h.telemetry?.markAgentCreated('writer')
      await h.telemetry?.markUsed('writer', undefined, 'session-1')
      await h.telemetry?.markUsed('writer', undefined, 'session-2')
      const survey = await h.curator.surveyCandidates()
      expect(survey.candidates[0]).toMatchObject({
        name: 'writer',
        failures: [{ tool: 'bash', message: 'command not found', count: 4, sessions: 2 }],
      })
      expect(h.feedbackCalls).toEqual([{ sessionIds: ['session-2', 'session-1'], limit: 3 }])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('carries no failures without a feedback store', async () => {
    const h = await harness({ sources: { writer: 'user-dsh' } })
    try {
      await h.telemetry?.markAgentCreated('writer')
      await h.telemetry?.markUsed('writer', undefined, 'session-1')
      expect((await h.curator.surveyCandidates()).candidates[0]).toMatchObject({ name: 'writer', failures: [] })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('leaves archived skills out of the consolidation survey', async () => {
    const h = await harness()
    try {
      await h.telemetry?.markAgentCreated('retired')
      await h.telemetry?.setState('retired', 'archived')
      expect((await h.curator.surveyCandidates()).candidates).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('surveys nothing without the telemetry store', async () => {
    const h = await harness({ telemetry: false })
    try {
      expect(await h.curator.surveyCandidates()).toMatchObject({ candidates: [] })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('demotes a skill whose correlated sessions carry an attributable failure', async () => {
    const h = await harness({ sources: { writer: 'user-dsh' }, feedFailures: true })
    try {
      await h.telemetry?.markAgentCreated('writer')
      await h.telemetry?.markUsed('writer', undefined, 'session-1')
      await h.curator.run({ now: T0 })
      expect(h.telemetry?.read('writer')).toMatchObject({
        trust: 'provisional',
        trustFailures: 1,
        trustAnchorSessionId: 'session-1',
        lastTrustFailure: {
          mergeKey: 'bash\u0000command not found',
          message: 'command not found',
          at: new Date(T0).toISOString(),
        },
      })
      expect(h.feedbackCalls).toEqual([{ sessionIds: ['session-1'], limit: 5 }])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('records nothing for an attributable failure when no session is correlated', async () => {
    const h = await harness({ sources: { writer: 'user-dsh' }, feedFailures: true })
    try {
      await h.telemetry?.markAgentCreated('writer')
      await h.curator.run({ now: T0 })
      expect(h.telemetry?.read('writer')).toMatchObject({ trust: 'provisional', trustFailures: 0 })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('counts correlated sessions as successes when no signal decides, and without a store', async () => {
    const graded = await harness({ sources: { writer: 'user-dsh' }, feedSignals: [{ tool: 'bash', message: 'slow', count: 1, sessions: 1, firstAt: 't0', lastAt: 't1', actionability: 'ranking_only', evidenceStatus: 'complete', mergeKey: 'bash\u0000slow' }] })
    try {
      await graded.telemetry?.markAgentCreated('writer')
      await graded.telemetry?.markUsed('writer', undefined, 'session-1')
      await graded.telemetry?.markUsed('writer', undefined, 'session-2')
      await graded.curator.run({ now: T0 })
      expect(graded.telemetry?.read('writer')).toMatchObject({
        trust: 'trusted',
        trustObservedSessions: ['session-1', 'session-2'],
      })
    } finally {
      await graded.fiber.dispose()
    }
    const bare = await harness({ sources: { writer: 'user-dsh' } })
    try {
      await bare.telemetry?.markAgentCreated('writer')
      await bare.telemetry?.markUsed('writer', undefined, 'session-1')
      await bare.curator.run({ now: T0 })
      expect(bare.telemetry?.read('writer')?.trustObservedSessions).toEqual(['session-1'])
    } finally {
      await bare.fiber.dispose()
    }
  })

  it('records no trust during a dry run and survives a failing store', async () => {
    const h = await harness({ sources: { writer: 'user-dsh' } })
    try {
      await h.telemetry?.markAgentCreated('writer')
      await h.telemetry?.markUsed('writer', undefined, 'session-1')
      await h.curator.run({ now: T0, dryRun: true })
      expect(h.telemetry?.read('writer')?.trustObservedSessions).toEqual([])
      const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
      vi.spyOn(h.telemetry as EvolutionSkillTelemetry, 'recordTrustObservation')
        .mockRejectedValue(new Error('store offline'))
      const report = await h.curator.run({ now: T0 })
      expect(report.scanned).toBe(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not record trust for 'writer'"))
    } finally {
      await h.fiber.dispose()
    }
  })

  it('reads fail before the curator starts', async () => {
    const ctx = new Context()
    const curator = new EvolutionCurator(ctx, {})
    expect(() => curator.lastRunAt()).toThrow('not started yet')
    await expect(curator.run()).rejects.toThrow('not started yet')
  })

  it('seeds the bookkeeping at start-up and defers one interval', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ curatorConfig: { intervalHours: 1, minIdleHours: 2 } })
    try {
      expect(h.curator.lastRunAt()).toBe(new Date(T0).toISOString())
      expect(await h.curator.maybeRun()).toBeUndefined()
      expect(h.curator.lastRunAt()).toBe(new Date(T0).toISOString())
      vi.setSystemTime(T0 + 30 * 60_000)
      expect(await h.curator.maybeRun()).toBeUndefined()
    } finally {
      await h.fiber.dispose()
    }
  })

  it('runs a pass on the due check when the host is idle', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({
      sources: { old: 'user-dsh' },
      curatorConfig: { intervalHours: 1, minIdleHours: 2, staleAfterDays: 1 },
    })
    try {
      await h.telemetry?.markUsed('old')
      vi.setSystemTime(T0 + 2 * DAY)
      const report = await h.curator.maybeRun()
      expect(report?.transitions).toHaveLength(1)
      expect(report?.transitions[0]).toMatchObject({ name: 'old', from: 'active', to: 'stale' })
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'stale' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('waits for a later due-check when the host is active', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({
      sources: { old: 'user-dsh' },
      curatorConfig: { intervalHours: 1, minIdleHours: 2, staleAfterDays: 1 },
    })
    try {
      await h.telemetry?.markUsed('old')
      vi.setSystemTime(T0 + 2 * DAY)
      h.ctx.emit('session/event', undefined as never, undefined as never)
      expect(await h.curator.maybeRun()).toBeUndefined()
      vi.setSystemTime(T0 + 2 * DAY + 1 * HOUR)
      expect(await h.curator.maybeRun()).toBeUndefined()
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'active' })
      vi.setSystemTime(T0 + 2 * DAY + 3 * HOUR)
      expect((await h.curator.maybeRun())?.transitions).toHaveLength(1)
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'stale' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('owns one host-wide timer and disposes it with the plugin', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness()
    try {
      expect(vi.getTimerCount()).toBe(h.baseline + 1)
    } finally {
      await h.fiber.dispose()
    }
    expect(vi.getTimerCount()).toBe(h.baseline)
  })

  it('runs its due-check on the tick and survives a failing pass', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({
      sources: { old: 'user-dsh' },
      curatorConfig: { tickMinutes: 60, intervalHours: 25, minIdleHours: 0, staleAfterDays: 1 },
    })
    try {
      const warnings: string[] = []
      h.ctx.logger.exporter({
        levels: { default: 9 },
        export: (message) => {
          warnings.push(message.args.join(' '))
        },
      })
      await h.telemetry?.markUsed('old')
      await vi.advanceTimersByTimeAsync(HOUR)
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'active' })
      h.state.failList = true
      await vi.advanceTimersByTimeAsync(25 * HOUR)
      expect(warnings.join('\n')).toContain('evolution curator scheduled pass failed: Error: catalog unavailable')
      expect(vi.getTimerCount()).toBe(h.baseline + 1)
      h.state.failList = false
      await vi.advanceTimersByTimeAsync(2 * HOUR)
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'stale' })
      expect(h.curator.lastRunAt()).not.toBe(new Date(T0).toISOString())
    } finally {
      await h.fiber.dispose()
    }
  })

  it('starts no timer and touches no bookkeeping when disabled', async () => {
    vi.useFakeTimers({ now: T0 })
    const h = await harness({ curatorConfig: { enabled: false } })
    try {
      expect(vi.getTimerCount()).toBe(h.baseline)
      expect(h.curator.lastRunAt()).toBeNull()
      expect(await h.curator.maybeRun()).toBeUndefined()
      expect(h.curator.lastRunAt()).toBeNull()
    } finally {
      await h.fiber.dispose()
    }
    expect(vi.getTimerCount()).toBe(h.baseline)
  })

  it('moves idle skills along active to stale to archived', async () => {
    const h = await harness({ sources: { old: 'user-dsh', older: 'user-dsh', fresh: 'user-dsh' } })
    try {
      await h.telemetry?.markUsed('old')
      await h.telemetry?.markUsed('older')
      await h.telemetry?.markUsed('fresh')
      const now = Date.now()
      const idle = await h.curator.run({ now })
      expect(idle.scanned).toBe(3)
      expect(idle.transitions).toEqual([])
      // Stage 'older' as pre-staled after the quiet pass: a stale label with a
      // fresher ok load behind it is exactly what the revival rule answers.
      await h.telemetry?.setState('older', 'stale')
      const first = await h.curator.run({ now: now + 45 * DAY })
      expect(first.scanned).toBe(3)
      expect(first.transitions).toHaveLength(2)
      const firstByName = new Map(first.transitions.map(transition => [transition.name, transition]))
      expect(firstByName.get('old')).toMatchObject({ from: 'active', to: 'stale' })
      expect(firstByName.get('old')?.reason).toContain('exceeds 30d')
      expect(firstByName.get('fresh')).toMatchObject({ from: 'active', to: 'stale' })
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'stale' })
      const second = await h.curator.run({ now: now + 100 * DAY })
      const byName = new Map(second.transitions.map(transition => [transition.name, transition]))
      expect(second.transitions).toHaveLength(3)
      expect(byName.get('old')).toMatchObject({ from: 'stale', to: 'archived' })
      expect(byName.get('older')).toMatchObject({ from: 'stale', to: 'archived' })
      expect(byName.get('older')?.reason).toContain('exceeds 90d')
      expect(byName.get('fresh')).toMatchObject({ from: 'stale', to: 'archived' })
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'archived' })
      expect((await h.curator.run({ now: now + 100 * DAY })).transitions).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('ages never-used skills from their seeding', async () => {
    const h = await harness({ sources: { quiet: 'user-dsh' } })
    try {
      await h.telemetry?.markAgentCreated('quiet')
      expect(h.telemetry?.read('quiet')).toMatchObject({ lastUsedAt: null })
      const report = await h.curator.run({ now: Date.now() + 45 * DAY })
      expect(report.transitions).toHaveLength(1)
      expect(report.transitions[0]).toMatchObject({ name: 'quiet', from: 'active', to: 'stale' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('skips pinned, protected, and excluded skills', async () => {
    const h = await harness({
      sources: { pinned: 'user-dsh', kept: 'user-dsh', boxed: 'bundled', ghost: 'user-dsh' },
      curatorConfig: { protectedNames: ['kept'] },
    })
    try {
      await h.telemetry?.markUsed('pinned')
      await h.telemetry?.markUsed('kept')
      await h.telemetry?.markUsed('boxed')
      await h.telemetry?.markUsed('ghost')
      // Off-catalog skills record under the `custom` source.
      await h.telemetry?.markUsed('stray')
      await h.telemetry?.setPinned('pinned', true)
      // Excluded sources never seed through marks; the pin path seeds the
      // record so the pass can observe the exclusion.
      await h.telemetry?.setPinned('boxed', false)
      const report = await h.curator.run({ now: Date.now() + 45 * DAY })
      expect(report.scanned).toBe(5)
      expect(report.skippedPinned).toBe(1)
      expect(report.skippedProtected).toBe(1)
      expect(report.skippedExcluded).toBe(1)
      expect(report.transitions).toHaveLength(2)
      const moved = new Map(report.transitions.map(transition => [transition.name, transition]))
      expect(moved.get('ghost')).toMatchObject({ from: 'active', to: 'stale' })
      expect(moved.get('stray')).toMatchObject({ from: 'active', to: 'stale' })
      expect(h.telemetry?.read('pinned')).toMatchObject({ state: 'active' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('curates bundled built-ins when they are not pruned', async () => {
    const h = await harness({
      sources: { boxed: 'bundled', shared: 'hub:community' },
      curatorConfig: { pruneBuiltins: false },
    })
    try {
      await h.telemetry?.setPinned('boxed', false)
      await h.telemetry?.setPinned('shared', false)
      const report = await h.curator.run({ now: Date.now() + 45 * DAY })
      expect(report.skippedExcluded).toBe(1)
      expect(report.transitions.map(transition => transition.name)).toEqual(['boxed'])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('previews without writing under dry-run', async () => {
    const h = await harness({ sources: { old: 'user-dsh' } })
    try {
      await h.telemetry?.markUsed('old')
      const preview = await h.curator.run({ now: Date.now() + 45 * DAY, dryRun: true })
      expect(preview.dryRun).toBe(true)
      expect(preview.transitions).toHaveLength(1)
      expect(preview.passId).toBeNull()
      expect(preview.snapshot).toBeNull()
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'active' })
      expect(h.curator.lastRunAt()).toBe(preview.at)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('skips snapshots when backups are off', async () => {
    const h = await harness({ sources: { old: 'user-dsh' }, curatorConfig: { backup: { enabled: false } } })
    try {
      await h.telemetry?.markUsed('old')
      const report = await h.curator.run({ now: Date.now() + 45 * DAY })
      expect(report.transitions).toHaveLength(1)
      expect(h.telemetry?.read('old')).toMatchObject({ state: 'stale' })
      expect(report.passId).toBeNull()
      expect(report.snapshot).toBeNull()
      expect(await h.curator.passes()).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('stages skills over both thresholds only', async () => {
    const h = await harness({
      sources: { boundary: 'user-dsh', flaky: 'user-dsh', thin: 'user-dsh' },
      curatorConfig: { stageMinUses: 4, stageFailureRate: 0.5 },
    })
    try {
      // 2/4 is exactly the threshold, which is not yet over it.
      for (let i = 0; i < 2; i += 1) await h.telemetry?.markUsed('boundary')
      for (let i = 0; i < 2; i += 1) await h.telemetry?.markFailed('boundary')
      // 3/4 is over the rate with the sample gate met.
      for (let i = 0; i < 1; i += 1) await h.telemetry?.markUsed('flaky')
      for (let i = 0; i < 3; i += 1) await h.telemetry?.markFailed('flaky')
      // 3/3 is a perfect rate over three loads, which says nothing yet.
      for (let i = 0; i < 3; i += 1) await h.telemetry?.markFailed('thin')
      const report = await h.curator.run({ now: Date.now(), dryRun: true })
      expect(report.staged).toEqual([{
        name: 'flaky',
        useCount: 1,
        failureCount: 3,
        failureRate: 0.75,
        reason: 'failures 3/4 exceed 50%',
      }])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('stales an active skill on repeated unattributed failures', async () => {
    const h = await harness({ sources: { rotten: 'user-dsh' } })
    try {
      await h.telemetry?.markUsed('rotten', undefined, 's1')
      const failedAt = new Date(Date.now() + HOUR).toISOString()
      for (let i = 0; i < 3; i += 1) {
        await h.telemetry?.recordTrustObservation('rotten', 'failure', `s-f${i}`, {
          mergeKey: 'bash\u0000broken', message: 'broken', at: failedAt,
        })
      }
      const report = await h.curator.run({ now: Date.now() + 2 * HOUR })
      expect(report.transitions).toEqual([{
        name: 'rotten', from: 'active', to: 'stale', reason: 'trust failures 3 reach 3',
      }])
      expect(h.telemetry?.read('rotten')).toMatchObject({ state: 'stale' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('leaves an active skill alone when a later load answers its failures', async () => {
    const h = await harness({ sources: { answered: 'user-dsh' } })
    try {
      await h.telemetry?.markUsed('answered', undefined, 's1')
      // Backdated attribution: the answering load below is genuinely newer.
      const failedAt = new Date(Date.now() - 2 * HOUR).toISOString()
      for (let i = 0; i < 3; i += 1) {
        await h.telemetry?.recordTrustObservation('answered', 'failure', `s-f${i}`, {
          mergeKey: 'bash\u0000broken', message: 'broken', at: failedAt,
        })
      }
      await h.telemetry?.markUsed('answered', undefined, 's2')
      const report = await h.curator.run({ now: Date.now() + HOUR })
      expect(report.transitions).toEqual([])
      expect(h.telemetry?.read('answered')).toMatchObject({ state: 'active' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('stales a never-loaded skill on attributed failures alone', async () => {
    const h = await harness({})
    try {
      const failedAt = new Date(Date.now() + HOUR).toISOString()
      for (let i = 0; i < 3; i += 1) {
        await h.telemetry?.recordTrustObservation('ghost', 'failure', `s-f${i}`, {
          mergeKey: 'bash\u0000broken', message: 'broken', at: failedAt,
        })
      }
      const report = await h.curator.run({ now: Date.now() + 2 * HOUR })
      expect(report.transitions).toEqual([{
        name: 'ghost', from: 'active', to: 'stale', reason: 'trust failures 3 reach 3',
      }])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('stales an active skill on a bad load rate ending in failure', async () => {
    const h = await harness({
      sources: { flaky: 'user-dsh' },
      curatorConfig: { stageMinUses: 4, stageFailureRate: 0.5 },
    })
    try {
      await h.telemetry?.markUsed('flaky')
      for (let i = 0; i < 3; i += 1) await h.telemetry?.markFailed('flaky')
      const report = await h.curator.run({ now: Date.now(), dryRun: true })
      expect(report.transitions).toEqual([{
        name: 'flaky', from: 'active', to: 'stale', reason: 'failures 3/4 exceed 50%',
      }])
      expect(h.telemetry?.read('flaky')).toMatchObject({ state: 'active' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('leaves a bad-rate skill alone when its latest load succeeded', async () => {
    const h = await harness({
      sources: { recovering: 'user-dsh' },
      curatorConfig: { stageMinUses: 4, stageFailureRate: 0.5 },
    })
    try {
      await h.telemetry?.markUsed('recovering')
      for (let i = 0; i < 3; i += 1) await h.telemetry?.markFailed('recovering')
      await h.telemetry?.markUsed('recovering')
      const report = await h.curator.run({ now: Date.now() })
      expect(report.transitions).toEqual([])
      expect(h.telemetry?.read('recovering')).toMatchObject({ state: 'active' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('revives a stale skill on a fresh successful load', async () => {
    const h = await harness({ sources: { back: 'user-dsh' } })
    try {
      await h.telemetry?.setState('back', 'stale')
      await h.telemetry?.markUsed('back', undefined, 's9')
      const report = await h.curator.run({ now: Date.now() })
      expect(report.transitions).toEqual([{
        name: 'back', from: 'stale', to: 'active', reason: 'last load ok 0d ago',
      }])
      expect(h.telemetry?.read('back')).toMatchObject({ state: 'active' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('archives past the horizon instead of reviving the long dead', async () => {
    const h = await harness({ sources: { gone: 'user-dsh' } })
    try {
      await h.telemetry?.setState('gone', 'stale')
      await h.telemetry?.markUsed('gone', undefined, 's9')
      const report = await h.curator.run({ now: Date.now() + 100 * DAY })
      expect(report.transitions).toHaveLength(1)
      expect(report.transitions[0]).toMatchObject({ name: 'gone', from: 'stale', to: 'archived' })
      expect(report.transitions[0]?.reason).toContain('exceeds 90d')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('records one staging line per counter change and reads the newest per skill', async () => {
    const config = { stageMinUses: 4, stageFailureRate: 0.5 }
    const h = await harness({ sources: { flaky: 'user-dsh' }, curatorConfig: config })
    const stageLines = async (): Promise<number> =>
      (await readLedger(curatorHome())).filter(entry => entry.action === 'stage').length
    try {
      await h.telemetry?.markUsed('flaky')
      for (let i = 0; i < 3; i += 1) await h.telemetry?.markFailed('flaky')
      const first = await h.curator.run({ now: Date.now() })
      expect(first.staged).toHaveLength(1)
      expect(await stageLines()).toBe(1)
      await h.curator.run({ now: Date.now() })
      expect(await stageLines()).toBe(1)
      await h.telemetry?.markFailed('flaky')
      const second = await h.curator.run({ now: Date.now() })
      expect(second.staged).toMatchObject([{ failureCount: 4, failureRate: 0.8 }])
      expect(await stageLines()).toBe(2)
      // A pass that moves a skill writes its own entries, so the staging read
      // and the dedupe see a ledger holding more than staging lines.
      await h.curator.run({ now: Date.now() + 45 * DAY })
      const mixed = await h.curator.run({ now: Date.now() + 45 * DAY })
      expect(mixed.transitions).toEqual([])
      expect(mixed.staged).toHaveLength(1)
      expect(await stageLines()).toBe(2)
      expect(await h.curator.staged()).toMatchObject([
        { name: 'flaky', useCount: 1, failureCount: 4, failureRate: 0.8 },
      ])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('orders staged skills worst first and reports them without writing under dry-run', async () => {
    const config = { stageMinUses: 4, stageFailureRate: 0.1 }
    const h = await harness({
      sources: { mild: 'user-dsh', severe: 'user-dsh', beta: 'user-dsh', alpha: 'user-dsh' },
      curatorConfig: config,
    })
    try {
      // Equal rates across three skills, so the tie-break decides their order.
      for (const name of ['mild', 'beta', 'alpha']) {
        for (let i = 0; i < 3; i += 1) await h.telemetry?.markUsed(name)
        for (let i = 0; i < 3; i += 1) await h.telemetry?.markFailed(name)
      }
      // One higher rate leads the report.
      await h.telemetry?.markUsed('severe')
      for (let i = 0; i < 5; i += 1) await h.telemetry?.markFailed('severe')
      const preview = await h.curator.run({ now: Date.now(), dryRun: true })
      expect(preview.staged.map(candidate => candidate.name)).toEqual(['severe', 'alpha', 'beta', 'mild'])
      expect(await h.curator.staged()).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('stages pinned skills while protected ones stay out', async () => {
    const h = await harness({
      sources: { pinned: 'user-dsh', kept: 'user-dsh' },
      curatorConfig: { stageMinUses: 4, stageFailureRate: 0.5, protectedNames: ['kept'] },
    })
    try {
      for (const name of ['pinned', 'kept']) {
        await h.telemetry?.markUsed(name)
        for (let i = 0; i < 3; i += 1) await h.telemetry?.markFailed(name)
      }
      await h.telemetry?.setPinned('pinned', true)
      const report = await h.curator.run({ now: Date.now() })
      // A pin protects against movement, not against being looked at.
      expect(report.staged.map(candidate => candidate.name)).toEqual(['pinned'])
      expect(report.skippedProtected).toBe(1)
      expect(h.telemetry?.read('pinned')).toMatchObject({ state: 'active' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('skips staging ledger lines when backups are off', async () => {
    const h = await harness({
      sources: { flaky: 'user-dsh' },
      curatorConfig: { backup: { enabled: false }, stageMinUses: 4, stageFailureRate: 0.5 },
    })
    try {
      await h.telemetry?.markUsed('flaky')
      for (let i = 0; i < 3; i += 1) await h.telemetry?.markFailed('flaky')
      const report = await h.curator.run({ now: Date.now() })
      expect(report.staged).toHaveLength(1)
      expect(await h.curator.staged()).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('advances bookkeeping without the telemetry store', async () => {
    const h = await harness({ telemetry: false })
    try {
      const now = Date.now()
      const report = await h.curator.run({ now })
      expect(report.scanned).toBe(0)
      expect(report.transitions).toEqual([])
      expect(report.staged).toEqual([])
      expect(h.curator.lastRunAt()).toBe(new Date(now).toISOString())
    } finally {
      await h.fiber.dispose()
    }
  })
})
