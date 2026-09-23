// @vitest-environment jsdom
/**
 * The assembled Workspace page: the real plugin face drives the real page
 * through-stubbed Remote namespace and session doubles. Covers the apply
 * closures (verb binding, Workspace-Session resolution, page yield rules) that
 * unit seats cannot reach.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { SlotTestRuntime, TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type {} from '@deepseek-ai/dsh-session-turn-outline/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { WorkspaceMemoryFollowFrame, WorkspaceMemoryValue } from '../src/types.ts'
import { apply, inject } from '../src/client/index.ts'

usePinnedBrowserLanguages('en')

afterEach(cleanup)

function valueOf(): WorkspaceMemoryValue {
  return {
    workspaceId: 'ws-1' as WorkspaceId,
    description: '',
    instructions: 'rules',
    memory: 'doc',
    memoryUpdatedAt: null,
    contextItems: [],
    outputs: [{ path: '/work/project/out.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }],
    lastExtraction: null,
    usage: { usedBytes: 9, capacityBytes: 100 },
    updatedAt: new Date().toISOString(),
  }
}

async function bench() {
  const runtime = await SlotTestRuntime.create()
  const value = valueOf()
  const calls: { method: string; args: unknown[] }[] = []
  const record = (method: string) => async (request: never) => {
    calls.push({ method, args: [request] })
    return { ok: true as const, value }
  }
  const ns = {
    read: record('read'),
    setDescription: record('setDescription'),
    setInstructions: record('setInstructions'),
    setMemory: record('setMemory'),
    addContextItem: record('addContextItem'),
    removeContextItem: record('removeContextItem'),
    listContextFiles: async () => ({ ok: true as const, value: { paths: [] } }),
    rebuildMemory: record('rebuildMemory'),
    follow: async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {
      yield { type: 'baseline', values: [value] }
    },
  }
  const remote = new TestRemote(runtime.ctx, { workspaceMemory: ns })
  Object.assign(remote, {
    directoryPicker: {},
    $stream: (options: {
      open(signal: AbortSignal): AsyncIterable<WorkspaceMemoryFollowFrame>
    }) => ({
      [Symbol.asyncIterator]: async function* () {
        const controller = new AbortController()
        try {
          for await (const item of options.open(controller.signal)) {
            yield { generation: 0, value: item, signal: controller.signal, accept: () => {} }
          }
        } finally {
          controller.abort()
        }
      },
      restart: () => {},
      dispose: async () => {},
      signal: new AbortController().signal,
    }),
  })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  // The blank Session a Workspace resolves to is what the page talks through.
  await runtime.sessions.add({
    id: 's1',
    summary: {
      displayTitle: 'First',
      blank: true,
      updatedAt: Date.now(),
      projectionValues: { turnOutline: [{ turn: 1, seq: SessionSeq(0), prompt: 'do it', response: 'done' }] },
    },
    session: {},
  })
  let mainReference: { release(): void } | undefined
  const openSession = vi.fn((id: SessionId): void => {
    mainReference?.release()
    mainReference = runtime.sessions.retain(id, { source: 'mainView' })
  })
  const clearCurrentSession = (): void => {
    mainReference?.release()
    mainReference = undefined
  }
  const connectWorkspace = vi.fn(async () => 's1' as SessionId)
  runtime.ctx.provide('uiWorkspace', { connectWorkspace, openSession })
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: 'ws-1' as WorkspaceId, title: 'Project', path: '/work/project',
      sessionIds: ['s1' as SessionId], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] as never
  })
  await runtime.declare({ 'shell.page': { kind: 'single', scope: 'root' } } as never)
  const handle = await runtime.mount({ inject: [...inject], apply })
  const seat = runtime.renderSlot('shell.page', {})
  return { runtime, handle, seat, calls, connectWorkspace, openSession, clearCurrentSession, ns }
}

describe('assembled workspace-memory page', () => {
  it('registers the route only while a workspace is open', async () => {
    const { runtime, handle, seat } = await bench()
    try {
      expect(runtime.slots.entries('shell.page')).toHaveLength(0)
      expect(seat.container.firstChild).toBeNull()
      await act(async () => {
        runtime.ctx.get('workspacePage')?.open('ws-1')
      })
      expect(runtime.slots.entries('shell.page')).toHaveLength(1)
      expect(await seat.view.findByTestId('workspace-memory-page')).toBeDefined()
      await act(async () => {
        runtime.ctx.get('workspacePage')?.open('ws-1')
      })
      expect(runtime.slots.entries('shell.page')).toHaveLength(1)
      await act(async () => {
        runtime.ctx.get('workspacePage')?.close()
      })
      expect(runtime.slots.entries('shell.page')).toHaveLength(0)
    } finally {
      await runtime.dispose()
      await handle.dispose()
    }
  })

  it('opens onto the Workspace Session, saves, and navigates', async () => {
    const { runtime, handle, seat, calls, connectWorkspace, openSession } = await bench()
    try {
      expect(seat.container.firstChild).toBeNull()
      await act(async () => {
        runtime.ctx.get('workspacePage')?.open('ws-1')
      })
      expect(await seat.view.findByTestId('workspace-memory-page')).toBeDefined()

      // The page selects the Workspace's Session so the conversation route's composer is live.
      expect(connectWorkspace).toHaveBeenCalledWith('ws-1')
      expect(openSession).toHaveBeenCalledWith('s1' as SessionId)

      // Live baseline headers and the session-driven tabs render.
      expect(seat.view.getByText('Project')).toBeDefined()
      expect(seat.view.getByText('First')).toBeDefined()

      fireEvent.click(seat.view.getByText('Add a description…'))
      const region = seat.view.getByRole('region', { name: 'Description' })
      const editor = region.querySelector('textarea') as HTMLTextAreaElement
      fireEvent.change(editor, { target: { value: 'typed' } })
      fireEvent.click(seat.view.getByText('Save'))
      await act(async () => {})
      expect(calls.some(call => call.method === 'setDescription')).toBe(true)

      // An output tile opens its producing session and closes the page.
      fireEvent.click(seat.view.getByTitle('/work/project/out.ts'))
      expect(openSession).toHaveBeenCalled()
      expect(seat.container.firstChild).toBeNull()
    } finally {
      await runtime.dispose()
      await handle.dispose()
    }
  })

  it('keeps the page standing when the Workspace has no Session to connect', async () => {
    const { runtime, handle, seat, connectWorkspace } = await bench()
    try {
      connectWorkspace.mockRejectedValueOnce(new Error('connect down'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await act(async () => {
          runtime.ctx.get('workspacePage')?.open('ws-1')
        })
        expect(await seat.view.findByTestId('workspace-memory-page')).toBeDefined()
        expect(warn).toHaveBeenCalled()
        // A later list republish still finds the anchored Session selected, so
        // the page keeps the route while the conversation has no binding of its own.
        await act(async () => {
          await runtime.sessions.updateSummary('s1', { displayTitle: 'Renamed' })
        })
        expect(seat.view.getByTestId('workspace-memory-page')).toBeDefined()
      } finally {
        warn.mockRestore()
      }
    } finally {
      await runtime.dispose()
      await handle.dispose()
    }
  })

  it('yields when another Session takes the column while connecting', async () => {
    const { runtime, handle, seat, connectWorkspace, openSession } = await bench()
    try {
      let resolveConnect!: (id: SessionId) => void
      connectWorkspace.mockImplementationOnce(() => new Promise<SessionId>((resolve) => {
        resolveConnect = resolve
      }))
      await runtime.sessions.add({
        id: 's2',
        summary: { displayTitle: 'Second', updatedAt: 2, projectionValues: { turnOutline: [] } },
        session: {},
      })
      act(() => {
        runtime.ctx.get('workspacePage')?.open('ws-1')
      })
      // The reader picks another conversation before the connect lands; the
      // connect's own selection is ignored, but this one is not.
      await act(async () => {
        openSession('s2' as SessionId)
      })
      expect(seat.view.getByTestId('workspace-memory-page')).toBeDefined()
      await act(async () => { resolveConnect('s1' as SessionId) })
      expect(seat.view.queryByTestId('workspace-memory-page')).toBeNull()
    } finally {
      await runtime.dispose()
      await handle.dispose()
    }
  })

  it('does not select a Session for a page closed while connecting', async () => {
    const { runtime, handle, connectWorkspace, openSession } = await bench()
    try {
      let resolveConnect!: (id: SessionId) => void
      connectWorkspace.mockImplementationOnce(() => new Promise<SessionId>((resolve) => {
        resolveConnect = resolve
      }))
      act(() => {
        runtime.ctx.get('workspacePage')?.open('ws-1')
      })
      act(() => {
        runtime.ctx.get('workspacePage')?.close()
      })
      await act(async () => { resolveConnect('s1' as SessionId) })
      expect(openSession).not.toHaveBeenCalled()

      connectWorkspace.mockRejectedValueOnce(new Error('connect down'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        act(() => {
          runtime.ctx.get('workspacePage')?.open('ws-1')
        })
        act(() => {
          runtime.ctx.get('workspacePage')?.close()
        })
        await act(async () => {})
        // The page is gone, so its failed connect is nobody's to report.
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    } finally {
      await runtime.dispose()
      await handle.dispose()
    }
  })

  it('stands through a cleared selection and an unchanged anchor', async () => {
    const { runtime, handle, seat, connectWorkspace, clearCurrentSession } = await bench()
    try {
      // Nothing is open: closing is a no-op, not a stray notification.
      act(() => {
        runtime.ctx.get('workspacePage')?.close()
      })

      // The connect is still in flight while the list republishes the anchored
      // Session: the page must not read its own anchor as "another session".
      let resolveConnect!: (id: SessionId) => void
      connectWorkspace.mockImplementationOnce(() => new Promise<SessionId>((resolve) => {
        resolveConnect = resolve
      }))
      await act(async () => {
        runtime.ctx.get('workspacePage')?.open('ws-1')
      })
      await act(async () => {
        await runtime.sessions.updateSummary('s1', { displayTitle: 'Renamed' })
      })
      expect(seat.view.getByTestId('workspace-memory-page')).toBeDefined()
      await act(async () => { resolveConnect('s1' as SessionId) })

      // A cleared selection leaves the page standing: the page is also what the
      // no-session view shows.
      await act(async () => {
        clearCurrentSession()
      })
      expect(seat.view.getByTestId('workspace-memory-page')).toBeDefined()
    } finally {
      await runtime.dispose()
      await handle.dispose()
    }
  })

  it('yields the center column to a session opened elsewhere', async () => {
    const { runtime, handle, seat, openSession } = await bench()
    try {
      await act(async () => {
        runtime.ctx.get('workspacePage')?.open('ws-1')
      })
      expect(await seat.view.findByTestId('workspace-memory-page')).toBeDefined()

      // The sidebar opens sessions through the same service: the page must not
      // keep covering the conversation the click asked to show.
      await runtime.sessions.add({
        id: 's2',
        summary: { displayTitle: 'Second', updatedAt: 2, projectionValues: { turnOutline: [] } },
        session: {},
      })
      await act(async () => {
        openSession('s2' as SessionId)
      })
      expect(seat.view.queryByTestId('workspace-memory-page')).toBeNull()
    } finally {
      await runtime.dispose()
      await handle.dispose()
    }
  })

  it('yields the column once its own Session is talked to', async () => {
    const { runtime, handle, seat } = await bench()
    try {
      await act(async () => {
        runtime.ctx.get('workspacePage')?.open('ws-1')
      })
      expect(await seat.view.findByTestId('workspace-memory-page')).toBeDefined()

      // The first prompt clears the blank bit client-side; the reply streams in
      // the conversation the page was covering, so the page gets out of its way.
      await act(async () => {
        await runtime.sessions.updateSummary('s1', { blank: false })
      })
      expect(seat.view.queryByTestId('workspace-memory-page')).toBeNull()
    } finally {
      await runtime.dispose()
      await handle.dispose()
    }
  })
})
