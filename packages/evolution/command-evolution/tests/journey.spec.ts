import { describe, expect, it } from 'vitest'
import type { EvolutionMemoryRecord, LessonArtifact } from '@deepseek-ai/dsh-evolution-memory'
import { renderTimeline, scopeTimeline } from '../src/journey.ts'
import type { TimelineInput } from '../src/journey.ts'

/**
 * Pure-model suite for `/journey`: day bucketing on the UTC+7 calendar, window
 * filtering, zero-filling, cumulative accounting, pending projection, the
 * per-family stamps, the decided-entry counts, and the rendered text.
 * Command-level behavior (scope resolution, usage errors) lives in the command
 * suite.
 */

/** A fixed clock so day keys never depend on when the suite runs. */
const NOW = Date.parse('2026-09-12T05:00:00.000Z')

/**
 * The one lesson artifact the default record carries. Its serialized size is
 * what `lessonsBytes` reports, so the title of this fixture is also the
 * cumulative assertion's expectation.
 */
const LESSON: LessonArtifact = {
  id: 'lessons here',
  statement: 'lessons here',
  source: 's1',
  conditions: '',
  evidence: 'inference',
  confidence: 0.5,
  validationCount: 0,
  refutationCount: 0,
  scope: 'project',
  ttlDays: 30,
  createdAt: '2026-09-12T04:00:00.000Z',
  updatedAt: '2026-09-12T04:00:00.000Z',
}

function record(overrides: Partial<EvolutionMemoryRecord> = {}): EvolutionMemoryRecord {
  return {
    instructions: 'prefer tabs',
    agentLessons: [LESSON],
    userProfile: 'profile here',
    memoryUpdatedAt: null,
    instructionsUpdatedAt: null,
    lessonsUpdatedAt: null,
    profileUpdatedAt: null,
    contextItems: [],
    outputs: [],
    lastExtraction: null,
    staged: [],
    resolutions: [],
    updatedAt: '2026-09-12T04:00:00.000Z',
    ...overrides,
  }
}

function input(overrides: Partial<TimelineInput> = {}): TimelineInput {
  return {
    record: record(),
    usedBytes: 120,
    capacityBytes: 1000,
    digest: 'abc123',
    range: '7d',
    now: NOW,
    ...overrides,
  }
}

