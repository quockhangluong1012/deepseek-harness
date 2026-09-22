import { describe, expect, it } from 'vitest'
import type { BenchmarkTask } from '@deepseek-ai/dsh-evolution-benchmark'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import type { Claim } from '@deepseek-ai/dsh-evolution-graph'
import type { StagedWrite } from '@deepseek-ai/dsh-evolution-memory'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import {
  NUDGE_CONDITIONS,
  NUDGE_EVALUATORS,
  contradictedClaimLine,
  failureSignalLine,
  holdoutGapLine,
  skillTrustLine,
  stagedWriteLine,
  unevaluableLine,
  type NudgeCondition,
  type NudgeConditionId,
  type NudgeDeps,
  type NudgeEvidence,
} from '../src/conditions.ts'

const SCOPE = EvolutionScopeId('test', 'ws')

/** One staged write awaiting a decision. */
function staged(createdAt: string, id = 'staged-1'): StagedWrite {
  return {
    id,
    kind: 'memory',
    op: 'setInstructions',
    payload: { text: 'rules' },
    originSessionId: 's1',
    createdAt,
    gist: 'instructions from s1',
    mergeKey: null,
    recurrence: 1,
    blockedReason: null,
    neededEvidence: [],
  }
}

/** One claim with the belief fields the graph derives. */
function claim(contradictionCount: number, id = 'claim-1'): Claim {
  return {
    id,
    statement: 'the build is green',
    status: 'active',
    retiredBy: null,
    confidence: 0.5,
    evidenceQuality: 1,
    sourceReliability: 1,
    independentSupport: 1,
    contradictionCount,
    recency: '2026-09-20T00:00:00.000Z',
    supportedBy: [],
    contradictedBy: [],
    observedIn: [],
    supersedes: [],
    derivedFrom: [],
    usedBy: [],
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
  }
}

/** One graded failure signal, decisive by default. */
function signal(actionability: FeedbackSignal['actionability'], mergeKey = 'bash\u0000boom'): FeedbackSignal {
  return {
    tool: 'bash',
    message: 'boom',
    count: 2,
    firstAt: '2026-09-20T00:00:00.000Z',
    lastAt: '2026-09-20T01:00:00.000Z',
    sessions: 2,
    actionability,
    evidenceStatus: 'complete',
    mergeKey,
  }
}

/** One skill usage record, trusted and undemoted by default. */
function usage(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    useCount: 3,
    viewCount: 1,
    patchCount: 0,
    lastUsedAt: '2026-09-20T00:00:00.000Z',
    sessionIds: ['s1'],
    sessionOutcomes: [],
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    state: 'active',
    pinned: false,
    createdBy: 'agent',
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
    ...overrides,
  }
}

/** One benchmark task probing a capability. */
function task(capability: string, state: BenchmarkTask['state']): BenchmarkTask {
  return {
    id: `${capability}-${state}`,
    hash: 'a'.repeat(64),
    capability,
    task: `probe ${capability}`,
    gists: ['boom'],
    sourceSessions: ['s1'],
    at: '2026-09-20T00:00:00.000Z',
    state,
  }
}

/** The condition registry entry one test targets. */
function condition(id: NudgeConditionId): NudgeCondition {
  return NUDGE_CONDITIONS.find(entry => entry.id === id) as NudgeCondition
}

/** Evidence defaults: no scope resolved and no store mounted. */
function evidence(overrides: Partial<NudgeEvidence> = {}): NudgeEvidence {
  return { scope: SCOPE, sessionIds: ['s1'], now: Date.parse('2026-09-22T00:00:00.000Z'), ...overrides }
}

/** Dependency defaults: every optional store unmounted. */
function deps(overrides: Partial<NudgeDeps> = {}): NudgeDeps {
  return {
    record: undefined,
    graph: undefined,
    feedback: undefined,
    telemetry: undefined,
    benchmark: undefined,
    stagedWriteWaitMinutes: 60,
    failureSignalScanLimit: 20,
    ...overrides,
  }
}

