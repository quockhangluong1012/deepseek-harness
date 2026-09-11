/**
 * The pure ledger fold: validation, UTC+7 bucketing, route moves, retention,
 * and range summaries. Every branch is behavior the dashboard reads, so each
 * has a case here.
 */
import { describe, expect, it } from 'vitest'
import {
  MODEL_KEY_SEPARATOR,
  UNKNOWN_ROUTE,
  addSample,
  cacheHitAvg,
  dayKeyUTC7,
  dayOfModelKey,
  dayStartUTC7,
  daysOfRange,
  isUsageRange,
  messageRoute,
  modelKey,
  moveSample,
  normalizeSample,
  sampleOfAttempt,
  sampleOfMessage,
  summarizeLedger,
  sweepRetention,
  windowStartOfRange,
  isCount,
} from '../src/aggregate.ts'
import type { UsageLedgerState } from '../src/spec.ts'

const DAY = 86_400_000
/** 2026-09-09T12:00:00+07:00 in true epoch milliseconds. */
const NOON_SEP9 = Date.UTC(2026, 8, 9, 5, 0, 0)

function sample(overrides: Record<string, unknown> = {}) {
  return {
    inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 180, ...overrides,
  }
}

function state(): UsageLedgerState {
  return { cursors: {}, daily: {}, models: {} }
}

describe('isCount', () => {
  it('admits non-negative safe integers only', () => {
    expect(isCount(0)).toBe(true)
    expect(isCount(42)).toBe(true)
    expect(isCount(-1)).toBe(false)
    expect(isCount(1.5)).toBe(false)
    expect(isCount('3')).toBe(false)
    expect(isCount(undefined)).toBe(false)
    expect(isCount(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
  })
})

describe('normalizeSample', () => {
  it('accepts an exact sample with both cache buckets', () => {
    expect(normalizeSample(sample())).toEqual({
      inputTokens: 130, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 180,
    })
  })

  it('derives the total when both cache buckets are present', () => {
    const { totalTokens: _dropped, ...rest } = sample()
    expect(normalizeSample(rest)).toEqual({
      inputTokens: 130, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 180,
    })
  })

  it('treats absent cache buckets as zero against a reported total', () => {
    expect(normalizeSample({ inputTokens: 100, outputTokens: 50, totalTokens: 150 })).toEqual({
      inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 150,
    })
  })

  it('rejects non-count inputs and outputs', () => {
    expect(normalizeSample(sample({ inputTokens: -1 }))).toBeUndefined()
    expect(normalizeSample(sample({ outputTokens: 1.5 }))).toBeUndefined()
  })

  it('rejects non-count cache buckets', () => {
    expect(normalizeSample(sample({ cacheReadTokens: -1 }))).toBeUndefined()
    expect(normalizeSample(sample({ cacheWriteTokens: 'x' }))).toBeUndefined()
  })

  it('rejects reasoning above the output or off the integers', () => {
    expect(normalizeSample(sample({ reasoningTokens: 51 }))).toBeUndefined()
    expect(normalizeSample(sample({ reasoningTokens: -1 }))).toBeUndefined()
    expect(normalizeSample(sample({ reasoningTokens: 50 }))).toBeDefined()
  })

  it('rejects an unsafe prompt sum', () => {
    expect(normalizeSample(sample({ inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1 }))).toBeUndefined()
  })

  it('rejects a non-count reported total', () => {
    expect(normalizeSample(sample({ totalTokens: 1.5 }))).toBeUndefined()
  })

  it('rejects a total below the known prompt plus output', () => {
    expect(normalizeSample(sample({ totalTokens: 100 }))).toBeUndefined()
  })

  it('rejects a total that contradicts complete cache buckets', () => {
    expect(normalizeSample(sample({ totalTokens: 200 }))).toBeUndefined()
  })

  it('rejects a missing total without both cache buckets', () => {
    const { totalTokens: _a, cacheWriteTokens: _b, ...rest } = sample()
    expect(normalizeSample(rest)).toBeUndefined()
  })

  it('rejects an unsafe derived total', () => {
    const { totalTokens: _dropped, ...rest } = sample({
      inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1,
    })
    expect(normalizeSample(rest)).toBeUndefined()
  })
})

describe('messageRoute', () => {
  it('reads provider and model from the message source', () => {
    expect(messageRoute({ source: { kind: 'model', provider: 'deepseek', model: 'chat' } } as never)).toEqual({
      provider: 'deepseek', model: 'chat',
    })
  })

  it('refuses an empty provider or model', () => {
    expect(messageRoute({ source: { kind: 'model', provider: '', model: 'chat' } } as never)).toBeUndefined()
    expect(messageRoute({ source: { kind: 'model', provider: 'deepseek', model: '' } } as never)).toBeUndefined()
  })
})

describe('sampleOfMessage and sampleOfAttempt', () => {
  const usage = sample()

  it('prefers the top-level report over the stream sample', () => {
    const stream = [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: sample({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }) } }]
    expect(sampleOfMessage({ data: { usage, stream } } as never)).toBe(usage)
  })

  it('falls back to the embedded stream sample', () => {
    const stream = [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage } }]
    expect(sampleOfMessage({ data: { stream } } as never)).toBe(usage)
  })

  it('reports no sample when neither carries one', () => {
    expect(sampleOfMessage({ data: { stream: [] } } as never)).toBeUndefined()
    expect(sampleOfAttempt({ data: { stream: [] } } as never)).toBeUndefined()
  })

  it('reads the attempt stream sample', () => {
    const stream = [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage } }]
    expect(sampleOfAttempt({ data: { stream } } as never)).toBe(usage)
  })
})

