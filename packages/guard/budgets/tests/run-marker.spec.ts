import { describe, expect, it } from 'vitest'
import { runMarkerOf } from '../src/run-marker.ts'

/**
 * Behavior suite for the structural run-marker read: only the kernel's durable
 * task event opens a run, and only when it carries a usable identity.
 */

const marker = (data: unknown, type = 'task/created', time = 1_000) => runMarkerOf({ type, time, data })

describe('runMarkerOf', () => {
  it('reads the run identity the kernel writes when it opens a task', () => {
    expect(marker({ metadata: { runId: 'run-1' } })).toEqual({ runId: 'run-1', at: 1_000 })
  })

  it('ignores every other event family', () => {
    expect(marker({ metadata: { runId: 'run-1' } }, 'turn/start')).toBeUndefined()
  })

  it('ignores a task event without a usable run identity', () => {
    expect(marker(undefined)).toBeUndefined()
    expect(marker('plain')).toBeUndefined()
    expect(marker(null)).toBeUndefined()
    expect(marker({})).toBeUndefined()
    expect(marker({ metadata: null })).toBeUndefined()
    expect(marker({ metadata: 7 })).toBeUndefined()
    expect(marker({ metadata: { runId: 7 } })).toBeUndefined()
    expect(marker({ metadata: { runId: '' } })).toBeUndefined()
  })
})
