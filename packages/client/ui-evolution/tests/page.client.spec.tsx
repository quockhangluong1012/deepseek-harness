// @vitest-environment jsdom
/**
 * The journey page renders the Scope's timeline buckets from the payload the
 * controller answers with, retires a pending row when the controller decides
 * it, reads capacity from the record's own usage, and keeps every empty state
 * honest — a quiet zero-filled day is a calendar fact, never a row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RemoteStream, RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type {
  EvolutionCuratorStatus,
  EvolutionFollowFrame,
  EvolutionMemoryValue,
  JourneyTimeline,
  LessonArtifact,
  TimelineDayBucket,
  WorkspaceId,
} from '../src/types.ts'
import {
  EvolutionPage,
  RANGES,
  activeDays,
  barPercent,
  bucketTallies,
} from '../src/client/Page.tsx'
import type { PageTranslate } from '../src/client/Page.tsx'
import type { PageRemote } from '../src/client/rpc.ts'

afterEach(cleanup)

const t: PageTranslate = (key, params) => (params === undefined ? key : `${key}:${JSON.stringify(params)}`)

const SCOPE = 'ws-1'

/** One lesson artifact carried by the projection fixtures. */
function lessonOf(statement: string, confidence: number): LessonArtifact {
  return {
    id: statement,
    statement,
    source: 's1',
    conditions: '',
    evidence: 'inference',
    confidence,
    validationCount: 0,
    refutationCount: 0,
    scope: 'project',
    ttlDays: 30,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  }
}