describe('UTC+7 day arithmetic', () => {
  it('keys midnight-plus-one-hour local time to the local day', () => {
    expect(dayKeyUTC7(Date.UTC(2026, 8, 8, 18, 0, 0))).toBe('2026-09-09')
  })

  it('keys the minute before local midnight to the previous day', () => {
    expect(dayKeyUTC7(Date.UTC(2026, 8, 8, 16, 59, 59))).toBe('2026-09-08')
  })

  it('starts the day at local midnight', () => {
    expect(dayStartUTC7(NOON_SEP9)).toBe(Date.UTC(2026, 8, 8, 17, 0, 0))
    expect(dayKeyUTC7(dayStartUTC7(NOON_SEP9))).toBe('2026-09-09')
    expect(dayStartUTC7(dayStartUTC7(NOON_SEP9) + 3_600_000)).toBe(dayStartUTC7(NOON_SEP9))
  })
})

describe('isUsageRange', () => {
  it('admits the four windows only', () => {
    expect(isUsageRange('today')).toBe(true)
    expect(isUsageRange('7d')).toBe(true)
    expect(isUsageRange('30d')).toBe(true)
    expect(isUsageRange('all')).toBe(true)
    expect(isUsageRange('yesterday')).toBe(false)
    expect(isUsageRange(undefined)).toBe(false)
  })
})

describe('daysOfRange and windowStartOfRange', () => {
  it('returns one zero-filled day for today', () => {
    expect(daysOfRange('today', NOON_SEP9, new Set(['2026-01-01']))).toEqual(['2026-09-09'])
    expect(windowStartOfRange('today', NOON_SEP9)).toBe(dayStartUTC7(NOON_SEP9))
  })

  it('returns seven and thirty ascending days', () => {
    const seven = daysOfRange('7d', NOON_SEP9, new Set())
    expect(seven).toHaveLength(7)
    expect(seven[0]).toBe('2026-09-03')
    expect(seven[6]).toBe('2026-09-09')
    expect(daysOfRange('30d', NOON_SEP9, new Set())).toHaveLength(30)
    expect(windowStartOfRange('7d', NOON_SEP9)).toBe(dayStartUTC7(NOON_SEP9) - 6 * DAY)
    expect(windowStartOfRange('30d', NOON_SEP9)).toBe(dayStartUTC7(NOON_SEP9) - 29 * DAY)
  })

  it('returns only days with data, sorted, for all', () => {
    expect(daysOfRange('all', NOON_SEP9, new Set(['2026-09-09', '2026-09-01']))).toEqual(['2026-09-01', '2026-09-09'])
    expect(windowStartOfRange('all', NOON_SEP9)).toBe(Number.NEGATIVE_INFINITY)
  })
})

describe('cacheHitAvg', () => {
  it('shares cache reads over billed input, zero without input', () => {
    expect(cacheHitAvg(20, 130)).toBeCloseTo(20 / 130)
    expect(cacheHitAvg(0, 0)).toBe(0)
  })
})

describe('model keys', () => {
  it('round-trips day, provider, and model', () => {
    const key = modelKey('2026-09-09', 'deepseek', 'chat')
    expect(key).toContain(MODEL_KEY_SEPARATOR)
    expect(dayOfModelKey(key)).toBe('2026-09-09')
  })
})

