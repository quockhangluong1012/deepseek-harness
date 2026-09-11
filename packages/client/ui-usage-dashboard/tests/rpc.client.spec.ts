/**
 * The Remote binding: the summary read reaches the generated
 * `usageDashboard` namespace with the range and the abort signal.
 */
import { describe, expect, it, vi } from 'vitest'
import { createFetchSummary } from '../src/client/rpc.ts'

describe('createFetchSummary', () => {
  it('delegates to the usageDashboard namespace', async () => {
    const summary = vi.fn(async () => ({ ok: true, value: 'summary' }))
    const fetch = createFetchSummary({ usageDashboard: { summary } } as never)
    const signal = new AbortController().signal
    await expect(fetch('7d', signal)).resolves.toEqual({ ok: true, value: 'summary' })
    expect(summary).toHaveBeenCalledWith('7d', signal)
  })
})
