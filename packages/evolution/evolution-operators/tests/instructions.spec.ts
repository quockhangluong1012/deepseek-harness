import { describe, expect, it } from 'vitest'
import { instructionAdjustment, judgedInstruction, proposedInstruction } from '../src/instructions.ts'
import type { InstructionInput, InstructionVerdict, OperatorInstruction } from '../src/types.ts'

const proposal = (overrides: Partial<InstructionInput> = {}): InstructionInput => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  instruction: 'Rewrite the body in the order the evidence supports.',
  reason: 'two runs regressed on rule order',
  ...overrides,
})

const verdict = (overrides: Partial<InstructionVerdict> = {}): InstructionVerdict => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  accepted: true,
  reason: 'the reordered body passed the holdout',
  ...overrides,
})

const row = (overrides: Partial<OperatorInstruction> = {}): OperatorInstruction => ({
  operator: 'rewrite',
  artifactClass: 'writer',
  instruction: 'Rewrite the body in the order the evidence supports.',
  reason: 'two runs regressed on rule order',
  proposals: 1,
  accepted: 0,
  rejected: 0,
  lastVerdict: null,
  at: '2026-01-01T00:00:00.000Z',
  decidedAt: null,
  ...overrides,
})

describe('proposedInstruction', () => {
  it('opens the row on a first proposal', () => {
    const stored = proposedInstruction(undefined, proposal(), '2026-01-02T00:00:00.000Z')
    expect(stored).toEqual({
      operator: 'rewrite',
      artifactClass: 'writer',
      instruction: 'Rewrite the body in the order the evidence supports.',
      reason: 'two runs regressed on rule order',
      proposals: 1,
      accepted: 0,
      rejected: 0,
      lastVerdict: null,
      at: '2026-01-02T00:00:00.000Z',
      decidedAt: null,
    })
  })

  it('keeps the verdicts of the same text and counts another proposal', () => {
    const current = row({ proposals: 2, accepted: 1, rejected: 1, lastVerdict: 'mixed', decidedAt: '2026-01-03T00:00:00.000Z' })
    const stored = proposedInstruction(current, proposal({ reason: 'still the best reading' }), '2026-01-04T00:00:00.000Z')
    expect(stored).toMatchObject({
      proposals: 3,
      accepted: 1,
      rejected: 1,
      lastVerdict: 'mixed',
      reason: 'still the best reading',
      decidedAt: '2026-01-03T00:00:00.000Z',
    })
  })

  it('starts a different text over, because the evidence judged the old one', () => {
    const current = row({ proposals: 2, accepted: 1, rejected: 1, lastVerdict: 'rewritten body regressed', decidedAt: '2026-01-03T00:00:00.000Z' })
    const stored = proposedInstruction(current, proposal({ instruction: 'Add the precondition the failures share.' }), '2026-01-04T00:00:00.000Z')
    expect(stored).toMatchObject({
      instruction: 'Add the precondition the failures share.',
      proposals: 3,
      accepted: 0,
      rejected: 0,
      lastVerdict: null,
      decidedAt: null,
      at: '2026-01-04T00:00:00.000Z',
    })
  })
})

describe('judgedInstruction', () => {
  it('counts an acceptance and names the verdict behind it', () => {
    const stored = judgedInstruction(row(), verdict(), '2026-01-05T00:00:00.000Z')
    expect(stored).toMatchObject({
      accepted: 1,
      rejected: 0,
      lastVerdict: 'the reordered body passed the holdout',
      decidedAt: '2026-01-05T00:00:00.000Z',
      proposals: 1,
    })
  })

  it('counts a rejection', () => {
    const stored = judgedInstruction(row({ accepted: 1 }), verdict({ accepted: false, reason: 'the holdout failed twice' }), '2026-01-05T00:00:00.000Z')
    expect(stored).toMatchObject({ accepted: 1, rejected: 1, lastVerdict: 'the holdout failed twice' })
  })
})

describe('instructionAdjustment', () => {
  it('nudges nothing without a proposal or without a verdict', () => {
    expect(instructionAdjustment(undefined, 0.2)).toBe(0)
    expect(instructionAdjustment(row(), 0.2)).toBe(0)
  })

  it('scales the accepted share by the weight', () => {
    expect(instructionAdjustment(row({ accepted: 3, rejected: 1 }), 0.4)).toBeCloseTo(0.2, 10)
    expect(instructionAdjustment(row({ accepted: 0, rejected: 2 }), 0.25)).toBeCloseTo(-0.25, 10)
  })
})