describe('addSample and moveSample', () => {
  it('accumulates day and route counters', () => {
    const ledger = state()
    const first = normalizeSample(sample())
    const second = normalizeSample(sample({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }))
    if (first === undefined || second === undefined) throw new Error('fixture')
    addSample(ledger, '2026-09-09', 'deepseek', 'chat', first)
    addSample(ledger, '2026-09-09', 'deepseek', 'chat', second)
    expect(ledger.daily['2026-09-09']).toEqual({ requests: 2, inputTokens: 140, outputTokens: 55, cacheReadTokens: 20 })
    expect(ledger.models[modelKey('2026-09-09', 'deepseek', 'chat')]?.requests).toBe(2)
  })

  it('moves a sample between routes and deletes the emptied row', () => {
    const ledger = state()
    const attempt = normalizeSample(sample())
    if (attempt === undefined) throw new Error('fixture')
    addSample(ledger, '2026-09-09', UNKNOWN_ROUTE, UNKNOWN_ROUTE, attempt)
    moveSample(ledger, '2026-09-09', { provider: UNKNOWN_ROUTE, model: UNKNOWN_ROUTE }, { provider: 'deepseek', model: 'chat' }, attempt)
    expect(ledger.models[modelKey('2026-09-09', UNKNOWN_ROUTE, UNKNOWN_ROUTE)]).toBeUndefined()
    expect(ledger.models[modelKey('2026-09-09', 'deepseek', 'chat')]?.requests).toBe(1)
    expect(ledger.daily['2026-09-09']?.requests).toBe(1)
  })

  it('keeps a source row that still holds samples, and tolerates a missing one', () => {
    const ledger = state()
    const attempt = normalizeSample(sample())
    if (attempt === undefined) throw new Error('fixture')
    addSample(ledger, '2026-09-09', UNKNOWN_ROUTE, UNKNOWN_ROUTE, attempt)
    addSample(ledger, '2026-09-09', UNKNOWN_ROUTE, UNKNOWN_ROUTE, attempt)
    moveSample(ledger, '2026-09-09', { provider: UNKNOWN_ROUTE, model: UNKNOWN_ROUTE }, { provider: 'deepseek', model: 'chat' }, attempt)
    expect(ledger.models[modelKey('2026-09-09', UNKNOWN_ROUTE, UNKNOWN_ROUTE)]?.requests).toBe(1)
    moveSample(ledger, '2026-09-09', { provider: 'ghost', model: 'gone' }, { provider: 'deepseek', model: 'chat' }, attempt)
    expect(ledger.models[modelKey('2026-09-09', 'deepseek', 'chat')]?.requests).toBe(2)
  })
})

describe('sweepRetention', () => {
  it('drops days and model rows before the cutoff and keeps the window', () => {
    const ledger = state()
    const attempt = normalizeSample(sample())
    if (attempt === undefined) throw new Error('fixture')
    addSample(ledger, '2026-09-01', 'deepseek', 'chat', attempt)
    addSample(ledger, '2026-09-09', 'deepseek', 'chat', attempt)
    sweepRetention(ledger, NOON_SEP9, 7)
    expect(ledger.daily['2026-09-01']).toBeUndefined()
    expect(ledger.daily['2026-09-09']).toBeDefined()
    expect(ledger.models[modelKey('2026-09-01', 'deepseek', 'chat')]).toBeUndefined()
    expect(ledger.models[modelKey('2026-09-09', 'deepseek', 'chat')]).toBeDefined()
  })
})

describe('summarizeLedger', () => {
  it('reports an empty window with its day frame and zeroed totals', () => {
    const summary = summarizeLedger(state(), 'today', NOON_SEP9)
    expect(summary.range).toBe('today')
    expect(summary.totals).toEqual({ requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheHitAvg: 0 })
    expect(summary.daily).toEqual([{ day: '2026-09-09', requests: 0, inputTokens: 0, outputTokens: 0 }])
    expect(summary.models).toEqual([])
  })

  it('sums the window, excludes older days, and sorts models by billed total', () => {
    const ledger = state()
    const big = normalizeSample(sample())
    const small = normalizeSample(sample({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15 }))
    if (big === undefined || small === undefined) throw new Error('fixture')
    addSample(ledger, '2026-09-09', 'deepseek', 'chat', big)
    addSample(ledger, '2026-09-09', 'other', 'lite', small)
    addSample(ledger, '2026-08-01', 'deepseek', 'chat', big)
    const summary = summarizeLedger(ledger, '7d', NOON_SEP9)
    expect(summary.totals.requests).toBe(2)
    expect(summary.totals.inputTokens).toBe(140)
    expect(summary.totals.cacheHitAvg).toBeCloseTo(20 / 140)
    expect(summary.daily).toHaveLength(7)
    expect(summary.daily.find(bucket => bucket.day === '2026-09-09')).toEqual({
      day: '2026-09-09', requests: 2, inputTokens: 140, outputTokens: 55,
    })
    expect(summary.daily.find(bucket => bucket.day === '2026-09-03')?.requests).toBe(0)
    expect(summary.models.map(row => row.model)).toEqual(['chat', 'lite'])
    expect(summary.models[0]).toMatchObject({ provider: 'deepseek', requests: 1 })
    expect(typeof summary.models[0]?.cacheHitAvg).toBe('number')
  })

  it('covers only days with data for all', () => {
    const ledger = state()
    const attempt = normalizeSample(sample())
    if (attempt === undefined) throw new Error('fixture')
    addSample(ledger, '2026-09-09', 'deepseek', 'chat', attempt)
    addSample(ledger, '2026-09-01', 'deepseek', 'chat', attempt)
    const summary = summarizeLedger(ledger, 'all', NOON_SEP9)
    expect(summary.daily.map(bucket => bucket.day)).toEqual(['2026-09-01', '2026-09-09'])
    expect(summary.totals.requests).toBe(2)
  })
})
