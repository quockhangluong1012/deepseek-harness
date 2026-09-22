import { describe, expect, it } from 'vitest'
import { EVOLUTION_OBJECTIVES, objectiveReadings } from '../src/objectives.ts'
import type { ObjectiveReading, PooledCandidate, SpendRecord } from '../src/types.ts'

const pooled = (overrides: Partial<PooledCandidate> = {}): PooledCandidate => ({
  batchId: 'b1',
  candidateId: 'c1',
  taskClass: 'writer',
  runs: 1,
  passes: 1,
  novelty: 0,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const spend = (overrides: Partial<SpendRecord> = {}): SpendRecord => ({
  batchId: 'b1',
  tokens: 5000,
  wallTimeMs: 60000,
  rollouts: 4,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const reading = (readings: readonly ObjectiveReading[], objective: string) =>
  readings.find(entry => entry.objective === objective)

describe('EVOLUTION_OBJECTIVES', () => {
  it('lists the seven §27 objectives in canonical order', () => {
    expect([...EVOLUTION_OBJECTIVES]).toEqual([
      'quality',
      'reliability',
      'latency',
      'cost',
      'memory-footprint',
      'context-usage',
      'background-compute',
    ])
  })
})

describe('objectiveReadings', () => {
  it('reads quality as the pass share over the pool evaluations', () => {
    const readings = objectiveReadings([
      pooled({ candidateId: 'c1', runs: 2, passes: 2 }),
      pooled({ candidateId: 'c2', runs: 2, passes: 0 }),
    ], [])
    expect(reading(readings, 'quality')).toMatchObject({
      unit: 'share',
      value: 0.5,
      source: 'pool: PooledCandidate.passes / PooledCandidate.runs',
    })
  })

  it('reads reliability as the share of twice-evaluated candidates that always passed', () => {
    const readings = objectiveReadings([
      pooled({ candidateId: 'c1', runs: 3, passes: 3 }),
      pooled({ candidateId: 'c2', runs: 2, passes: 1 }),
      pooled({ candidateId: 'c3', runs: 1, passes: 0 }),
    ], [])
    // The single-evaluation candidate repeats no verdict and counts in neither side.
    expect(reading(readings, 'reliability')).toMatchObject({ unit: 'share', value: 0.5 })
  })

  it('reads latency as mean wall time per evaluated rollout and cost as billed tokens', () => {
    const readings = objectiveReadings([], [
      spend({ wallTimeMs: 60000, rollouts: 4, tokens: 5000 }),
      spend({ wallTimeMs: 40000, rollouts: 1, tokens: 1000 }),
    ])
    expect(reading(readings, 'latency')).toMatchObject({
      unit: 'milliseconds',
      value: 20000,
      source: 'spends: SpendRecord.wallTimeMs / SpendRecord.rollouts',
    })
    expect(reading(readings, 'cost')).toMatchObject({ unit: 'tokens', value: 6000, source: 'spends: SpendRecord.tokens' })
  })

  it('reads background compute from the spends that attribute it', () => {
    const measured = objectiveReadings([], [spend({ backgroundTokens: 300 }), spend({ backgroundTokens: 200 })])
    expect(reading(measured, 'background-compute')).toMatchObject({
      unit: 'tokens',
      value: 500,
      source: 'spends: SpendRecord.backgroundTokens',
    })
    const zero = objectiveReadings([], [spend({ backgroundTokens: 0 })])
    expect(reading(zero, 'background-compute')).toMatchObject({ value: 0 })
  })

  it('reports memory footprint and context usage as unmeasured with the missing record named', () => {
    const readings = objectiveReadings([pooled()], [spend()])
    expect(reading(readings, 'memory-footprint')).toEqual({
      objective: 'memory-footprint',
      unit: 'bytes',
      value: null,
      source: 'not measurable: no store records the memory a candidate evaluation held',
    })
    expect(reading(readings, 'context-usage')).toMatchObject({
      objective: 'context-usage',
      unit: 'tokens',
      value: null,
      source: 'not measurable: no store records the context tokens a candidate evaluation carried',
    })
  })

  it('reports every objective a batch recorded nothing for as unmeasured', () => {
    const readings = objectiveReadings([], [])
    expect(readings).toHaveLength(7)
    expect(reading(readings, 'quality')?.value).toBeNull()
    expect(reading(readings, 'reliability')?.value).toBeNull()
    expect(reading(readings, 'latency')?.value).toBeNull()
    expect(reading(readings, 'cost')?.value).toBe(0)
    expect(reading(readings, 'background-compute')?.value).toBeNull()
    expect(reading(readings, 'quality')?.source).toBe('not measurable: no recorded pool candidate carries an evaluation (PooledCandidate.runs)')
    expect(reading(readings, 'reliability')?.source).toBe('not measurable: no pool candidate has a second evaluation to repeat a verdict')
    expect(reading(readings, 'latency')?.source).toBe('not measurable: no recorded spend names an evaluated rollout (SpendRecord.rollouts)')
    expect(reading(readings, 'background-compute')?.source)
      .toBe('not measurable: no recorded spend attributes background compute to the batch (SpendRecord.backgroundTokens)')
    // One spend that omits the dimension leaves the total unmeasured.
    expect(reading(objectiveReadings([], [spend({ backgroundTokens: 1 }), spend()]), 'background-compute')?.value).toBeNull()
  })
})