describe('scopeTimeline', () => {
  it('buckets memory, context, output, and staged deltas onto their own UTC+7 days', () => {
    const timeline = scopeTimeline(input({
      record: record({
        lastExtraction: {
          at: '2026-09-11T02:00:00.000Z',
          sessionId: 's-lessons',
          provider: 'deepseek-official',
          model: 'deepseek-chat',
          origin: 'background_review',
          inputBytes: 4096,
          truncated: false,
        },
        contextItems: [
          { kind: 'text', id: 'i1', label: 'Design notes', text: 'x', sizeBytes: 1, addedAt: '2026-09-12T01:00:00.000Z' },
        ],
        outputs: [
          { path: 'src/a.ts', tool: 'write', sessionId: 's-output', at: '2026-09-12T02:00:00.000Z' },
          { path: 'src/b.ts', tool: 'edit', sessionId: 's-output', at: '2026-09-12T03:00:00.000Z' },
        ],
        staged: [
          {
            id: 'st1', kind: 'memory', op: 'replaceArtifacts', payload: { candidates: [] },
            originSessionId: 's-staged', createdAt: '2026-09-12T03:30:00.000Z', gist: 'lessons from turn 1',
          },
        ],
      }),
    }))

    expect(timeline.days.map(day => day.day)).toEqual([
      '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12',
    ])
    const eleventh = timeline.days[5]
    expect(eleventh?.deltas).toEqual([{
      day: '2026-09-11',
      kind: 'lessons',
      gist: 'background_review · deepseek-official/deepseek-chat',
      sessionId: 's-lessons',
      at: '2026-09-11T02:00:00.000Z',
    }])
    const twelfth = timeline.days[6]
    expect(twelfth?.deltas.map(delta => delta.kind)).toEqual(['context', 'outputs', 'outputs', 'staged'])
    expect(twelfth?.contextAttached).toBe(1)
    expect(twelfth?.outputsIndexed).toBe(2)
    expect(twelfth?.stagedOpened).toBe(1)
  })

  it('drops deltas older than the window and keeps every day of a bounded range', () => {
    const timeline = scopeTimeline(input({
      range: 'today',
      record: record({
        outputs: [
          { path: 'old.ts', tool: 'write', sessionId: 's1', at: '2026-09-01T00:00:00.000Z' },
          { path: 'new.ts', tool: 'write', sessionId: 's1', at: '2026-09-12T02:00:00.000Z' },
        ],
      }),
    }))
    expect(timeline.days.map(day => day.day)).toEqual(['2026-09-12'])
    expect(timeline.days[0]?.deltas.map(delta => delta.gist)).toEqual(['write new.ts'])
  })

  it('reports only days with activity for the unbounded range', () => {
    const timeline = scopeTimeline(input({
      range: 'all',
      record: record({
        outputs: [{ path: 'a.ts', tool: 'write', sessionId: 's1', at: '2026-08-01T00:00:00.000Z' }],
      }),
    }))
    expect(timeline.days.map(day => day.day)).toEqual(['2026-08-01'])
  })

  it('falls back to a hand-edited memory delta without an extraction', () => {
    const timeline = scopeTimeline(input({
      record: record({ memoryUpdatedAt: '2026-09-12T00:30:00.000Z' }),
    }))
    expect(timeline.days[6]?.deltas).toEqual([{
      day: '2026-09-12',
      kind: 'lessons',
      gist: 'edited by hand',
      sessionId: null,
      at: '2026-09-12T00:30:00.000Z',
    }])
  })

  it('separates instruction, lessons, and profile deltas by their own stamps', () => {
    const timeline = scopeTimeline(input({
      range: 'all',
      record: record({
        instructionsUpdatedAt: '2026-09-12T00:10:00.000Z',
        lessonsUpdatedAt: '2026-09-11T02:00:00.000Z',
        profileUpdatedAt: '2026-09-12T02:00:00.000Z',
        lastExtraction: {
          at: '2026-09-12T02:00:00.000Z',
          sessionId: 's-profile',
          provider: 'deepseek-official',
          model: 'deepseek-chat',
          origin: 'background_review',
          inputBytes: 4096,
          truncated: false,
        },
      }),
    }))
    const byDay = new Map(timeline.days.map(day => [day.day, day.deltas]))
    // The stamp with no matching extraction is a hand edit, and the
    // extraction names its own family instead of every family it touches.
    expect(byDay.get('2026-09-11')).toEqual([{
      day: '2026-09-11',
      kind: 'lessons',
      gist: 'edited by hand',
      sessionId: null,
      at: '2026-09-11T02:00:00.000Z',
    }])
    expect(byDay.get('2026-09-12')?.map(delta => [delta.kind, delta.gist, delta.sessionId])).toEqual([
      ['instructions', 'edited by hand', null],
      ['profile', 'background_review · deepseek-official/deepseek-chat', 's-profile'],
    ])
  })

  it('reads one lessons delta from the legacy stamp when a family write is unstamped', () => {
    const timeline = scopeTimeline(input({
      range: 'all',
      record: record({
        instructionsUpdatedAt: '2026-09-12T00:10:00.000Z',
        memoryUpdatedAt: '2026-09-11T02:00:00.000Z',
      }),
    }))
    expect(timeline.days.map(day => [day.day, day.deltas.map(delta => delta.kind)])).toEqual([
      ['2026-09-11', ['lessons']],
      ['2026-09-12', ['instructions']],
    ])
  })

  it('attributes a single stamped family without inventing the other', () => {
    const lessonsOnly = scopeTimeline(input({
      range: 'all',
      record: record({ lessonsUpdatedAt: '2026-09-11T02:00:00.000Z' }),
    }))
    expect(lessonsOnly.days).toHaveLength(1)
    expect(lessonsOnly.days[0]?.deltas.map(delta => delta.kind)).toEqual(['lessons'])

    const profileOnly = scopeTimeline(input({
      range: 'all',
      record: record({ profileUpdatedAt: '2026-09-12T02:00:00.000Z' }),
    }))
    expect(profileOnly.days).toHaveLength(1)
    expect(profileOnly.days[0]?.deltas.map(delta => delta.kind)).toEqual(['profile'])
  })

  it('counts staged decisions per day and keeps decision-only days in the range', () => {
    const timeline = scopeTimeline(input({
      record: record({
        resolutions: [
          { id: 'sid', kind: 'memory', op: 'replaceArtifacts', gist: 'gist', decision: 'approved', at: '2026-09-10T01:00:00.000Z', originSessionId: 's1' },
          { id: 'sid', kind: 'memory', op: 'replaceArtifacts', gist: 'gist', decision: 'rejected', at: '2026-09-10T02:00:00.000Z', originSessionId: 's1' },
          { id: 'sid', kind: 'memory', op: 'replaceArtifacts', gist: 'gist', decision: 'approved', at: '2026-09-01T00:00:00.000Z', originSessionId: 's1' },
        ],
      }),
    }))
    expect(timeline.days).toHaveLength(7)
    expect(timeline.days.find(day => day.day === '2026-09-10')).toMatchObject({
      deltas: [],
      stagedApproved: 1,
      stagedRejected: 1,
      stagedOpened: 0,
    })
    // A decision older than the window is dropped, not attributed to a day.
    expect(timeline.days.reduce((total, day) => total + day.stagedApproved, 0)).toBe(1)

    const all = scopeTimeline(input({
      range: 'all',
      record: record({ resolutions: [{ id: 'sid', kind: 'memory', op: 'replaceArtifacts', gist: 'gist', decision: 'rejected', at: '2026-01-02T00:00:00.000Z', originSessionId: 's1' }] }),
    }))
    expect(all.days.map(day => day.day)).toEqual(['2026-01-02'])
    expect(all.days[0]?.stagedRejected).toBe(1)
  })

  it('reports capacity, digest, document bytes, and pending entries without a record', () => {
    const timeline = scopeTimeline(input({ record: undefined }))
    expect(timeline.cumulative).toEqual({
      usedBytes: 120,
      capacityBytes: 1000,
      digest: 'abc123',
      lessonsBytes: 0,
      profileBytes: 0,
    })
    expect(timeline.pending).toEqual([])
    expect(timeline.days.every(day => day.deltas.length === 0)).toBe(true)
  })

  it('projects staged entries with their governance fields and sizes the documents', () => {
    const timeline = scopeTimeline(input({
      record: record({
        staged: [
          {
            id: 'st1', kind: 'skill', op: 'create', payload: { name: 'polish' },
            originSessionId: 's-origin', createdAt: '2026-09-12T03:00:00.000Z', gist: 'new skill polish',
          },
        ],
      }),
    }))
    expect(timeline.pending).toEqual([{
      id: 'st1',
      kind: 'skill',
      op: 'create',
      gist: 'new skill polish',
      originSessionId: 's-origin',
      createdAt: '2026-09-12T03:00:00.000Z',
    }])
    expect(timeline.cumulative.lessonsBytes).toBe(267)
    expect(timeline.cumulative.profileBytes).toBe(12)
  })
})

