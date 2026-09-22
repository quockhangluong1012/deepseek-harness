import { describe, expect, it } from 'vitest'
import { headIsland, migrationDue } from '../src/islands.ts'
import type { Island } from '../src/types.ts'

const island = (overrides: Partial<Island>): Island => ({
  islandId: 'a',
  name: 'A',
  objective: 'performance',
  skill: 'writer',
  generation: 0,
  lastActivityAt: null,
  at: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

describe('migrationDue', () => {
  it('anchors an unmigrated island at its registration and reaches the cadence', () => {
    const now = '2026-01-02T00:00:00.000Z'
    expect(migrationDue(null, '2026-01-01T00:00:00.000Z', now, 86_400_000)).toBe(true)
    expect(migrationDue(null, '2026-01-01T00:00:01.000Z', now, 86_400_000)).toBe(false)
  })

  it('anchors a migrated island at its last migration', () => {
    const now = '2026-01-02T00:00:00.000Z'
    // Registered a long time ago but migrated yesterday: not due yet.
    expect(migrationDue('2026-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', now, 86_400_000)).toBe(true)
    expect(migrationDue('2026-01-01T12:00:00.000Z', '2025-01-01T00:00:00.000Z', now, 86_400_000)).toBe(false)
  })

  it('treats exactly one cadence as due', () => {
    expect(migrationDue('2026-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 86_400_000)).toBe(true)
  })
})

describe('headIsland', () => {
  it('returns undefined for a skill without islands and ignores other skills', () => {
    const rows = [island({ islandId: 'r', skill: 'reader' })]
    expect(headIsland(rows, 'writer')).toBeUndefined()
    expect(headIsland([], 'writer')).toBeUndefined()
  })

  it('prefers the newest registration and keeps input order on ties', () => {
    const rows = [
      island({ islandId: 'old', at: '2026-01-01T00:00:00.000Z' }),
      island({ islandId: 'new', at: '2026-01-02T00:00:00.000Z' }),
    ]
    expect(headIsland(rows, 'writer')?.islandId).toBe('new')
    const tied = [
      island({ islandId: 'b', at: '2026-01-01T00:00:00.000Z' }),
      island({ islandId: 'a', at: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(headIsland(tied, 'writer')?.islandId).toBe('b')
  })
})
