import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import EvolutionFeedback from '@deepseek-ai/dsh-evolution-feedback'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionCurriculum, { resolveConfig } from '../src/index.ts'
import type { CurriculumGap, CurriculumProposal } from '../src/index.ts'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import type { LearningTraceRow } from '@deepseek-ai/dsh-evolution-trace'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

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
    sessionOutcomes: [],
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: 't0',
    state: 'active',
    pinned: false,
    createdBy: null,
    absorbedInto: null,
    archivedAt: null,
    suspectAt: null,
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

/**
 * Boot the curriculum over a real failure-memory store and two real sessions,
 * so a gap is matched against the reflections that store actually authored.
 */
async function bootWithFailures() {
  const dir = await mkdtemp(join(tmpdir(), 'curriculum-feedback-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  const memory = await ctx.plugin(EvolutionFeedback, {})
  const fiber = await ctx.plugin(EvolutionCurriculum, {})
  const first = ctx.sessions.create(SessionId('s1'), { meta: { cwd: dir } })
  const second = ctx.sessions.create(SessionId('s2'), { meta: { cwd: dir } })
  return {
    ctx,
    fibers: [fiber, memory],
    store: ctx.evolutionCurriculum,
    feedback: ctx.evolutionFeedback,
    first,
    second,
  }
}

/** Append one turn holding a single failing tool call and its result. */
function appendFailure(session: Session, turn: number, name: string, text: string): void {
  const id = ToolCallId(`call-${turn}`)
  session.append('turn/start', { turn })
  session.append('tool/call', { turn, step: 1, callId: id, name, arguments: '{}' })
  session.append(
    'tool/result',
    {
      turn,
      step: 1,
      message: createToolResultMessage({ callId: id, content: [{ type: 'text', text }], isError: true }),
    },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Wait for both fibers of one {@link bootWithFailures} host to dispose. */
async function dispose(fibers: readonly { dispose(): Promise<void> }[]): Promise<void> {
  for (const fiber of fibers) await fiber.dispose()
}

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
      // Without the failure-memory seam there is nothing to match a gap to, so
      // the proposal carries the evidence alone.
      expect(staged[0]).toMatchObject({ antiPattern: null, candidateTest: null })
    } finally {
      await fiber.dispose()
    }
  })
})

describe('evolution curriculum corrective heuristics', () => {
  it('carries the reflection matched to a gap and nothing for an unmatched gap', async () => {
    const h = await bootWithFailures()
    try {
      appendFailure(h.first, 1, 'bash', 'command not found')
      appendFailure(h.second, 1, 'bash', 'command not found')
      const written = await h.feedback.reflectSignals(10, '2026-09-22T00:00:00.000Z')
      expect(written).toHaveLength(1)
      const staged = await h.store.propose([
        { capability: 'writer', sourceSessions: ['s1', 's2'], failureGists: ['command not found'] },
        // The trace gist is the same failing text clipped at the trace's own
        // budget, so a shorter gist still identifies the failure.
        { capability: 'polish', sourceSessions: ['s1', 's2'], failureGists: ['command'] },
        { capability: 'reader', sourceSessions: ['s1', 's2'], failureGists: ['unrelated skid'] },
      ])
      expect(staged.map(proposal => proposal.capability)).toEqual(['writer', 'polish', 'reader'])
      const heuristic = {
        antiPattern: 'do not repeat a call whose result was \'command not found\' without changing it (2 observations in 2 sessions)',
        candidateTest: 'replaying a run whose tool result is \'command not found\' no longer repeats that call unchanged',
      }
      expect(staged[0]).toMatchObject(heuristic)
      expect(staged[1]).toMatchObject(heuristic)
      expect(staged[2]).toMatchObject({ antiPattern: null, candidateTest: null })
      // The heuristic is durable with the proposal, not only the staging result.
      expect(h.store.proposals()).toHaveLength(3)
      expect(h.store.proposals().find(proposal => proposal.capability === 'writer')).toMatchObject(heuristic)
    } finally {
      await dispose(h.fibers)
    }
  })

  it('matches a gap whose sessions never reported the reflected failure to nothing', async () => {
    const h = await bootWithFailures()
    try {
      appendFailure(h.first, 1, 'bash', 'command not found')
      appendFailure(h.second, 1, 'bash', 'command not found')
      await h.feedback.reflectSignals(10, '2026-09-22T00:00:00.000Z')
      const staged = await h.store.propose([
        { capability: 'writer', sourceSessions: ['s3', 's4'], failureGists: ['command not found'] },
      ])
      expect(staged).toHaveLength(1)
      expect(staged[0]).toMatchObject({ antiPattern: null, candidateTest: null })
    } finally {
      await dispose(h.fibers)
    }
  })
})