describe('recorded nudge conditions', () => {
  it('covers every section and store once', () => {
    expect(NUDGE_CONDITIONS.map(entry => entry.id)).toEqual([
      'staged-writes', 'contradicted-claims', 'skill-trust', 'failure-signals', 'holdout-gaps',
    ])
    expect(NUDGE_CONDITIONS.map(entry => entry.section)).toEqual([
      'memory', 'memory', 'skills', 'skills', 'skills',
    ])
    expect(NUDGE_CONDITIONS.map(entry => entry.store)).toEqual([
      'evolutionMemory', 'evolutionGraph', 'evolutionSkillTelemetry', 'evolutionFeedback', 'evolutionBenchmark',
    ])
  })

  it('names the unmounted store rather than guessing', () => {
    expect(unevaluableLine(condition('contradicted-claims')))
      .toBe('contradicted claims cannot be checked: the evolutionGraph store is not mounted.')
    expect(unevaluableLine(condition('skill-trust')))
      .toBe('skill trust cannot be checked: the evolutionSkillTelemetry store is not mounted.')
  })

  it('renders a staged write only once one waited past the window', () => {
    const now = Date.parse('2026-09-22T00:00:00.000Z')
    expect(stagedWriteLine([], 60, now)).toBeUndefined()
    expect(stagedWriteLine([staged('2026-09-21T23:30:00.000Z')], 60, now)).toBeUndefined()
    expect(stagedWriteLine([
      staged('2026-09-21T10:00:00.000Z'),
      staged('2026-09-21T11:00:00.000Z', 'staged-2'),
    ], 60, now)).toBe(
      'Staged writes: 2 pending, the oldest since 2026-09-21T10:00:00.000Z, past the 60-minute review window; run /memory pending.',
    )
  })

  it('renders contradicted claims and stays quiet while none is', () => {
    expect(contradictedClaimLine([])).toBeUndefined()
    expect(contradictedClaimLine([claim(0)])).toBeUndefined()
    expect(contradictedClaimLine([claim(2), claim(0, 'claim-2')]))
      .toBe('Contradicted claims: 1 active claim with contradicting evidence; run /claims.')
    expect(contradictedClaimLine([claim(1), claim(1, 'claim-2')]))
      .toBe('Contradicted claims: 2 active claims with contradicting evidence; run /claims.')
  })

  it('renders failure signals the store graded decisive', () => {
    expect(failureSignalLine([])).toBeUndefined()
    expect(failureSignalLine([signal('ranking_only'), signal('observe_only', 'other')])).toBeUndefined()
    expect(failureSignalLine([signal('trigger_review'), signal('ranking_only', 'other')]))
      .toBe('Failure signals: 1 at the review threshold across this scope\'s sessions; record the durable lesson with skill_manage.')
  })

  it('renders skills whose trust fell and stays quiet for answered demotions', () => {
    expect(skillTrustLine([])).toBeUndefined()
    expect(skillTrustLine([{ name: 'catalog', usage: usage() }])).toBeUndefined()
    expect(skillTrustLine([{ name: 'catalog', usage: usage({ trust: 'provisional', trustFailures: 2 }) }]))
      .toBe('Skill trust: 1 provisional after a recorded failure; run /curator status.')
  })

  it('renders capabilities under evaluation without a holdout', () => {
    expect(holdoutGapLine([])).toBeUndefined()
    expect(holdoutGapLine([task('writer', 'search'), task('writer', 'holdout')])).toBeUndefined()
    // Only terminal tasks, so nothing is under evaluation.
    expect(holdoutGapLine([task('writer', 'contaminated'), task('writer', 'retired')])).toBeUndefined()
    expect(holdoutGapLine([
      task('writer', 'validation'),
      task('reader', 'fresh'),
      task('reader', 'holdout'),
    ])).toBe('Benchmark holdouts: 1 under evaluation with no holdout task; run /benchmark.')
  })

  it('stays quiet for a scope condition with no scope to read', () => {
    const noScope = evidence({ scope: undefined })
    expect(NUDGE_EVALUATORS['staged-writes'](condition('staged-writes'), noScope, deps({
      record: { staged: [staged('2026-09-01T00:00:00.000Z')] } as never,
    }))).toBeUndefined()
    expect(NUDGE_EVALUATORS['contradicted-claims'](condition('contradicted-claims'), noScope, deps({
      graph: { claims: () => [claim(1)] } as never,
    }))).toBeUndefined()
  })

  it('reads the scope record and the graph for the memory conditions', () => {
    const read: EvolutionScopeId[] = []
    const record = { staged: [staged('2026-09-01T00:00:00.000Z')] }
    expect(NUDGE_EVALUATORS['staged-writes'](condition('staged-writes'), evidence(), deps({
      record: record as never,
      stagedWriteWaitMinutes: 60,
    }))).toContain('1 pending')
    expect(NUDGE_EVALUATORS['staged-writes'](condition('staged-writes'), evidence(), deps())).toBeUndefined()
    expect(NUDGE_EVALUATORS['contradicted-claims'](condition('contradicted-claims'), evidence(), deps({
      graph: { claims: (scope: EvolutionScopeId) => { read.push(scope); return [claim(1)] } } as never,
    }))).toContain('1 active')
    expect(read).toEqual([SCOPE])
  })

  it('reads each skill condition from its own store and names the unmounted one', () => {
    expect(NUDGE_EVALUATORS['skill-trust'](condition('skill-trust'), evidence(), deps()))
      .toBe('skill trust cannot be checked: the evolutionSkillTelemetry store is not mounted.')
    expect(NUDGE_EVALUATORS['failure-signals'](condition('failure-signals'), evidence(), deps()))
      .toBe('failure signals cannot be checked: the evolutionFeedback store is not mounted.')
    expect(NUDGE_EVALUATORS['holdout-gaps'](condition('holdout-gaps'), evidence(), deps()))
      .toBe('benchmark holdout coverage cannot be checked: the evolutionBenchmark store is not mounted.')

    const scanned: number[] = []
    expect(NUDGE_EVALUATORS['skill-trust'](condition('skill-trust'), evidence(), deps({
      telemetry: { entries: () => [{ name: 'catalog', usage: usage({ trust: 'provisional', trustFailures: 1 }) }] } as never,
    }))).toContain('1 provisional')
    expect(NUDGE_EVALUATORS['failure-signals'](condition('failure-signals'), evidence({ sessionIds: ['s1', 's2'] }), deps({
      feedback: {
        signals: (ids: readonly string[], limit: number) => {
          scanned.push(ids.length, limit)
          return [signal('trigger_review')]
        },
      } as never,
      failureSignalScanLimit: 7,
    }))).toContain('1 at the review threshold')
    expect(scanned).toEqual([2, 7])
    expect(NUDGE_EVALUATORS['holdout-gaps'](condition('holdout-gaps'), evidence(), deps({
      benchmark: { tasks: () => [task('writer', 'fresh')] } as never,
    }))).toContain('1 under evaluation')
  })
})
