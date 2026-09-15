/**
 * The journey page's Remote face binds the frozen controller verbs into
 * throwing calls and applies follow frames in arrival order.
 */
import { describe, expect, it, vi } from 'vitest'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type {
  EvolutionFollowFrame,
  EvolutionMemoryValue,
  JourneyTimeline,
  LessonArtifact,
  WorkspaceId,
} from '../src/types.ts'
import { bindPageVerbs, followEvolution, unwrapResult } from '../src/client/rpc.ts'

/** One lesson artifact carried by the projection fixtures. */
function lessonOf(statement: string): LessonArtifact {
  return {
    id: statement,
    statement,
    source: 's1',
    conditions: '',
    evidence: 'inference',
    confidence: 0.5,
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
    workspaceId: 'ws-1' as WorkspaceId,
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
    usage: { usedBytes: 0, capacityBytes: 100 },
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

function timelineOf(overrides: Partial<JourneyTimeline> = {}): JourneyTimeline {
  return {
    range: '7d',
    now: 0,
    days: [],
    cumulative: { usedBytes: 0, capacityBytes: 100, digest: 'd', lessonsBytes: 0, profileBytes: 0 },
    pending: [],
    ...overrides,
  }
}

function rawOf() {
  const value = valueOf()
  const timeline = timelineOf()
  return {
    read: vi.fn(async () => ({ ok: true as const, value })),
    timeline: vi.fn(async () => ({ ok: true as const, value: timeline })),
    approveStaged: vi.fn(async () => ({ ok: true as const, value })),
    rejectStaged: vi.fn(async () => ({ ok: true as const, value })),
    status: vi.fn(async () => ({
      ok: true as const,
      value: { mounted: true, lastRunAt: null, passes: [], cacheHitRate: null, skillFailureRate: null },
    })),
  }
}

describe('evolution rpc face', () => {
  it('unwraps results and throws failures', () => {
    expect(unwrapResult({ ok: true, value: 7 } as never)).toBe(7)
    const failure = { code: 'x', message: 'nope' }
    expect(() => unwrapResult({ ok: false, error: failure } as never)).toThrow(failure)
  })

  it('binds every verb through its request shape', async () => {
    const raw = rawOf()
    const verbs = bindPageVerbs({ evolution: raw, evolutionCurator: raw })
    const id = 'ws-1' as WorkspaceId
    await expect(verbs.read(id)).resolves.toMatchObject({ workspaceId: 'ws-1' })
    await expect(verbs.timeline(id, '30d')).resolves.toMatchObject({ range: '7d' })
    await expect(verbs.approveStaged(id, 'staged-1')).resolves.toBeDefined()
    await expect(verbs.rejectStaged(id, 'staged-1')).resolves.toBeDefined()
    await expect(verbs.curatorStatus()).resolves.toMatchObject({ mounted: true })
    expect(raw.read).toHaveBeenCalledWith({ scopeId: id })
    expect(raw.timeline).toHaveBeenCalledWith({ scopeId: id, range: '30d' })
    expect(raw.approveStaged).toHaveBeenCalledWith({ scopeId: id, stagedId: 'staged-1' })
    expect(raw.rejectStaged).toHaveBeenCalledWith({ scopeId: id, stagedId: 'staged-1' })
    expect(raw.status).toHaveBeenCalledWith()
  })

  it('throws the Host failure for a rejected verb', async () => {
    const failure = { code: 'evolution/staged-not-found', message: 'gone' }
    const verbs = bindPageVerbs({
      evolution: { rejectStaged: async () => ({ ok: false, error: failure }) } as never,
      evolutionCurator: {} as never,
    })
    await expect(verbs.rejectStaged('ws-1' as WorkspaceId, 'staged-1')).rejects.toBe(failure)
  })

  it('follows baselines and upserts through the snapshot stream', async () => {
    const baseline = valueOf()
    const upsert = valueOf({ lessons: [lessonOf('new')] })
    const frames: EvolutionFollowFrame[] = [
      { type: 'baseline', values: [baseline] },
      { type: 'upsert', value: upsert },
    ]
    const replaced: EvolutionMemoryValue[][] = []
    const upserted: EvolutionMemoryValue[] = []
    const failed: unknown[] = []
    const stream = followEvolution(
      {
        follow: () => (async function* (): AsyncIterable<EvolutionFollowFrame> {
          yield* frames
        })(),
        openStream: (options: RemoteStreamOptions<EvolutionFollowFrame>) => {
          expect(options.ended(true)).toBeInstanceOf(Error)
          expect(options.ended(false)).toBeInstanceOf(Error)
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
        },
      },
      {
        replace: values => replaced.push([...values]),
        upsert: value => upserted.push(value),
        failed: error => failed.push(error),
      },
    )
    await stream.dispose()
    expect(replaced).toEqual([[baseline]])
    expect(upserted).toEqual([upsert])
    expect(failed).toHaveLength(0)
  })

  it('publishes a second opening snapshot in one generation as a failure', async () => {
    const failed: unknown[] = []
    const stream = followEvolution(
      {
        follow: () => (async function* (): AsyncIterable<EvolutionFollowFrame> {
          yield { type: 'baseline', values: [] }
          yield { type: 'baseline', values: [] }
        })(),
        openStream: options => ({
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
        }) as never,
      },
      { replace: () => {}, upsert: () => {}, failed: error => failed.push(error) },
    )
    await vi.waitFor(() => {
      expect(failed).toHaveLength(1)
    })
    expect((failed[0] as Error).message).toContain('more than one opening snapshot')
    await stream.dispose()
  })

  it('publishes stream failures', async () => {
    const failed: unknown[] = []
    const stream = followEvolution(
      {
        follow: () => (async function* (): AsyncIterable<EvolutionFollowFrame> {
          throw new Error('carrier down')
        })(),
        openStream: options => ({
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
        }) as never,
      },
      { replace: () => {}, upsert: () => {}, failed: error => failed.push(error) },
    )
    await vi.waitFor(() => {
      expect(failed).toHaveLength(1)
    })
    await stream.dispose()
  })

  it('idles after the baseline until the subscription ends', async () => {
    const baseline = valueOf()
    const replaced: EvolutionMemoryValue[][] = []
    const upserted: EvolutionMemoryValue[] = []
    let observedAbort = false
    const abortGate: PromiseWithResolvers<void> = Promise.withResolvers()
    let innerAbort: (() => void) | undefined
    const stream = followEvolution(
      {
        follow: (signal: AbortSignal) => (async function* (): AsyncIterable<EvolutionFollowFrame> {
          yield { type: 'baseline', values: [baseline] }
          if (signal.aborted) return
          signal.addEventListener('abort', () => { observedAbort = true; abortGate.resolve() }, { once: true })
          await abortGate.promise
        })(),
        openStream: (options: RemoteStreamOptions<EvolutionFollowFrame>) => ({
          [Symbol.asyncIterator]: async function* () {
            const controller = new AbortController()
            innerAbort = (): void => { controller.abort() }
            try {
              for await (const value of options.open(controller.signal)) {
                yield { generation: 0, value, signal: controller.signal, accept: () => {} }
              }
            } finally {
              controller.abort()
            }
          },
          restart: () => {},
          dispose: async () => { innerAbort?.() },
          signal: new AbortController().signal,
        }) as never,
      },
      {
        replace: values => replaced.push([...values]),
        upsert: value => upserted.push(value),
        failed: () => {},
      },
    )
    await vi.waitFor(() => {
      expect(replaced).toHaveLength(1)
    })
    const quietGate: PromiseWithResolvers<void> = Promise.withResolvers()
    setTimeout(quietGate.resolve, 50)
    await quietGate.promise
    expect(upserted).toHaveLength(0)
    await stream.dispose()
    expect(observedAbort).toBe(true)
  })
})
