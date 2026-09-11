import { describe, expect, it, vi } from 'vitest'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceMemoryFollowFrame, WorkspaceMemoryValue } from '../src/types.ts'
import { bindPageVerbs, followMemory, unwrapResult } from '../src/client/rpc.ts'

function valueOf(overrides: Partial<WorkspaceMemoryValue> = {}): WorkspaceMemoryValue {
  return {
    workspaceId: 'ws-1' as WorkspaceId,
    description: '',
    instructions: '',
    memory: '',
    memoryUpdatedAt: null,
    contextItems: [],
    outputs: [],
    lastExtraction: null,
    usage: { usedBytes: 0, capacityBytes: 100 },
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

function rawOf() {
  const value = valueOf()
  return {
    read: vi.fn(async () => ({ ok: true as const, value })),
    setDescription: vi.fn(async () => ({ ok: true as const, value })),
    setInstructions: vi.fn(async () => ({ ok: true as const, value })),
    setMemory: vi.fn(async () => ({ ok: true as const, value })),
    addContextItem: vi.fn(async () => ({ ok: true as const, value })),
    removeContextItem: vi.fn(async () => ({ ok: true as const, value })),
    listContextFiles: vi.fn(async () => ({ ok: true as const, value: { paths: ['a.md'] } })),
    rebuildMemory: vi.fn(async () => ({ ok: true as const, value })),
  }
}

describe('workspace-memory rpc face', () => {
  it('unwraps results and throws failures', () => {
    expect(unwrapResult({ ok: true, value: 7 } as never)).toBe(7)
    const failure = { code: 'x', message: 'nope' }
    expect(() => unwrapResult({ ok: false, error: failure } as never)).toThrow(failure)
  })

  it('binds every verb through its request shape', async () => {
    const raw = rawOf()
    const verbs = bindPageVerbs({ workspaceMemory: raw })
    const id = 'ws-1' as WorkspaceId
    const signal = new AbortController().signal
    await expect(verbs.read(id)).resolves.toMatchObject({ workspaceId: 'ws-1' })
    await expect(verbs.setDescription(id, 'd')).resolves.toBeDefined()
    await expect(verbs.setInstructions(id, 'i')).resolves.toBeDefined()
    await expect(verbs.setMemory(id, 'm')).resolves.toBeDefined()
    await expect(verbs.addTextItem(id, 'label', 'text')).resolves.toBeDefined()
    await expect(verbs.addFileItem(id, 'label', '/w/a.md')).resolves.toBeDefined()
    await expect(verbs.removeContextItem(id, 'item')).resolves.toBeDefined()
    await expect(verbs.listContextFiles(id, 'q', signal)).resolves.toEqual(['a.md'])
    await expect(verbs.rebuildMemory(id, signal)).resolves.toBeDefined()
    expect(raw.read).toHaveBeenCalledWith({ workspaceId: id })
    expect(raw.addContextItem).toHaveBeenCalledWith({ workspaceId: id, kind: 'text', label: 'label', text: 'text' })
    expect(raw.addContextItem).toHaveBeenCalledWith({ workspaceId: id, kind: 'file', label: 'label', path: '/w/a.md' })
  })

  it('throws the Host failure for a rejected verb', async () => {
    const failure = { code: 'workspace-memory/too-large', message: 'big' }
    const verbs = bindPageVerbs({
      workspaceMemory: { setInstructions: async () => ({ ok: false, error: failure }) } as never,
    })
    await expect(verbs.setInstructions('ws-1' as WorkspaceId, 'x')).rejects.toBe(failure)
  })

  it('follows baselines and upserts through the snapshot stream', async () => {
    const baseline = valueOf()
    const upsert = valueOf({ memory: 'new' })
    const frames: WorkspaceMemoryFollowFrame[] = [
      { type: 'baseline', values: [baseline] },
      { type: 'upsert', value: upsert },
    ]
    const replaced: WorkspaceMemoryValue[][] = []
    const upserted: WorkspaceMemoryValue[] = []
    const failed: unknown[] = []
    const stream = followMemory(
      {
        follow: () => (async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {
          yield* frames
        })(),
        openStream: (options: RemoteStreamOptions<WorkspaceMemoryFollowFrame>) => {
          const endedAccepted = options.ended(true)
          const endedBare = options.ended(false)
          expect(endedAccepted).toBeInstanceOf(Error)
          expect(endedBare).toBeInstanceOf(Error)
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

  it('publishes stream failures', async () => {
    const failed: unknown[] = []
    const stream = followMemory(
      {
        follow: () => (async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {
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
    const replaced: WorkspaceMemoryValue[][] = []
    const upserted: WorkspaceMemoryValue[] = []
    let observedAbort = false
    const abortGate: PromiseWithResolvers<void> = Promise.withResolvers()
    let innerAbort: (() => void) | undefined
    const stream = followMemory(
      {
        follow: (signal: AbortSignal) => (async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {
          yield { type: 'baseline', values: [baseline] }
          if (signal.aborted) return
          signal.addEventListener('abort', () => { observedAbort = true; abortGate.resolve() }, { once: true })
          await abortGate.promise
        })(),
        openStream: (options: RemoteStreamOptions<WorkspaceMemoryFollowFrame>) => ({
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
