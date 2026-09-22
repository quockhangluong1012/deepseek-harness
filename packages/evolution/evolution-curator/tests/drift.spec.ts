import { describe, expect, it } from 'vitest'
import type { FeedbackSignal } from '@deepseek-ai/dsh-evolution-feedback'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { dependencyChanged, driftReason, driftSignals } from '../src/drift.ts'
import type { DriftFloors, RecordedExperiment } from '../src/drift.ts'

const NOW = Date.parse('2026-06-15T00:00:00.000Z')
const DAY = 86_400_000

const floors: DriftFloors = { windowDays: 14, utilityFloor: 0 }

/** A usage record with the fields the drift rules read pinned. */
function usage(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    useCount: 1,
    viewCount: 0,
    patchCount: 0,
    lastUsedAt: new Date(NOW).toISOString(),
    sessionIds: ['s-1'],
    sessionOutcomes: [],
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: new Date(NOW).toISOString(),
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
    ...overrides,
  }
}

/** One decisive graded failure, as the feedback store merges it. */
function decisive(): FeedbackSignal {
  return {
    tool: 'bash',
    message: 'broken',
    count: 3,
    sessions: 2,
    firstAt: 't0',
    lastAt: 't1',
    actionability: 'trigger_review',
    evidenceStatus: 'complete',
    mergeKey: 'bash\u0000broken',
  }
}

/** One graded failure the pass may only observe. */
function observeOnly(): FeedbackSignal {
  return { ...decisive(), actionability: 'observe_only' }
}

/** One recorded envelope with the fields the version rule compares. */
function envelope(at: number, dependencies: Record<string, string | undefined>): RecordedExperiment {
  return { skill: 'writer', at: new Date(at).toISOString(), dependencies }
}

describe('drift reason', () => {
  it('names every signal that fired, in a fixed order', () => {
    expect(driftReason({
      failureSpike: false,
      conflictingEvidence: false,
      lowUtility: false,
      versionChange: false,
    })).toBeUndefined()
    expect(driftReason({
      failureSpike: true,
      conflictingEvidence: true,
      lowUtility: false,
      versionChange: true,
    })).toBe('drift: failure spike, conflicting evidence, dependency version change')
  })
})

describe('dependency version changes', () => {
  it('compares the newest envelope with the one before it', () => {
    expect(dependencyChanged([], NOW)).toBe(false)
    // One envelope has nothing to compare against.
    expect(dependencyChanged([envelope(NOW + DAY, { tool: '1.0' })], NOW)).toBe(false)
    expect(dependencyChanged([
      envelope(NOW + DAY, { tool: '1.0' }),
      envelope(NOW + 2 * DAY, { tool: '2.0' }),
    ], NOW)).toBe(true)
    expect(dependencyChanged([
      envelope(NOW + DAY, { tool: '1.0' }),
      envelope(NOW + 2 * DAY, { tool: '1.0' }),
    ], NOW)).toBe(false)
  })

  it('reads the envelopes in time order regardless of recording order', () => {
    expect(dependencyChanged([
      envelope(NOW + 2 * DAY, { tool: '2.0' }),
      envelope(NOW + DAY, { tool: '1.0' }),
    ], NOW)).toBe(true)
  })

  it('ignores the skill version itself and envelopes the last use covers', () => {
    // The artifact under change is not the environment it was validated in.
    expect(dependencyChanged([
      envelope(NOW + DAY, { tool: '1.0', skill: 'a' }),
      envelope(NOW + 2 * DAY, { tool: '1.0', skill: 'b' }),
    ], NOW)).toBe(false)
    // A change the skill's own recorded use is newer than says nothing new.
    expect(dependencyChanged([
      envelope(NOW - 2 * DAY, { tool: '1.0' }),
      envelope(NOW - DAY, { tool: '2.0' }),
    ], NOW)).toBe(false)
  })
})

describe('drift signals', () => {
  it('reads an unanswered failure spike only from a decisive recent signal', () => {
    const unanswered = usage({
      lastUsedAt: new Date(NOW - DAY).toISOString(),
      lastTrustFailure: { mergeKey: 'k', message: 'm', at: new Date(NOW - 2 * 3600 * 1000).toISOString() },
    })
    const fired = (record: SkillUsageRecord, signals: readonly FeedbackSignal[]) =>
      driftSignals(record, [], signals, [], [], NOW, floors).failureSpike

    expect(fired(unanswered, [decisive()])).toBe(true)
    // Only an observe-only grading is no spike.
    expect(fired(unanswered, [observeOnly()])).toBe(false)
    // A failure older than the window is no longer recent.
    expect(fired(usage({
      lastTrustFailure: { mergeKey: 'k', message: 'm', at: new Date(NOW - 30 * DAY).toISOString() },
    }), [decisive()])).toBe(false)
    // A later load answered it.
    expect(fired(usage({
      lastTrustFailure: { mergeKey: 'k', message: 'm', at: new Date(NOW - DAY).toISOString() },
    }), [decisive()])).toBe(false)
    // No attributed failure at all.
    expect(fired(usage(), [decisive()])).toBe(false)
  })

  it('reads conflicting evidence only when it is newer than the last reliance', () => {
    const fired = (conflicts: readonly string[]) =>
      driftSignals(usage(), [], [], conflicts, [], NOW, floors).conflictingEvidence
    expect(fired([new Date(NOW + 1000).toISOString()])).toBe(true)
    expect(fired([new Date(NOW - 1000).toISOString()])).toBe(false)
    expect(fired([])).toBe(false)
  })

  it('reads low utility only against a peer baseline', () => {
    const quiet = usage({ sessionOutcomes: [{ sessionId: 's-1', outcome: 'ok' }, { sessionId: 's-2', outcome: 'ok' }] })
    const trailing = usage({ sessionOutcomes: [{ sessionId: 's-1', outcome: 'failed' }] })
    expect(driftSignals(trailing, [quiet], [], [], [], NOW, floors).lowUtility).toBe(true)
    expect(driftSignals(quiet, [trailing], [], [], [], NOW, floors).lowUtility).toBe(false)
    // No peer outcome records no baseline, so nothing is measured.
    expect(driftSignals(trailing, [], [], [], [], NOW, floors).lowUtility).toBe(false)
  })

  it('reads a version change against the last use and leaves a fresh use quiet', () => {
    const envelopes = [envelope(NOW + DAY, { tool: '1.0' }), envelope(NOW + 2 * DAY, { tool: '2.0' })]
    expect(driftSignals(usage(), [], [], [], envelopes, NOW, floors).versionChange).toBe(true)
    // A load newer than the change describes an environment the evidence covers.
    expect(driftSignals(usage({ lastUsedAt: new Date(NOW + 3 * DAY).toISOString() }), [], [], [], envelopes, NOW, floors).versionChange)
      .toBe(false)
  })

  it('measures the version change against the newest patch, not only the newest load', () => {
    const envelopes = [envelope(NOW + DAY, { tool: '1.0' }), envelope(NOW + 2 * DAY, { tool: '2.0' })]
    const patched = usage({
      lastUsedAt: null,
      createdAt: new Date(NOW - DAY).toISOString(),
      lastPatchedAt: new Date(NOW + 3 * DAY).toISOString(),
      patchCount: 1,
    })
    expect(driftSignals(patched, [], [], [], envelopes, NOW, floors).versionChange).toBe(false)
  })
})
