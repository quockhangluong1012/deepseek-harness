import { describe, expect, it } from 'vitest'
import { deriveTasks, TASK_GIST_LIMIT, TASK_TEXT_LIMIT } from '../src/index.ts'
import type { CurriculumGap } from '../src/index.ts'

const gap = (capability: string, gists: readonly string[], sessions = 1): CurriculumGap => ({
  capability,
  sourceSessions: sessions === 0 ? [] : Array.from({ length: sessions }, (_, i) => `s${i}`),
  failureGists: gists,
})

describe('evolution curriculum derivation', () => {
  it('proposes nothing for a gap without failure evidence', () => {
    expect(deriveTasks([gap('writer', [])])).toEqual([])
    expect(deriveTasks([])).toEqual([])
  })

  it('derives one grounded task per evidenced gap, most evidence first', () => {
    const tasks = deriveTasks([
      gap('polish', ['stale context'], 3),
      gap('writer', ['boom', 'oops'], 2),
      gap('idle', []),
    ])
    expect(tasks.map(task => task.capability)).toEqual(['writer', 'polish'])
    expect(tasks[0]?.task).toContain("'boom'")
    expect(tasks[0]?.task).toContain("'oops'")
    expect(tasks[0]?.task).toContain('2 sessions')
    expect(tasks[1]?.task).toContain('3 sessions')
    expect(tasks[0]?.gists).toEqual(['boom', 'oops'])
    expect(tasks[0]?.sourceSessions).toEqual(['s0', 's1'])
  })

  it('cites at most the gist limit and clips the task text', () => {
    const many = deriveTasks([gap('writer', ['a', 'b', 'c', 'd'])])
    expect(many[0]?.gists).toHaveLength(TASK_GIST_LIMIT)

    const longGist = 'x'.repeat(500)
    const clipped = deriveTasks([gap('writer', [longGist])])
    expect(clipped[0]?.task.length).toBeLessThanOrEqual(TASK_TEXT_LIMIT)
    expect(clipped[0]?.task.endsWith('…')).toBe(true)
  })
})
