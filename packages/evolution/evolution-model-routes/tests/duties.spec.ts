import { describe, expect, it } from 'vitest'
import { dutyKey, separationOfDuties } from '../src/duties.ts'
import type { DutyRecord, EvolutionRole } from '../src/types.ts'

const duty = (role: EvolutionRole, identity: string, runId = 'run-1'): DutyRecord => ({
  runId,
  role,
  identity,
  at: '2026-09-12T00:00:00.000Z',
})

describe('dutyKey', () => {
  it('keys one run and role apart from every other pair', () => {
    expect(dutyKey('run-1', 'promotion-review')).toBe('run-1_promotion-review')
    expect(dutyKey('run-1', 'promotion-review')).not.toBe(dutyKey('run-1', 'evaluation'))
    expect(dutyKey('run-1', 'evaluation')).not.toBe(dutyKey('run-2', 'evaluation'))
  })
})

describe('separationOfDuties', () => {
  it('separates a promotion from the identity that generated its candidate', () => {
    expect(separationOfDuties([
      duty('candidate-generation', 'agent-a'),
      duty('promotion-review', 'agent-b'),
    ], 'run-1', 'promotion')).toEqual({ allowed: true })
    expect(separationOfDuties([
      duty('candidate-generation', 'agent-a'),
      duty('promotion-review', 'agent-a'),
    ], 'run-1', 'promotion')).toEqual({
      allowed: false,
      refusal: 'same-identity',
      reason: "identity 'agent-a' filled both candidate-generation and promotion-review for run 'run-1'",
    })
  })

  it('separates a curator consolidation apply from the identity that proposed it', () => {
    expect(separationOfDuties([
      duty('candidate-generation', 'evolution-curator', 'pass-1'),
      duty('promotion-review', 'operator-1', 'pass-1'),
    ], 'pass-1', 'consolidation')).toEqual({ allowed: true })
    expect(separationOfDuties([
      duty('candidate-generation', 'evolution-curator', 'pass-1'),
      duty('promotion-review', 'evolution-curator', 'pass-1'),
    ], 'pass-1', 'consolidation')).toEqual({
      allowed: false,
      refusal: 'same-identity',
      reason: "identity 'evolution-curator' filled both candidate-generation and promotion-review for run 'pass-1'",
    })
  })

  it('separates a verdict from the identity that generated its candidate', () => {
    expect(separationOfDuties([
      duty('candidate-generation', 'agent-a'),
      duty('evaluation', 'scorer-1'),
    ], 'run-1', 'verdict')).toEqual({ allowed: true })
    expect(separationOfDuties([
      duty('candidate-generation', 'agent-a'),
      duty('evaluation', 'agent-a'),
    ], 'run-1', 'verdict')).toEqual({
      allowed: false,
      refusal: 'same-identity',
      reason: "identity 'agent-a' filled both candidate-generation and evaluation for run 'run-1'",
    })
  })

  it('refuses an unrecorded judging role as unknown rather than assuming it distinct', () => {
    expect(separationOfDuties([duty('candidate-generation', 'agent-a')], 'run-1', 'promotion')).toEqual({
      allowed: false,
      refusal: 'unknown-identity',
      reason: "run 'run-1' records no promotion-review identity, so candidate-generation and promotion-review cannot be shown to be separate identities",
    })
    expect(separationOfDuties([duty('candidate-generation', 'agent-a')], 'run-1', 'verdict'))
      .toMatchObject({ refusal: 'unknown-identity', reason: expect.stringContaining('no evaluation identity') as unknown })
  })

  it('refuses an unrecorded producing role as unknown', () => {
    expect(separationOfDuties([duty('promotion-review', 'agent-b')], 'run-1', 'promotion')).toEqual({
      allowed: false,
      refusal: 'unknown-identity',
      reason: "run 'run-1' records no candidate-generation identity, so candidate-generation and promotion-review cannot be shown to be separate identities",
    })
    expect(separationOfDuties([], 'run-1', 'verdict'))
      .toMatchObject({ refusal: 'unknown-identity', reason: expect.stringContaining('no candidate-generation identity') as unknown })
  })

  it('reads an empty identity as unrecorded and another run as a different run', () => {
    expect(separationOfDuties([
      duty('candidate-generation', ''),
      duty('promotion-review', 'agent-b'),
    ], 'run-1', 'promotion')).toMatchObject({ refusal: 'unknown-identity' })
    expect(separationOfDuties([
      duty('candidate-generation', 'agent-a', 'other-run'),
      duty('promotion-review', 'agent-a'),
    ], 'run-1', 'promotion')).toMatchObject({
      refusal: 'unknown-identity',
      reason: expect.stringContaining('no candidate-generation identity') as unknown,
    })
  })
})
