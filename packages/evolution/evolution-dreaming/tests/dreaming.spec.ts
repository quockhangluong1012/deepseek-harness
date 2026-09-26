import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionMemoryRecord } from '@deepseek-ai/dsh-evolution-memory'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionDreaming, { Config, resolveConfig } from '../src/index.ts'

const scope = EvolutionScopeId('test', 'ws')

/** Fixed instant so the recency signal never depends on the wall clock. */
const NOW = '2026-09-13T00:00:00.000Z'

/** Memory text that overlaps the strong candidate, giving it a real relevance signal. */
const KNOWN = 'disk full while writing the cache to the local drive'

/** One recorded failure as the feedback summary reports it. */
interface SummaryRow {
  tool: string | null
  message: string
  count: number
  sessions: number
  firstAt: string
  lastAt: string
}

/** Feedback double serving a fixed summary. */
function fakeFeedback(rows: SummaryRow[]) {
  return {
    summary: (_sessionIds: readonly string[], limit: number) => rows.slice(0, limit),
    entries: () => [],
  }
}

/** Record fields a spec pins, with lesson text in place of the artifact array. */
interface FakeMemoryRecord extends Partial<Omit<EvolutionMemoryRecord, 'agentLessons'>> {
  /** The lesson text the relevance read must see, as one artifact statement. */
  agentLessons?: string
}

/**
 * Memory double exposing one record for the scope. The lessons family is an
 * artifact array, so a spec names the lesson text it expects the relevance
 * read to compare against and this folds it into one artifact's statement.
 * @param record - record fields to expose, or undefined for no record.
 * @returns a memory double whose `read` answers the scope.
 */
function fakeMemory(record: FakeMemoryRecord | undefined) {
  return {
    read: () => (record === undefined
      ? undefined
      : {
        instructions: '',
        userProfile: '',
        ...record,
        agentLessons: lessons(record.agentLessons),
      } as EvolutionMemoryRecord),
  }
}

/**
 * One lesson document as an artifact array: one artifact whose statement is
 * the given text, empty when there is no text.
 * @param text - the lesson text the spec pins.
 * @returns the artifact array the record stores.
 */
function lessons(text: string | undefined): EvolutionMemoryRecord['agentLessons'] {
  if (text === undefined) return []
  return [{
    id: text,
    statement: text,
    source: 's1',
    conditions: '',
    evidence: 'inference',
    confidence: 0.5,
    validationCount: 0,
    refutationCount: 0,
    scope: 'project',
    ttlDays: 30,
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  }]
}

async function harness(
  config: Config = {},
  options: { feedback?: unknown; memory?: unknown; heartbeat?: unknown; registry?: unknown } = {},
) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  if (options.feedback !== undefined) ctx.provide('evolutionFeedback', options.feedback as never)
  if (options.memory !== undefined) ctx.provide('evolutionMemory', options.memory as never)
  if (options.heartbeat !== undefined) ctx.provide('evolutionHeartbeat', options.heartbeat as never)
  if (options.registry !== undefined) ctx.provide('workspaceRegistry', options.registry as never)
  const fiber = await ctx.plugin(EvolutionDreaming, config)
  return { ctx, fiber, dreaming: ctx.evolutionDreaming }
}

/** A failure observed often enough, in enough sessions, and recently. */
function strong(overrides: Partial<SummaryRow> = {}): SummaryRow {
  return {
    tool: 'bash',
    message: 'disk is full while writing the cache',
    count: 9,
    sessions: 4,
    firstAt: '2026-09-01T00:00:00.000Z',
    lastAt: '2026-09-12T00:00:00.000Z',
    ...overrides,
  }
}

