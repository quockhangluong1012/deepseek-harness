/**
 * The Host face delegates dashboard summaries to the ledger service: the
 * Remote namespace adds no accounting of its own.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { UsageSummary } from '@deepseek-ai/dsh-usage-ledger/types'
import UsageDashboard from '../src/index.ts'

describe('UsageDashboard Remote face', () => {
  it('serves the ledger summary for one range', async () => {
    const summary: UsageSummary = {
      range: 'today',
      totals: { requests: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheHitAvg: 0 },
      daily: [],
      models: [],
    }
    const ledger = { summary: vi.fn(async () => summary) }
    const ctx = new Context()
    ctx.provide('usageLedger', ledger as never)
    const face = new UsageDashboard(ctx)
    const signal = new AbortController().signal
    await expect(face.summary('today', signal)).resolves.toBe(summary)
    expect(ledger.summary).toHaveBeenCalledWith('today', signal)
  })
})
