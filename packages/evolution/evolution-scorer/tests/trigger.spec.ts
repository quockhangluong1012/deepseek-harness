import { describe, expect, it } from 'vitest'
import type { SkillUsageRecord } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { shouldOptimize } from '../src/trigger.ts'
import type { TriggerThresholds } from '../src/types.ts'

/** One usage record with only the outcome counters varied. */
function usage(useCount: number, failureCount?: number, sessionOutcomes: ('ok' | 'failed')[] = []): SkillUsageRecord {
  return {
    useCount,
    viewCount: 0,
    patchCount: 0,
    lastUsedAt: null,
    sessionIds: [],
    lastViewedAt: null,
    lastPatchedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    state: 'active',
    pinned: false,
    trust: 'trusted',
    trustFailures: 0,
    trustObservedSessions: [],
    trustAnchorSessionId: null,
    lastTrustFailure: null,
    sessionOutcomes: sessionOutcomes.map((outcome, index) => ({ sessionId: `s${index}`, outcome })),
    revision: 0,
    contentSha: null,
    parentRevisionSha: null,
    createdBy: null,
    absorbedInto: null,
    archivedAt: null,
    suspectAt: null,
    ...failureCount === undefined ? {} : { failureCount },
  }
}

const THRESHOLDS: TriggerThresholds = { minUses: 20, failureRate: 0.3 }

describe('optimization trigger', () => {
  it('fires over both thresholds only', () => {
    // 7/21 is over 30% with the sample gate met.
    expect(shouldOptimize(usage(14, 7), THRESHOLDS)).toBe(true)
    // 6/20 is exactly the threshold, which is not yet over it.
    expect(shouldOptimize(usage(14, 6), THRESHOLDS)).toBe(false)
    // 3/3 is a perfect rate over three loads, which says nothing yet.
    expect(shouldOptimize(usage(0, 3), THRESHOLDS)).toBe(false)
    // Twenty clean loads never trigger.
    expect(shouldOptimize(usage(20), THRESHOLDS)).toBe(false)
  })

  it('reads a missing failure count as zero failures', () => {
    expect(shouldOptimize(usage(25), THRESHOLDS)).toBe(false)
  })

  it('reads task outcomes over skill-load errors when the curator has graded sessions', () => {
    // The tool-load counters show no failures, but the curator's own
    // session-outcome grading (verification/feedback per task) says 7 of 21
    // graded sessions failed — over threshold, so this decides.
    const graded = [...Array(14).fill('ok'), ...Array(7).fill('failed')] as ('ok' | 'failed')[]
    expect(shouldOptimize(usage(21, 0, graded), THRESHOLDS)).toBe(true)
    expect(shouldOptimize(usage(21), THRESHOLDS)).toBe(false)
  })

  it('gates minUses on graded sessions, not on tool loads, once grading exists', () => {
    // Only 3 graded sessions, all failed — below the sample gate even though
    // the tool-load counters alone would have crossed it.
    const graded = ['failed', 'failed', 'failed'] as ('ok' | 'failed')[]
    expect(shouldOptimize(usage(0, 100, graded), THRESHOLDS)).toBe(false)
  })
})