describe('dreaming configuration', () => {
  it('applies the OpenClaw thresholds and cadence by default', () => {
    expect(resolveConfig({})).toEqual({
      minScore: 0.65,
      minRecallCount: 3,
      minUniqueQueries: 2,
      staleAfterDays: 30,
      capacityTriggerRatio: 0.8,
      intervalHours: 6,
      maxNarratives: 20,
      maxPromotions: 200,
      maxCandidates: 500,
      mergeOverlap: 0.6,
      supersedeOverlap: 0.3,
      maxRestatements: 5,
      maxLedgerEntries: 10,
      profile: 'default',
    })
  })

  it('rejects a supersede threshold above the merge threshold', () => {
    expect(() => resolveConfig({ mergeOverlap: 0.2, supersedeOverlap: 0.5 }))
      .toThrow(/supersedeOverlap/)
  })

  it('refuses to load with a profile that can never name a scope', () => {
    // `EvolutionScopeId` builds `<profile>:<workspace>`, so accepting this
    // profile would empty every read under it instead of failing at load.
    expect(() => resolveConfig({ profile: '' })).toThrow('profile must be non-empty')
    expect(() => resolveConfig({ profile: 'team:eu' })).toThrow("profile must not contain ':'")
    // The schema refuses the same values before a mount is even attempted.
    expect(() => Config({ profile: '' })).toThrow(/regexp/)
    expect(() => Config({ profile: 'team:eu' })).toThrow(/regexp/)
    expect(Config({ profile: 'team' }).profile).toBe('team')
  })
})

