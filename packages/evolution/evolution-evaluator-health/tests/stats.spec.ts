import { describe, expect, it } from 'vitest'
import { channelHealth, judgeCalibration, summarizeHealth } from '../src/index.ts'
import type { EvaluatorRun } from '../src/index.ts'

const run = (overrides: Partial<EvaluatorRun> & { id: string }): EvaluatorRun => ({
  skill: 'writer',
  unanimous: true,
  status: 'evaluated',
  approved: true,
  approving: ['contract', 'routing', 'replay'],
  dissenting: [],
  at: '2026-06-01T00:00:00.000Z',
  ...overrides,
})

describe('evaluator health stats', () => {
  it('returns zeros for no verdicts', () => {
    const summary = summarizeHealth([], 20)
    expect(summary).toMatchObject({
      runs: 0,
      unanimousRate: 0,
      approvalRate: 0,
      recentApprovalRate: 0,
      drift: 0,
      falsePositiveRate: 0,
    })
    expect(summary.channels).toHaveLength(3)
    expect(summary.channels.every(row => row.runs === 0 && row.approvalRate === 0)).toBe(true)
  })

  it('aggregates rates and drift over the newest window', () => {
    const runs = [
      run({ id: 'n1', at: '2026-07-01T00:00:00.000Z', approved: true }),
      run({ id: 'n2', at: '2026-06-30T00:00:00.000Z', approved: false, unanimous: false, dissenting: ['replay'] }),
      run({ id: 'o1', at: '2026-06-01T00:00:00.000Z', approved: false, unanimous: false, dissenting: ['replay'] }),
    ]
    const summary = summarizeHealth(runs, 2)
    expect(summary.runs).toBe(3)
    expect(summary.unanimousRate).toBeCloseTo(1 / 3)
    expect(summary.approvalRate).toBeCloseTo(1 / 3)
    expect(summary.recentApprovalRate).toBeCloseTo(1 / 2)
    expect(summary.drift).toBeCloseTo(1 / 2 - 1 / 3)
  })

  it('counts an approval later contradicted by a same-skill rejection as a false positive', () => {
    const runs = [
      run({ id: 'newer', at: '2026-07-01T00:00:00.000Z', approved: false, unanimous: false, dissenting: ['replay'] }),
      run({ id: 'older', at: '2026-06-01T00:00:00.000Z', approved: true }),
    ]
    const falseRate = summarizeHealth(runs, 20).falsePositiveRate
    expect(falseRate).toBeCloseTo(1)

    const clean = [
      run({ id: 'b', at: '2026-07-01T00:00:00.000Z', approved: true }),
    ]
    expect(summarizeHealth(clean, 20).falsePositiveRate).toBe(0)

    // An approval never contradicted by a NEWER same-skill rejection is clean.
    const only = [
      run({ id: 'x', at: '2026-07-01T00:00:00.000Z', approved: false, skill: 'other' }),
      run({ id: 'y', at: '2026-07-01T00:00:00.000Z', approved: true }),
    ]
    expect(summarizeHealth(only, 20).falsePositiveRate).toBe(0)
  })

  it('computes per-channel approval over participating verdicts', () => {
    const rows = channelHealth([
      run({ id: 'a', approving: ['contract', 'routing'], dissenting: ['replay'] }),
      run({ id: 'b', approving: ['contract'], dissenting: ['routing', 'replay'], unanimous: false }),
      run({ id: 'c', approved: false, approving: [], dissenting: ['contract', 'routing', 'replay'], unanimous: false }),
    ])
    expect(rows).toEqual([
      { channel: 'contract', runs: 3, approved: 2, approvalRate: 2 / 3 },
      { channel: 'routing', runs: 3, approved: 1, approvalRate: 1 / 3 },
      { channel: 'replay', runs: 3, approved: 0, approvalRate: 0 },
    ])
  })

  it('reports zero rates where no channel participated and no verdict approved', () => {
    const one = channelHealth([run({ id: 'a', approving: ['contract'], dissenting: ['routing'], unanimous: false })])
    expect(one).toEqual([
      { channel: 'contract', runs: 1, approved: 1, approvalRate: 1 },
      { channel: 'routing', runs: 1, approved: 0, approvalRate: 0 },
      { channel: 'replay', runs: 0, approved: 0, approvalRate: 0 },
    ])
    const rejected = summarizeHealth([run({ id: 'r', approved: false, unanimous: false, approving: [], dissenting: ['contract', 'routing', 'replay'] })], 20)
    expect(rejected.falsePositiveRate).toBe(0)
    expect(rejected.approvalRate).toBe(0)
  })
})

describe('judgeCalibration', () => {
  it('counts a rejection later contradicted by an approval as a false negative', () => {
    const runs = [
      run({ id: 'newer', at: '2026-07-01T00:00:00.000Z', approved: true, approving: ['contract', 'routing', 'replay'] }),
      run({ id: 'older', at: '2026-06-01T00:00:00.000Z', approved: false, unanimous: false, approving: [], dissenting: ['contract', 'routing', 'replay'] }),
    ]
    const calibration = judgeCalibration(runs)
    // The false-positive counter sees no approval contradicted by a rejection.
    expect(summarizeHealth(runs, 20).falsePositiveRate).toBe(0)
    expect(calibration.falseNegativeRate).toBe(1)
    expect(calibration.independentlyJudged).toBe(0)
    expect(calibration.agreementRate).toBe(0)
  })

  it('ignores a contradiction from an older verdict and from another skill', () => {
    const otherSkill = [
      run({ id: 'a', at: '2026-07-01T00:00:00.000Z', approved: false, skill: 'other' }),
      run({ id: 'b', at: '2026-06-01T00:00:00.000Z', approved: false, unanimous: false, approving: [], dissenting: ['replay'] }),
    ]
    expect(judgeCalibration(otherSkill).falseNegativeRate).toBe(0)
    expect(judgeCalibration([]).falseNegativeRate).toBe(0)
    expect(judgeCalibration([run({ id: 'only', approved: false }) ]).falseNegativeRate).toBe(0)
  })

  it('correlates the verdict with the independent ground truths that judged it', () => {
    const runs = [
      run({ id: 'agreed', approved: true, judgment: { agrees: true, independent: true, at: '2026-07-02T00:00:00.000Z' } }),
      run({ id: 'overruled', approved: true, judgment: { agrees: false, independent: true, at: '2026-07-02T00:00:00.000Z' } }),
      // A judgment the evaluator itself produced does not correlate with anything.
      run({ id: 'self', approved: true, judgment: { agrees: true, independent: false, at: '2026-07-02T00:00:00.000Z' } }),
      run({ id: 'unjudged', approved: true }),
    ]
    expect(judgeCalibration(runs)).toEqual({
      falseNegativeRate: 0,
      independentlyJudged: 2,
      agreementRate: 0.5,
    })
  })
})
