import { describe, expect, it } from 'vitest'
import {
  anticipationOf,
  artifactSummaryOf,
  classKeyOf,
  newlyConsumed,
  recurrenceOf,
  windowStartOf,
} from '../src/anticipate.ts'
import type { PrecomputeArtifact, RecurrenceEvidence, TaskOccurrence } from '../src/types.ts'

const occurrence = (overrides: Partial<TaskOccurrence> = {}): TaskOccurrence => ({
  source: 'skill',
  taskClass: 'pdf-extract',
  tokens: 1000,
  at: '2026-09-20T00:00:00.000Z',
  ...overrides,
})

const evidence = (overrides: Partial<RecurrenceEvidence> = {}): RecurrenceEvidence => ({
  source: 'skill',
  taskClass: 'pdf-extract',
  occurrences: 4,
  meanTokens: 1000,
  firstAt: '2026-09-19T00:00:00.000Z',
  lastAt: '2026-09-20T00:00:00.000Z',
  ...overrides,
})

const artifact = (overrides: Partial<PrecomputeArtifact> = {}): PrecomputeArtifact => ({
  artifactId: 'skill:pdf-extract',
  taskId: 'skill:pdf-extract',
  kind: 'summary',
  summary: 'recorded evidence',
  offlineCostTokens: 2000,
  decisionReason: null,
  hits: 0,
  savedTokens: 0,
  servedThroughAt: null,
  at: '2026-09-20T00:00:00.000Z',
  ...overrides,
})

describe('classKeyOf', () => {
  it('namespaces a task class by the store it recurred in', () => {
    expect(classKeyOf('skill', 'pdf-extract')).toBe('skill:pdf-extract')
    expect(classKeyOf('route', 'pdf-extract')).not.toBe(classKeyOf('skill', 'pdf-extract'))
  })
})

describe('windowStartOf', () => {
  it('subtracts the window from the pass instant', () => {
    expect(windowStartOf('2026-09-22T00:00:00.000Z', 24)).toBe('2026-09-21T00:00:00.000Z')
    expect(windowStartOf('2026-09-22T00:00:00.000Z', 0)).toBe('2026-09-22T00:00:00.000Z')
  })
})

describe('recurrenceOf', () => {
  it('counts only the occurrences inside the window', () => {
    const rows = recurrenceOf([
      occurrence({ at: '2026-09-19T00:00:00.000Z', tokens: 500 }),
      occurrence({ at: '2026-09-21T00:00:00.000Z', tokens: 1500 }),
      occurrence({ at: '2026-09-18T00:00:00.000Z', tokens: 9000 }),
    ], '2026-09-19T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      occurrences: 2,
      meanTokens: 1000,
      firstAt: '2026-09-19T00:00:00.000Z',
      lastAt: '2026-09-21T00:00:00.000Z',
    })
  })

  it('groups by source and class and orders by that identity', () => {
    const rows = recurrenceOf([
      occurrence({ source: 'route', taskClass: 'writer' }),
      occurrence({ source: 'skill', taskClass: 'pdf-extract' }),
      occurrence({ source: 'route', taskClass: 'writer' }),
      occurrence({ source: 'skill', taskClass: 'writer' }),
    ], '2026-01-01T00:00:00.000Z')
    expect(rows.map(row => classKeyOf(row.source, row.taskClass)))
      .toEqual(['route:writer', 'skill:pdf-extract', 'skill:writer'])
    expect(rows[0]?.occurrences).toBe(2)
  })

  it('summarizes nothing when no occurrence is inside the window', () => {
    expect(recurrenceOf([occurrence({ at: '2026-01-01T00:00:00.000Z' })], '2026-09-01T00:00:00.000Z')).toEqual([])
    expect(recurrenceOf([], '2026-09-01T00:00:00.000Z')).toEqual([])
  })
})

describe('anticipationOf', () => {
  it('turns recurrence into a likelihood share of the recurring occurrences', () => {
    const rows = anticipationOf([
      evidence({ taskClass: 'writer', occurrences: 6, meanTokens: 2000 }),
      evidence({ taskClass: 'reader', occurrences: 4, meanTokens: 500 }),
      evidence({ taskClass: 'ghost', occurrences: 2, meanTokens: 100 }),
    ], 3)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      taskId: 'skill:writer',
      domain: 'skill',
      scope: 'writer',
      likelihood: 0.6,
      expectedQueries: 6,
      expectedSavingTokens: 2000,
    })
    expect(rows[1]).toMatchObject({ taskId: 'skill:reader', likelihood: 0.4, expectedSavingTokens: 500 })
  })

  it('breaks likelihood ties by identity', () => {
    const rows = anticipationOf([
      evidence({ taskClass: 'zebra', occurrences: 3 }),
      evidence({ taskClass: 'alpha', occurrences: 3 }),
    ], 3)
    expect(rows.map(row => row.scope)).toEqual(['alpha', 'zebra'])
  })

  it('anticipates nothing when no class recurred often enough', () => {
    expect(anticipationOf([evidence({ occurrences: 2 })], 3)).toEqual([])
    expect(anticipationOf([], 3)).toEqual([])
  })
})

describe('artifactSummaryOf', () => {
  it('describes the recorded recurrence the artifact was built from', () => {
    expect(artifactSummaryOf(evidence()))
      .toBe('skill:pdf-extract recurred 4 times between 2026-09-19T00:00:00.000Z and 2026-09-20T00:00:00.000Z, 1000 mean tokens per occurrence')
  })
})

describe('newlyConsumed', () => {
  it('takes only the artifact class\'s occurrences newer than the cursor', () => {
    const rows = newlyConsumed(artifact({ servedThroughAt: '2026-09-20T12:00:00.000Z' }), [
      occurrence({ at: '2026-09-20T06:00:00.000Z' }),
      occurrence({ at: '2026-09-20T18:00:00.000Z', tokens: 300 }),
      occurrence({ at: '2026-09-21T00:00:00.000Z', tokens: 400 }),
      occurrence({ at: '2026-09-21T06:00:00.000Z', source: 'route' }),
    ])
    expect(rows.map(row => row.tokens)).toEqual([300, 400])
  })

  it('accounts a never-served artifact from its own precompute instant', () => {
    const rows = newlyConsumed(artifact({ at: '2026-09-20T00:00:00.000Z' }), [
      occurrence({ at: '2026-09-19T23:59:59.000Z' }),
      occurrence({ at: '2026-09-20T00:00:01.000Z', tokens: 700 }),
    ])
    expect(rows.map(row => row.tokens)).toEqual([700])
  })

  it('orders consumers oldest first, ties by class, and reports none when nothing is newer', () => {
    const rows = newlyConsumed(artifact({ servedThroughAt: '2026-09-20T00:00:00.000Z' }), [
      occurrence({ at: '2026-09-22T00:00:00.000Z', tokens: 1 }),
      occurrence({ at: '2026-09-21T00:00:00.000Z', tokens: 2 }),
      // Same instant, so the class decides: a stable tie keeps the later row.
      occurrence({ at: '2026-09-21T00:00:00.000Z', tokens: 3 }),
    ])
    expect(rows.map(row => row.tokens)).toEqual([2, 3, 1])
    expect(newlyConsumed(artifact({ servedThroughAt: '2026-09-30T00:00:00.000Z' }), [occurrence()])).toEqual([])
  })
})