describe('dreaming cycle', () => {
  it('stages the scope failures, deduplicating by statement', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([
        strong(),
        strong({ tool: 'pwsh', count: 1, sessions: 1, message: '  DISK is full while writing the cache ' }),
      ]),
    })
    const light = await dreaming.run('light', scope, ['s1', 's2'])
    expect(light.phase).toBe('light')
    expect(light.staged).toBe(1)
    expect(light.scanned).toBe(1)
    await ctx.fiber.dispose()
  })

  it('stages nothing when no feedback seam is mounted', async () => {
    const { ctx, dreaming } = await harness()
    const light = await dreaming.run('light', scope, ['s1'])
    expect(light.staged).toBe(0)
    await ctx.fiber.dispose()
  })

  it('stages episodic notes without feedback, skipping blank ones', async () => {
    const { ctx, dreaming } = await harness({}, {
      memory: fakeMemory({ episodic: [
        { day: '2026-09-12', text: 'user corrected the approach at step 3', addedAt: '2026-09-12T00:00:00.000Z' },
        { day: '2026-09-12', text: '   ', addedAt: '2026-09-12T00:00:00.000Z' },
      ] }),
    })
    const light = await dreaming.run('light', scope, ['s1'])
    expect(light.staged).toBe(1)
    expect(light.scanned).toBe(1)
    await ctx.fiber.dispose()
  })

  it('folds an episodic note restating a failure into the same candidate', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong({ tool: 'bash', count: 1, sessions: 1 })]),
      memory: fakeMemory({
        agentLessons: KNOWN,
        episodic: [
          { day: '2026-09-12', text: 'DISK IS FULL while writing the cache', addedAt: '2026-09-12T00:00:00.000Z' },
        ],
      }),
    })
    await dreaming.run('light', scope, ['s1'])
    const rem = await dreaming.run('rem', scope, ['s1'])
    expect(rem.staged).toBe(1)
    expect(dreaming.read(scope)?.narratives[0]?.themes.map(theme => theme.key)).toEqual(['bash'])
    await ctx.fiber.dispose()
  })

  it('refuses a note-only candidate as unattributed and admits it once a failure restates it', async () => {
    const rows: SummaryRow[] = []
    const { ctx, dreaming } = await harness({ minScore: 0 }, {
      feedback: fakeFeedback(rows),
      memory: fakeMemory({
        agentLessons: KNOWN,
        episodic: [
          { day: '2026-09-10', text: 'disk is full while writing the cache', addedAt: '2026-09-10T00:00:00.000Z' },
          { day: '2026-09-12', text: 'DISK IS FULL while writing the cache', addedAt: '2026-09-09T00:00:00.000Z' },
          { day: '2026-09-11', text: 'disk is full while writing the cache', addedAt: '2026-09-11T00:00:00.000Z' },
          { day: '2026-09-11', text: 'the deploy key expired before the release', addedAt: '2026-09-11T00:00:00.000Z' },
        ],
      }),
    })
    await dreaming.run('light', scope, ['s1'])
    const refused = await dreaming.run('deep', scope, ['s1'], NOW)
    // The notes carry no sighting the harness observed, so no gate can vouch
    // for them and nothing is written.
    expect(refused.promoted).toBe(0)
    expect(refused.refused).toEqual([{ reason: 'unattributed-sighting', count: 2 }])
    expect(dreaming.read(scope)).toBeUndefined()

    // The same text recorded as a failing tool result is attributed, and the
    // note sightings it absorbs only add to its evidence.
    rows.push(strong({ tool: 'bash', message: 'DISK IS FULL while writing the cache' }))
    await dreaming.run('light', scope, ['s1'])
    const deep = await dreaming.run('deep', scope, ['s1'], NOW)
    expect(deep.promoted).toBe(1)
    // The second note, which no failure restates, is still unattributable.
    expect(deep.refused).toEqual([{ reason: 'unattributed-sighting', count: 1 }])
    const promoted = dreaming.promotions(scope)[0]
    expect(promoted?.tool).toBe('bash')
    expect(promoted?.evidence).toEqual({ attribution: 'attributed', count: 12, sessions: 4 })
    await ctx.fiber.dispose()
  })

  it('writes a themed narrative in the REM phase without promoting anything', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong({ tool: 'bash' }), strong({ tool: null, message: 'other failure here' })]),
    })
    await dreaming.run('light', scope, ['s1'])
    const rem = await dreaming.run('rem', scope, ['s1'])
    expect(rem.promoted).toBe(0)
    const record = dreaming.read(scope)
    expect(record?.narratives).toHaveLength(1)
    expect(record?.narratives[0]?.themes.map(theme => theme.key).sort()).toEqual(['bash', 'other failure here'])
    expect(record?.promotions).toEqual([])
    await ctx.fiber.dispose()
  })

  it('promotes a candidate that clears the score, recall, and diversity gates', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong()]),
      memory: fakeMemory({ agentLessons: 'disk full while writing the cache to the local drive' }),
    })
    await dreaming.run('light', scope, ['s1'])
    const deep = await dreaming.run('deep', scope, ['s1'])
    expect(deep.promoted).toBe(1)
    const promoted = dreaming.read(scope)?.promotions[0]
    expect(promoted?.tool).toBe('bash')
    expect(promoted?.score).toBeGreaterThanOrEqual(0.65)
    await ctx.fiber.dispose()
  })

  it('refuses a candidate that fails any single gate', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([
        strong({ count: 2 }),                       // below minRecallCount
        strong({ sessions: 1, message: 'seen in one session only today' }),
        strong({ count: 1, sessions: 1, tool: null, message: 'a once-off failure' }),
      ]),
    })
    await dreaming.run('light', scope, ['s1'])
    const deep = await dreaming.run('deep', scope, ['s1'])
    expect(deep.promoted).toBe(0)
    // Nothing qualified and nothing expired, so the cycle writes no record.
    expect(dreaming.read(scope)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('promotes a statement once and never re-promotes it', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong()]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreaming.run('light', scope, ['s1'])
    const first = await dreaming.run('deep', scope, ['s1'], NOW)
    expect(first.promoted).toBe(1)
    await dreaming.run('light', scope, ['s1'])
    const second = await dreaming.run('deep', scope, ['s1'], NOW)
    expect(second.promoted).toBe(0)
    expect(dreaming.read(scope)?.promotions).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('runs all three phases in order and reports the cycle totals', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong()]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    const report = await dreaming.dream(scope, ['s1'], NOW)
    expect(report.phases.map(phase => phase.phase)).toEqual(['light', 'rem', 'deep'])
    expect(report.staged).toBe(1)
    expect(report.promoted).toBe(1)
    expect(dreaming.read(scope)?.narratives).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('drops a promotion the decay rule has outlived', async () => {
    const rows = [strong()]
    const { ctx, dreaming } = await harness(
      { maxPromotions: 2, capacityTriggerRatio: 0.5, staleAfterDays: 30 },
      { feedback: fakeFeedback(rows), memory: fakeMemory({ agentLessons: KNOWN }) },
    )
    const old = '2026-09-01T00:00:00.000Z'
    const first = await dreaming.dream(scope, ['s1'], old)
    expect(first.promoted).toBe(1)
    // The failure stops being recorded, so nothing stages it again and the
    // decay rule drops the promotion the scope never saw again.
    rows.splice(0, rows.length)
    const later = '2026-10-15T00:00:00.000Z'
    const second = await dreaming.dream(scope, ['s1'], later)
    expect(second.pruned).toBe(1)
    expect(dreaming.read(scope)?.promotions).toHaveLength(0)
    await ctx.fiber.dispose()
  })

  it('scores relevance against the scope artifacts, not a stringified record', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong()]),
      // The words that make the candidate relevant live in the artifact's
      // statement; nothing else in the record carries them.
      memory: fakeMemory({ instructions: 'unrelated rules', agentLessons: KNOWN }),
    })
    await dreaming.run('light', scope, ['s1'])
    const deep = await dreaming.run('deep', scope, ['s1'], NOW)
    expect(deep.promoted).toBe(1)
    expect(dreaming.read(scope)?.promotions[0]?.score).toBeGreaterThanOrEqual(0.65)
    await ctx.fiber.dispose()
  })

  it('registers the automatic cycle with the heartbeat when one is mounted', async () => {
    const registered: Array<{ name: string; intervalHours: number }> = []
    const { ctx } = await harness({ intervalHours: 6 }, {
      heartbeat: {
        register: (task: { name: string; intervalHours: number }) => {
          registered.push(task)
          return () => {}
        },
      },
    })
    expect(registered).toMatchObject([{ name: 'dreaming', intervalHours: 6 }])
    await ctx.fiber.dispose()
  })

  it('dreams every workspace the registry knows', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong()]),
      registry: {
        list: () => [{ id: 'ws-1', sessionIds: ['s1'] }, { id: 'ws-2', sessionIds: ['s2'] }],
      },
      memory: fakeMemory(undefined),
    })
    await dreaming.dreamAll()
    expect(dreaming.read(EvolutionScopeId('default', 'ws-1'))?.narratives).toHaveLength(1)
    expect(dreaming.read(EvolutionScopeId('default', 'ws-2'))?.narratives).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('namespaces the automatic cycle under the profile the readers use', async () => {
    const { ctx, dreaming } = await harness({ profile: 'team' }, {
      feedback: fakeFeedback([strong()]),
      registry: { list: () => [{ id: 'ws-1', sessionIds: ['s1'] }] },
      memory: fakeMemory(undefined),
    })
    await dreaming.dreamAll()
    expect(dreaming.read(EvolutionScopeId('team', 'ws-1'))?.narratives).toHaveLength(1)
    // The namespace the cycle used before the fix, and the one every other
    // evolution store names, hold nothing.
    expect(dreaming.read(EvolutionScopeId('workspace', 'ws-1'))).toBeUndefined()
    expect(dreaming.read(EvolutionScopeId('default', 'ws-1'))).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('merges a REM narrative and a deep pass that write together', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong()]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    // Both phases read a scope that holds no record yet and then write. The
    // second write merges into the record the first committed instead of
    // replacing it, which is what keeps the other phase's field.
    const [rem, deep] = await Promise.all([
      dreaming.run('rem', scope, ['s1'], NOW),
      dreaming.run('deep', scope, ['s1'], NOW),
    ])
    expect(rem.staged).toBe(1)
    expect(deep.promoted).toBe(1)
    const record = dreaming.read(scope)
    expect(record?.narratives).toHaveLength(1)
    expect(record?.promotions).toHaveLength(1)
    expect(record?.ledger).toHaveLength(1)
    await ctx.fiber.dispose()
  })


  it('merges repeated statements with different tools into one candidate', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([
        strong({ tool: 'bash', count: 4, sessions: 3 }),
        strong({ tool: 'pwsh', count: 5, sessions: 1, firstAt: '2026-08-20T00:00:00.000Z' }),
        strong({ tool: null, message: '   ' }),
      ]),
    })
    const light = await dreaming.run('light', scope, ['s1'])
    // The blank message is dropped, and the two identical statements merge.
    expect(light.staged).toBe(1)
    await ctx.fiber.dispose()
  })

  it('substitutes an empty staged set when REM runs before any light phase', async () => {
    const { ctx, dreaming } = await harness()
    const rem = await dreaming.run('rem', scope, ['s1'])
    expect(rem.staged).toBe(0)
    expect(dreaming.read(scope)?.narratives[0]?.themes).toEqual([])
    await ctx.fiber.dispose()
  })

  it('orders equally scored themes by key so the narrative is stable', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([
        strong({ tool: 'zsh', message: 'zzz failure here' }),
        strong({ tool: 'awk', message: 'aaa failure here' }),
        strong({ tool: 'mv', message: 'mmm failure here' }),
      ]),
    })
    await dreaming.run('light', scope, ['s1'])
    await dreaming.run('rem', scope, ['s1'], NOW)
    expect(dreaming.read(scope)?.narratives[0]?.themes.map(theme => theme.key)).toEqual(['awk', 'mv', 'zsh'])
    await ctx.fiber.dispose()
  })

  it('runs the registered cycle when the heartbeat fires and stops on abort', async () => {
    const tasks: Array<{ run: (signal: AbortSignal) => Promise<void> | void }> = []
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong()]),
      memory: fakeMemory({ agentLessons: KNOWN }),
      registry: { list: () => [{ id: 'ws-1', sessionIds: ['s1'] }] },
      heartbeat: {
        register: (task: { run: (signal: AbortSignal) => Promise<void> | void }) => {
          tasks.push(task)
          return () => {}
        },
      },
    })
    const task = tasks[0]
    if (task === undefined) throw new Error('the cycle did not register')
    await task.run(new AbortController().signal)
    expect(dreaming.read(EvolutionScopeId('default', 'ws-1'))?.narratives).toHaveLength(1)
    // A pass aborted at teardown stops before touching any workspace.
    const aborted = new AbortController()
    aborted.abort()
    await expect(task.run(aborted.signal)).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('drops stale promotions even when capacity is not pressed', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong()]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreaming.run('light', scope, ['s1'])
    await dreaming.run('deep', scope, ['s1'], '2026-09-01T00:00:00.000Z')
    const later = await dreaming.dream(scope, ['s1'], '2026-11-01T00:00:00.000Z')
    expect(later.pruned).toBe(1)
    expect(dreaming.read(scope)?.promotions).toEqual([])
    await ctx.fiber.dispose()
  })

  it('keeps a narrative the scope sees again past the stale window', async () => {
    const { ctx, dreaming } = await harness({ minScore: 0 }, {
      feedback: fakeFeedback([strong()]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    const first = await dreaming.dream(scope, ['s1'], NOW)
    expect(first.promoted).toBe(1)
    // Forty days later the failure is still being recorded: the sighting
    // moves the promotion instant, so the decay rule keeps the narrative.
    const later = '2026-10-23T00:00:00.000Z'
    const again = await dreaming.dream(scope, ['s1'], later)
    expect(again).toMatchObject({ promoted: 0, merged: 0, superseded: 0, pruned: 0 })
    expect(dreaming.promotions(scope).map(promotion => promotion.promotedAt)).toEqual([later])
    // A pass that only moved that instant folded nothing, so it ledgers nothing.
    expect(dreaming.ledger(scope)).toHaveLength(1)
    await ctx.fiber.dispose()
  })


  it('reads no relevance from text without comparable words', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([strong({ message: 'x y z' })]),
      memory: fakeMemory({ agentLessons: 'a b c' }),
    })
    await dreaming.run('light', scope, ['s1'])
    const deep = await dreaming.run('deep', scope, ['s1'], NOW)
    // Neither side carries a comparable word, so relevance is zero and the
    // composite cannot reach the threshold.
    expect(deep.promoted).toBe(0)
    await ctx.fiber.dispose()
  })

  it('widens the merged sighting window to the whole span of one statement', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([
        strong({ count: 4, firstAt: '2026-08-01T00:00:00.000Z', lastAt: '2026-09-10T00:00:00.000Z' }),
        strong({ count: 5, firstAt: '2026-09-01T00:00:00.000Z', lastAt: '2026-09-05T00:00:00.000Z' }),
      ]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreaming.run('light', scope, ['s1'])
    await dreaming.run('deep', scope, ['s1'], NOW)
    // The merged candidate keeps the earliest first sighting and the latest one.
    expect(dreaming.read(scope)?.promotions).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('refuses a candidate that clears the score but fails a count or diversity gate', async () => {
    const { ctx, dreaming } = await harness({}, {
      feedback: fakeFeedback([
        strong({ count: 2, message: 'disk is full while writing the cache' }),
      ]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreaming.run('light', scope, ['s1'])
    const deepOne = await dreaming.run('deep', scope, ['s1'], NOW)
    expect(deepOne.promoted).toBe(0)

    const { ctx: ctxTwo, dreaming: dreamingTwo } = await harness({}, {
      feedback: fakeFeedback([strong({ sessions: 1 })]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreamingTwo.run('light', scope, ['s1'])
    expect((await dreamingTwo.run('deep', scope, ['s1'], NOW)).promoted).toBe(0)
    await ctx.fiber.dispose()
    await ctxTwo.fiber.dispose()
  })

  it('trims to the hard bound once the retention ratio is crossed', async () => {
    const { ctx, dreaming } = await harness(
      { maxPromotions: 2, capacityTriggerRatio: 0.5 },
      {
        feedback: fakeFeedback([
          strong(),
          strong({ tool: null, message: 'the cache write fails when the disk is full again' }),
        ]),
        memory: fakeMemory({ agentLessons: KNOWN }),
      },
    )
    const report = await dreaming.dream(scope, ['s1'], NOW)
    expect(report.promoted).toBe(2)
    expect(dreaming.read(scope)?.promotions).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('does nothing when the registry is absent', async () => {
    const { ctx, dreaming } = await harness({}, { feedback: fakeFeedback([strong()]) })
    await expect(dreaming.dreamAll()).resolves.toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('dreaming promotion path', () => {
  it('counts every gate that refused a candidate, by named reason', async () => {
    const { ctx, dreaming } = await harness({ minScore: 0 }, {
      feedback: fakeFeedback([
        strong({ count: 2, message: 'disk is full while writing the first cache' }),
        strong({ count: 2, message: 'disk is full while writing the second cache' }),
        strong({ sessions: 1, message: 'disk is full while writing the third cache' }),
      ]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreaming.run('light', scope, ['s1'])
    const deep = await dreaming.run('deep', scope, ['s1'], NOW)
    expect(deep.promoted).toBe(0)
    expect(deep.refused).toEqual([
      { reason: 'below-diversity', count: 1 },
      { reason: 'below-recall', count: 2 },
    ])
    await ctx.fiber.dispose()
  })

  it('folds a restatement into the narrative it restates instead of promoting a near-duplicate', async () => {
    const { ctx, dreaming } = await harness({ minScore: 0 }, {
      feedback: fakeFeedback([
        strong(),
        strong({ count: 5, sessions: 3, message: 'disk is full while writing the cache again' }),
      ]),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreaming.run('light', scope, ['s1'])
    const deep = await dreaming.run('deep', scope, ['s1'], NOW)
    expect(deep).toMatchObject({ promoted: 1, merged: 1, superseded: 0 })
    const answering = dreaming.promotions(scope)
    expect(answering).toHaveLength(1)
    expect(answering[0]?.statement).toBe('disk is full while writing the cache')
    expect(answering[0]?.restatements).toEqual(['disk is full while writing the cache again'])
    await ctx.fiber.dispose()
  })

  it('retires the predecessor a correction replaces, which stops answering', async () => {
    const rows: SummaryRow[] = [strong()]
    const { ctx, dreaming } = await harness({ minScore: 0 }, {
      feedback: fakeFeedback(rows),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreaming.run('light', scope, ['s1'])
    await dreaming.run('deep', scope, ['s1'], NOW)
    const predecessor = dreaming.promotions(scope)[0]
    expect(predecessor?.statement).toBe('disk is full while writing the cache')

    rows.splice(0, rows.length, strong({ message: 'disk full while writing the local drive' }))
    await dreaming.run('light', scope, ['s1'])
    const deep = await dreaming.run('deep', scope, ['s1'], NOW)
    expect(deep).toMatchObject({ promoted: 1, merged: 0, superseded: 1 })
    const answering = dreaming.promotions(scope)
    expect(answering.map(promotion => promotion.statement)).toEqual(['disk full while writing the local drive'])
    // The retired narrative keeps its place and its evidence in the record.
    const record = dreaming.read(scope)
    expect(record?.promotions).toHaveLength(2)
    expect(record?.promotions[1]).toMatchObject({
      id: predecessor?.id,
      supersededBy: answering[0]?.id,
      supersededAt: NOW,
    })
    await ctx.fiber.dispose()
  })

  it('restores exactly the promotions a pass replaced, and stays reversible', async () => {
    const rows: SummaryRow[] = [strong()]
    const { ctx, dreaming } = await harness({ minScore: 0 }, {
      feedback: fakeFeedback(rows),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    expect(dreaming.promotions(scope)).toEqual([])
    expect(dreaming.ledger(scope)).toEqual([])
    await dreaming.run('light', scope, ['s1'])
    await dreaming.run('deep', scope, ['s1'], NOW)
    const preimage = structuredClone(dreaming.read(scope)?.promotions)

    rows.splice(0, rows.length, strong({ message: 'disk full while writing the local drive' }))
    await dreaming.run('light', scope, ['s1'])
    await dreaming.run('deep', scope, ['s1'], NOW)
    const entries = dreaming.ledger(scope)
    expect(entries).toHaveLength(2)
    const correction = entries[0]
    if (correction === undefined) throw new Error('the correction was not ledgered')

    const report = await dreaming.rollback(scope, correction.id, NOW)
    expect(report.label).toBe(`pass '${correction.id}'`)
    expect(report.restored).toEqual(preimage?.map(promotion => ({
      id: promotion.id,
      statement: promotion.statement,
    })))
    expect(dreaming.read(scope)?.promotions).toEqual(preimage)
    expect(dreaming.promotions(scope)).toEqual(preimage)

    // The rollback ledgered its own preimage, so it is as reversible as the
    // pass it undid.
    expect(dreaming.ledger(scope)[0]?.id).toBe(report.preRollback)
    const reversed = await dreaming.rollback(scope, report.preRollback, NOW)
    expect(reversed.restored).toEqual([{
      id: correction.after[0]?.id,
      statement: correction.after[0]?.statement,
    }])
    expect(dreaming.read(scope)?.promotions).toEqual(correction.after)
    await ctx.fiber.dispose()
  })

  it('fails a rollback of an unknown entry before writing anything', async () => {
    const { ctx, dreaming } = await harness({}, { feedback: fakeFeedback([strong()]) })
    await expect(dreaming.rollback(scope, 'missing')).rejects.toThrow(/unknown ledger entry 'missing'/)
    expect(dreaming.read(scope)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('bounds the ledger to the newest passes', async () => {
    const rows: SummaryRow[] = [strong()]
    const { ctx, dreaming } = await harness({ minScore: 0, maxLedgerEntries: 1 }, {
      feedback: fakeFeedback(rows),
      memory: fakeMemory({ agentLessons: KNOWN }),
    })
    await dreaming.dream(scope, ['s1'], NOW)
    rows.splice(0, rows.length, strong({ message: 'disk full while writing the local drive' }))
    await dreaming.dream(scope, ['s1'], NOW)
    const entries = dreaming.ledger(scope)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.at).toBe(NOW)
    expect(entries[0]?.evidence).toMatchObject({ promoted: 1, superseded: 1, rollbackOf: null })
    await ctx.fiber.dispose()
  })
})