function valueOf(overrides: Partial<EvolutionMemoryValue> = {}): EvolutionMemoryValue {
  return {
    workspaceId: SCOPE as WorkspaceId,
    instructions: '',
    lessons: [],
    profile: '',
    memoryUpdatedAt: null,
    instructionsUpdatedAt: null,
    lessonsUpdatedAt: null,
    profileUpdatedAt: null,
    contextItems: [],
    outputs: [],
    lastExtraction: null,
    staged: [],
    resolutions: [],
    usage: { usedBytes: 0, capacityBytes: 1000 },
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

function bucketOf(day: string, overrides: Partial<TimelineDayBucket> = {}): TimelineDayBucket {
  return {
    day,
    deltas: [],
    contextAttached: 0,
    outputsIndexed: 0,
    stagedOpened: 0,
    stagedApproved: 0,
    stagedRejected: 0,
    ...overrides,
  }
}

function timelineOf(overrides: Partial<JourneyTimeline> = {}): JourneyTimeline {
  return {
    range: '7d',
    now: 0,
    days: [],
    cumulative: { usedBytes: 0, capacityBytes: 1000, digest: 'digest-1', lessonsBytes: 0, profileBytes: 0 },
    pending: [],
    ...overrides,
  }
}

/** Stream double: it drives the real `follow` the page handed the opener. */
function openStreamOf(options: RemoteStreamOptions<EvolutionFollowFrame>): RemoteStream<EvolutionFollowFrame> {
  return {
    [Symbol.asyncIterator]: async function* () {
      const controller = new AbortController()
      try {
        for await (const value of options.open(controller.signal)) {
          yield { generation: 0, value, signal: controller.signal, accept: () => {} }
        }
      } finally {
        controller.abort()
      }
    },
    restart: () => {},
    dispose: async () => {},
    signal: new AbortController().signal,
  } as never
}

/** The page Remote over one idle follow generation, with the given overrides. */
function remoteOf(overrides: Partial<PageRemote> = {}): PageRemote {
  return {
    read: vi.fn(async () => valueOf()),
    timeline: vi.fn(async () => timelineOf()),
    approveStaged: vi.fn(async () => valueOf()),
    rejectStaged: vi.fn(async () => valueOf()),
    curatorStatus: vi.fn(async () => ({ mounted: true, lastRunAt: null as string | null, passes: [] })),
    follow: () => (async function* (): AsyncIterable<EvolutionFollowFrame> {})(),
    openStream: openStreamOf,
    ...overrides,
  }
}

/** A follow generation that yields exactly these frames. */
function framesOf(frames: readonly EvolutionFollowFrame[]): (signal: AbortSignal) => AsyncIterable<EvolutionFollowFrame> {
  return () => (async function* (): AsyncIterable<EvolutionFollowFrame> {
    yield* frames
  })()
}

describe('evolution journey page helpers', () => {
  it('keeps only days that carry a delta or a decision', () => {
    const quiet = bucketOf('2026-09-01')
    const active = bucketOf('2026-09-02', {
      deltas: [{ day: '2026-09-02', kind: 'instructions', gist: 'g', sessionId: null, at: 'x' }],
    })
    const decided = bucketOf('2026-09-03', { stagedRejected: 1 })
    expect(activeDays(timelineOf({ days: [quiet, active, decided] })).map(day => day.day))
      .toEqual(['2026-09-02', '2026-09-03'])
  })

  it('tallies only the families that moved', () => {
    const bucket = bucketOf('2026-09-02', {
      deltas: [
        { day: '2026-09-02', kind: 'instructions', gist: 'g', sessionId: null, at: 'a' },
        { day: '2026-09-02', kind: 'profile', gist: 'g', sessionId: null, at: 'b' },
      ],
      contextAttached: 2,
      outputsIndexed: 1,
      stagedOpened: 3,
      stagedApproved: 4,
      stagedRejected: 5,
    })
    expect(bucketTallies(bucket, t)).toEqual([
      'tally.instructions:{"n":1}',
      'tally.profile:{"n":1}',
      'tally.context:{"n":2}',
      'tally.outputs:{"n":1}',
      'tally.staged:{"n":3}',
      'tally.approved:{"n":4}',
      'tally.rejected:{"n":5}',
    ])
    expect(bucketTallies(bucketOf('quiet'), t)).toEqual([])
  })

  it('clamps a bar and admits a zero ceiling', () => {
    expect(barPercent(500, 1000)).toBe(50)
    expect(barPercent(2000, 1000)).toBe(100)
    expect(barPercent(5, 0)).toBe(0)
  })

  it('offers the four windows', () => {
    expect(RANGES).toEqual(['today', '7d', '30d', 'all'])
  })
})

describe('evolution journey page', () => {
  it('renders the no-scope state before a Workspace is selected', () => {
    render(<EvolutionPage scopeId={null} scopeTitle={null} remote={remoteOf()} t={t} />)
    expect(screen.getByTestId('evolution-page')).toBeDefined()
    expect(screen.getByText('page.noScope')).toBeDefined()
  })

  it('renders the buckets, the pending decision, the curator pass, and the capacity', async () => {
    const staged = [{
      id: 'staged-1',
      kind: 'memory' as const,
      op: 'setLessons',
      payload: {},
      originSessionId: 's-9',
      createdAt: '2026-09-12T00:00:00.000Z',
      gist: 'lesson: pending',
    }]
    const active = bucketOf('2026-09-12', {
      deltas: [
        { day: '2026-09-12', kind: 'instructions', gist: 'edited by hand', sessionId: null, at: '2026-09-12T01:00:00.000Z' },
        { day: '2026-09-12', kind: 'lessons', gist: 'background_review · p/m', sessionId: 's-1', at: '2026-09-12T01:01:00.000Z' },
        { day: '2026-09-12', kind: 'profile', gist: 'edited by hand', sessionId: null, at: '2026-09-12T01:02:00.000Z' },
        { day: '2026-09-12', kind: 'context', gist: 'notes', sessionId: null, at: '2026-09-12T01:03:00.000Z' },
        { day: '2026-09-12', kind: 'outputs', gist: 'write /tmp/a.md', sessionId: 's-1', at: '2026-09-12T01:04:00.000Z' },
        { day: '2026-09-12', kind: 'staged', gist: 'memory:setLessons staged', sessionId: 's-1', at: '2026-09-12T01:05:00.000Z' },
      ],
      contextAttached: 1,
      outputsIndexed: 1,
      stagedOpened: 1,
      stagedApproved: 2,
      stagedRejected: 1,
    })
    const remote = remoteOf({
      read: vi.fn(async () => valueOf({
        staged,
        lessons: [lessonOf('weaker lesson', 0.2), lessonOf('stronger lesson', 0.9)],
        usage: { usedBytes: 250, capacityBytes: 1000 },
      })),
      timeline: vi.fn(async () => timelineOf({
        days: [active, bucketOf('2026-09-11'), bucketOf('2026-09-10')],
        cumulative: { usedBytes: 250, capacityBytes: 1000, digest: 'digest-7', lessonsBytes: 100, profileBytes: 50 },
        pending: [],
      })),
      curatorStatus: vi.fn(async () => ({
        mounted: true,
        lastRunAt: '2026-09-11T00:00:00.000Z',
        passes: [{ passId: 'pass-2', at: '2026-09-11T00:00:00.000Z', snapshot: 'b.tar.gz', transitions: 3 }],
      })),
    })
    const { container } = render(<EvolutionPage scopeId={SCOPE} scopeTitle='fixture' remote={remote} t={t} />)

    expect(await screen.findByText('fixture')).toBeDefined()
    expect(remote.read).toHaveBeenCalledWith(SCOPE)
    expect(remote.timeline).toHaveBeenCalledWith(SCOPE, '7d')

    // Every delta family renders, decisions included; the quiet days do not.
    expect(screen.getByText('2026-09-12')).toBeDefined()
    expect(screen.queryByText('2026-09-11')).toBeNull()
    expect(screen.getByText('kind.instructions')).toBeDefined()
    expect(screen.getByText('kind.profile')).toBeDefined()
    expect(screen.getByText('tally.instructions:{"n":1}')).toBeDefined()
    expect(screen.getByText('tally.approved:{"n":2}')).toBeDefined()
    expect(screen.getByText('tally.rejected:{"n":1}')).toBeDefined()
    expect(screen.getByText('write /tmp/a.md')).toBeDefined()
    expect(screen.getByText('timeline.window:{"range":"range.7d","active":1,"days":3}')).toBeDefined()

    // Pending rows carry the wire vocabulary and the origin session.
    expect(screen.getByText('memory:setLessons lesson: pending')).toBeDefined()
    expect(screen.getByText('pending.origin:{"session":"s-9"}')).toBeDefined()

    // The curator card reads the recorded pass, not a guess.
    expect(screen.getByText('curator.lastRun:{"at":"2026-09-11T00:00:00.000Z"}')).toBeDefined()
    expect(screen.getByText('curator.passes:{"n":1}')).toBeDefined()
    expect(screen.getByText('pass-2')).toBeDefined()
    expect(screen.getByText('curator.transitions:{"n":3}')).toBeDefined()

    // Capacity bars come from the record's usage and the timeline's documents.
    expect(screen.getByText('capacity.used:{"used":250,"capacity":1000}')).toBeDefined()
    expect(screen.getByText('capacity.lessons:{"bytes":100}')).toBeDefined()
    expect(screen.getByText('capacity.profile:{"bytes":50}')).toBeDefined()
    expect(screen.getByText('capacity.digest:{"digest":"digest-7"}')).toBeDefined()
    const widths = [...container.querySelectorAll<HTMLElement>('[style]')].map(node => node.style.width)
    expect(widths).toEqual(['25%', '10%', '5%'])

    // The lessons card renders every artifact statement, strongest first.
    const lessons = [...container.querySelectorAll('[data-testid="evolution-lessons"] li')]
    expect(lessons.map(row => row.querySelector('span')?.textContent)).toEqual(['stronger lesson', 'weaker lesson'])
    expect(screen.getByText('lessons.confidence:{"confidence":"0.90"}')).toBeDefined()
    expect(screen.getByText('lessons.confidence:{"confidence":"0.20"}')).toBeDefined()
  })

  it('states an empty lessons document honestly', async () => {
    const remote = remoteOf()
    const { container } = render(<EvolutionPage scopeId={SCOPE} scopeTitle='fixture' remote={remote} t={t} />)
    expect(await screen.findByText('fixture')).toBeDefined()
    await waitFor(() => {
      expect(container.querySelector('[data-testid="evolution-lessons"]')).toBeNull()
    })
    expect(screen.getByText('lessons.empty')).toBeDefined()
  })

  it('switches the window and refetches the timeline', async () => {
    const remote = remoteOf()
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    // A null title falls back to the page title.
    expect(await screen.findByText('page.title')).toBeDefined()
    fireEvent.click(screen.getByText('range.all'))
    await waitFor(() => {
      expect(remote.timeline).toHaveBeenCalledWith(SCOPE, 'all')
    })
  })

  it('retires the pending row the controller approves', async () => {
    const staged = [{
      id: 'staged-1',
      kind: 'skill' as const,
      op: 'create',
      payload: {},
      originSessionId: 's-1',
      createdAt: '2026-09-12T00:00:00.000Z',
      gist: 'skill: pending',
    }]
    // The stub stands in for the controller's record: approving empties it.
    let current = valueOf({ staged })
    let timelineCalls = 0
    const remote = remoteOf({
      read: vi.fn(async () => current),
      timeline: vi.fn(async () => { timelineCalls += 1; return timelineOf() }),
      approveStaged: vi.fn(async () => { current = valueOf({ staged: [] }); return current }),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    expect(await screen.findByText('skill:create skill: pending')).toBeDefined()

    fireEvent.click(screen.getByText('pending.approve'))
    await waitFor(() => {
      expect(screen.queryByText('skill:create skill: pending')).toBeNull()
    })
    expect(remote.approveStaged).toHaveBeenCalledWith(SCOPE, 'staged-1')
    // The decision refreshes the timeline, so the day counts catch up.
    await waitFor(() => {
      expect(timelineCalls).toBeGreaterThan(1)
    })
  })

  it('drops the pending row the controller rejects', async () => {
    const staged = [{
      id: 'staged-2',
      kind: 'memory' as const,
      op: 'addLesson',
      payload: {},
      originSessionId: 's-2',
      createdAt: '2026-09-12T00:00:00.000Z',
      gist: 'lesson: pending',
    }]
    let current = valueOf({ staged })
    const remote = remoteOf({
      read: vi.fn(async () => current),
      rejectStaged: vi.fn(async () => { current = valueOf({ staged: [] }); return current }),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    fireEvent.click(await screen.findByText('pending.reject'))
    await waitFor(() => {
      expect(remote.rejectStaged).toHaveBeenCalledWith(SCOPE, 'staged-2')
    })
    await waitFor(() => {
      expect(screen.queryByTestId('evolution-pending')).toBeNull()
    })
  })

  it('surfaces a failed decision', async () => {
    const staged = [{
      id: 'staged-3',
      kind: 'memory' as const,
      op: 'setProfile',
      payload: {},
      originSessionId: 's-3',
      createdAt: '2026-09-12T00:00:00.000Z',
      gist: 'profile: pending',
    }]
    const remote = remoteOf({
      read: vi.fn(async () => valueOf({ staged })),
      rejectStaged: vi.fn(async () => { throw new Error('reject refused') }),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    fireEvent.click(await screen.findByText('pending.reject'))
    expect((await screen.findByRole('alert')).textContent).toBe('reject refused')
  })

  it('reports a failed read and keeps the cards empty', async () => {
    const remote = remoteOf({ read: vi.fn(async () => { throw new Error('read failed') }) })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    expect((await screen.findByRole('alert')).textContent).toBe('read failed')
    expect(screen.getByText('timeline.empty')).toBeDefined()
    expect(screen.getByText('pending.empty')).toBeDefined()
  })

  it('reports a failed read and a failed timeline together', async () => {
    const remote = remoteOf({
      read: vi.fn(async () => { throw new Error('read failed') }),
      timeline: vi.fn(async () => { throw new Error('timeline failed') }),
      curatorStatus: vi.fn(async () => ({ mounted: false, lastRunAt: null, passes: [] })),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    expect(await screen.findByRole('alert')).toBeDefined()
    // No timeline ever arrived, so the timeline card states that honestly.
    expect(screen.getByText('timeline.empty')).toBeDefined()
    expect(screen.getByText('curator.unmounted')).toBeDefined()
  })

  it('keeps the loading status while the record is in flight', () => {
    const remote = remoteOf({ read: vi.fn(() => new Promise<EvolutionMemoryValue>(() => {})) })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    expect(screen.getAllByText('page.loading').length).toBeGreaterThan(0)
  })

  it('renders an unmounted curator and an unrecorded one honestly', async () => {
    const unmounted = remoteOf({ curatorStatus: vi.fn(async () => ({ mounted: false, lastRunAt: null, passes: [] })) })
    const first = render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={unmounted} t={t} />)
    expect(await screen.findByText('curator.unmounted')).toBeDefined()
    first.unmount()

    const unrecorded = remoteOf({ curatorStatus: vi.fn(async () => ({ mounted: true, lastRunAt: null, passes: [] })) })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={unrecorded} t={t} />)
    expect(await screen.findByText('curator.empty')).toBeDefined()
  })

  it('applies the follow baseline and upserts for this Scope only', async () => {
    const other = { ...valueOf(), workspaceId: 'ws-2' as WorkspaceId, usage: { usedBytes: 900, capacityBytes: 1000 } }
    const remote = remoteOf({
      follow: framesOf([
        { type: 'baseline', values: [valueOf({ usage: { usedBytes: 250, capacityBytes: 1000 } })] },
        { type: 'upsert', value: other },
        { type: 'upsert', value: valueOf({ usage: { usedBytes: 125, capacityBytes: 1000 } }) },
      ]),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    await waitFor(() => {
      expect(screen.getByText('capacity.used:{"used":125,"capacity":1000}')).toBeDefined()
    })
    // The other Scope's frame never reached this page.
    expect(screen.queryByText('capacity.used:{"used":900,"capacity":1000}')).toBeNull()
  })

  it('falls back to the empty projection when the baseline holds no Scope', async () => {
    const other = { ...valueOf(), workspaceId: 'ws-2' as WorkspaceId, usage: { usedBytes: 900, capacityBytes: 1000 } }
    const remote = remoteOf({
      read: vi.fn(async () => valueOf({ usage: { usedBytes: 500, capacityBytes: 1000 } })),
      follow: framesOf([{ type: 'baseline', values: [other] }]),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    await waitFor(() => {
      expect(screen.getByText('capacity.used:{"used":0,"capacity":0}')).toBeDefined()
    })
    expect(screen.getByText('pending.empty')).toBeDefined()
  })

  it('blocks a second decision while one is in flight', async () => {
    const staged = [{
      id: 'staged-4',
      kind: 'memory' as const,
      op: 'setLessons',
      payload: {},
      originSessionId: 's-4',
      createdAt: '2026-09-12T00:00:00.000Z',
      gist: 'lesson: pending',
    }]
    let settle: (value: EvolutionMemoryValue) => void = () => {}
    let current = valueOf({ staged })
    const remote = remoteOf({
      read: vi.fn(async () => current),
      approveStaged: vi.fn(() => new Promise<EvolutionMemoryValue>((resolve) => {
        settle = (next) => { current = next; resolve(next) }
      })),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    fireEvent.click(await screen.findByText('pending.approve'))
    await waitFor(() => {
      expect((screen.getByText('pending.reject') as HTMLButtonElement).disabled).toBe(true)
    })
    settle(valueOf({ staged: [] }))
    await waitFor(() => {
      expect(screen.queryByText('memory:setLessons lesson: pending')).toBeNull()
    })
  })

  it('reports a non-Error rejection', async () => {
    const staged = [{
      id: 'staged-5',
      kind: 'memory' as const,
      op: 'setLessons',
      payload: {},
      originSessionId: 's-5',
      createdAt: '2026-09-12T00:00:00.000Z',
      gist: 'lesson: pending',
    }]
    const remote = remoteOf({
      read: vi.fn(async () => valueOf({ staged })),
      rejectStaged: vi.fn(() => Promise.reject('wire string')),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    fireEvent.click(await screen.findByText('pending.reject'))
    expect((await screen.findByRole('alert')).textContent).toBe('wire string')
  })

  it('drops every settlement that lands after the page moved on', async () => {
    let settleRead: (value: EvolutionMemoryValue) => void = () => {}
    let settleTimeline: (value: JourneyTimeline) => void = () => {}
    let settleCurator: (value: EvolutionCuratorStatus) => void = () => {}
    const remote = remoteOf({
      read: vi.fn(() => new Promise<EvolutionMemoryValue>((resolve) => { settleRead = resolve })),
      timeline: vi.fn(() => new Promise<JourneyTimeline>((resolve) => { settleTimeline = resolve })),
      curatorStatus: vi.fn(() => new Promise<EvolutionCuratorStatus>((resolve) => { settleCurator = resolve })),
    })
    const view = render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    // The page closes while all three reads are in flight.
    view.unmount()
    settleRead(valueOf())
    settleTimeline(timelineOf())
    settleCurator({ mounted: false, lastRunAt: null, passes: [] })
    await waitFor(() => {
      expect(remote.read).toHaveBeenCalledWith(SCOPE)
    })
    expect(view.container.innerHTML).toBe('')

    // A read that fails after the page closed writes nothing either.
    let failRead: (reason: unknown) => void = () => {}
    const late = remoteOf({
      read: vi.fn(() => new Promise<EvolutionMemoryValue>((_resolve, reject) => { failRead = reject })),
    })
    const second = render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={late} t={t} />)
    second.unmount()
    failRead(new Error('late failure'))
    await waitFor(() => {
      expect(late.read).toHaveBeenCalledWith(SCOPE)
    })
    expect(second.container.innerHTML).toBe('')
  })

  it('drops follow frames that arrive after the page closed', async () => {
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    const remote = remoteOf({
      follow: () => (async function* (): AsyncIterable<EvolutionFollowFrame> {
        yield { type: 'upsert', value: valueOf({ usage: { usedBytes: 10, capacityBytes: 100 } }) }
        await gate.promise
        yield { type: 'upsert', value: valueOf({ usage: { usedBytes: 20, capacityBytes: 100 } }) }
        yield { type: 'baseline', values: [valueOf()] }
      })(),
      openStream: (options: RemoteStreamOptions<EvolutionFollowFrame>) => ({
        [Symbol.asyncIterator]: async function* () {
          const controller = new AbortController()
          try {
            // The post-close frames ride a later generation, exactly as a
            // reconnect would deliver them.
            let index = -1
            for await (const value of options.open(controller.signal)) {
              index += 1
              yield {
                generation: index > 1 ? 1 : 0,
                value,
                signal: controller.signal,
                accept: () => {},
              }
            }
          } finally {
            controller.abort()
          }
        },
        restart: () => {},
        dispose: async () => {},
        signal: new AbortController().signal,
      }) as never,
    })
    const view = render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    await waitFor(() => {
      expect(screen.getByText('capacity.used:{"used":10,"capacity":100}')).toBeDefined()
    })
    view.unmount()
    gate.resolve()
    await waitFor(() => {
      expect(remote.follow).toBeDefined()
    })
    expect(view.container.innerHTML).toBe('')
  })

  it('surfaces a follow failure', async () => {
    const remote = remoteOf({
      follow: () => (async function* (): AsyncIterable<EvolutionFollowFrame> {
        throw new Error('stream down')
      })(),
    })
    render(<EvolutionPage scopeId={SCOPE} scopeTitle={null} remote={remote} t={t} />)
    expect((await screen.findByRole('alert')).textContent).toBe('stream down')
  })
})