describe('renderTimeline', () => {
  it('renders the range header, active days, capacity, and pending count', () => {
    const text = renderTimeline(scopeTimeline(input({
      usedBytes: 250,
      digest: 'deadbeef',
      record: record({
        outputs: [{ path: 'src/a.ts', tool: 'write', sessionId: 's1', at: '2026-09-12T02:00:00.000Z' }],
        staged: [
          {
            id: 'st1', kind: 'memory', op: 'replaceArtifacts', payload: { candidates: [] },
            originSessionId: 's1', createdAt: '2026-09-12T03:00:00.000Z', gist: 'lessons',
          },
        ],
      }),
    })))
    expect(text).toBe([
      'Journey (7d) · 2026-09-06..2026-09-12',
      '2026-09-12  outputs 1 · staged 1',
      'Memory 250/1000 bytes (25%) · lessons 267 · profile 12 · digest deadbeef',
      '1 staged write; run /memory pending.',
    ].join('\n'))
  })

  it('reports an empty range without hiding capacity or pending state', () => {
    const text = renderTimeline(scopeTimeline(input({ record: undefined, range: 'today', digest: 'empty' })))
    expect(text).toBe([
      'Journey (today) · 2026-09-12..2026-09-12',
      'No recorded evolution activity in this range.',
      'Memory 120/1000 bytes (12%) · lessons 0 · profile 0 · digest empty',
      'No staged writes.',
    ].join('\n'))
  })

  it('counts active days and omits the padded window for the unbounded range', () => {
    const text = renderTimeline(scopeTimeline(input({
      range: 'all',
      record: record({
        outputs: [{ path: 'a.ts', tool: 'write', sessionId: 's1', at: '2026-09-12T02:00:00.000Z' }],
      }),
    })))
    expect(text.split('\n')[0]).toBe('Journey (all) · all (1 active day)')
  })

  it('names memory and context counts and pluralizes pending writes', () => {
    const text = renderTimeline(scopeTimeline(input({
      range: 'all',
      record: record({
        lastExtraction: {
          at: '2026-09-11T02:00:00.000Z',
          sessionId: 's-lessons',
          provider: 'deepseek-official',
          model: 'deepseek-chat',
          origin: 'background_review',
          inputBytes: 4096,
          truncated: false,
        },
        contextItems: [
          { kind: 'text', id: 'i1', label: 'Design notes', text: 'x', sizeBytes: 1, addedAt: '2026-09-12T01:00:00.000Z' },
        ],
        staged: [
          {
            id: 'st1', kind: 'memory', op: 'replaceArtifacts', payload: { candidates: [] },
            originSessionId: 's1', createdAt: '2026-09-12T03:00:00.000Z', gist: 'lessons',
          },
          {
            id: 'st2', kind: 'skill', op: 'create', payload: { name: 'polish' },
            originSessionId: 's1', createdAt: '2026-09-12T03:30:00.000Z', gist: 'new skill polish',
          },
        ],
      }),
    })))
    expect(text.split('\n')).toEqual([
      'Journey (all) · all (2 active days)',
      '2026-09-11  lessons 1',
      '2026-09-12  context 1 · staged 2',
      text.split('\n')[3],
      '2 staged writes; run /memory pending.',
    ])
    expect(text.split('\n')[3]).toContain('lessons 267')
  })

  it('still renders a header and the empty body for a timeline without days', () => {
    const text = renderTimeline({
      range: '7d',
      now: NOW,
      days: [],
      cumulative: { usedBytes: 0, capacityBytes: 0, digest: 'empty', lessonsBytes: 0, profileBytes: 0 },
      pending: [],
    })
    expect(text.split('\n')[0]).toBe('Journey (7d) · -..-')
    expect(text.split('\n')[1]).toBe('No recorded evolution activity in this range.')
  })

  it('reports zero percent when the capacity ceiling is zero', () => {
    const text = renderTimeline(scopeTimeline(input({ capacityBytes: 0 })))
    expect(text).toContain('Memory 120/0 bytes (0%)')
  })

  it('names the separated document kinds and the decided-entry counts', () => {
    const text = renderTimeline(scopeTimeline(input({
      record: record({
        instructionsUpdatedAt: '2026-09-12T00:10:00.000Z',
        profileUpdatedAt: '2026-09-12T01:10:00.000Z',
        resolutions: [
          { id: 'sid', kind: 'memory', op: 'replaceArtifacts', gist: 'gist', decision: 'approved', at: '2026-09-12T02:00:00.000Z', originSessionId: 's1' },
          { id: 'sid', kind: 'memory', op: 'replaceArtifacts', gist: 'gist', decision: 'rejected', at: '2026-09-12T03:00:00.000Z', originSessionId: 's1' },
        ],
      }),
    })))
    expect(text.split('\n')[1]).toBe('2026-09-12  instructions 1 · profile 1 · approved 1 · rejected 1')
  })

  it('keeps a decision-only day in a bounded window', () => {
    const text = renderTimeline(scopeTimeline(input({
      record: record({ resolutions: [{ id: 'sid', kind: 'memory', op: 'replaceArtifacts', gist: 'gist', decision: 'approved', at: '2026-09-11T04:00:00.000Z', originSessionId: 's1' }] }),
    })))
    expect(text).toContain('2026-09-11  approved 1')
  })
})
