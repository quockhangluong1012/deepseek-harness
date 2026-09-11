// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceMemoryFollowFrame, WorkspaceMemoryValue } from '../src/types.ts'
import { WorkspaceMemorySeat } from '../src/client/Seat.tsx'
import type { WorkspaceMemorySeatProps } from '../src/client/Seat.tsx'
import type { PageRemote } from '../src/client/rpc.ts'

afterEach(cleanup)

const t = ((key: string) => key) as never

function valueOf(): WorkspaceMemoryValue {
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
  }
}

/** Selector stub serving one fixed snapshot to any hook shape. */
function stub<T>(snapshot: T): (selector: (state: T) => unknown) => unknown {
  return selector => selector(snapshot)
}

function drivingStream(open: (signal: AbortSignal) => AsyncIterable<WorkspaceMemoryFollowFrame>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      const controller = new AbortController()
      try {
        for await (const value of open(controller.signal)) {
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

function remoteOf(): PageRemote {
  return {
    read: vi.fn(async (): Promise<WorkspaceMemoryValue> => valueOf()),
    setDescription: vi.fn(),
    setInstructions: vi.fn(),
    setMemory: vi.fn(),
    addTextItem: vi.fn(),
    addFileItem: vi.fn(),
    removeContextItem: vi.fn(),
    listContextFiles: vi.fn(),
    rebuildMemory: vi.fn(),
    follow: () => (async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {})(),
    openStream: (options: RemoteStreamOptions<WorkspaceMemoryFollowFrame>) => drivingStream(options.open),
  }
}

function sharesOf(overrides: Partial<WorkspaceMemorySeatProps> = {}): WorkspaceMemorySeatProps {
  return {
    useWorkspacePage: stub('ws-1') as never,
    useSessions: stub({ byId: {} }) as never,
    useWorkspaces: stub({
      items: [{ workspaceId: 'ws-1', title: 'Project', path: '/work/project', sessionIds: [] }],
      archivedSessionIds: [],
    }) as never,
    remote: remoteOf(),
    openSession: vi.fn(),
    closePage: vi.fn(),
    t,
    ...overrides,
  } as WorkspaceMemorySeatProps
}

describe('workspace-memory page seat', () => {
  it('renders nothing while no Workspace is open', () => {
    const { container } = render(<WorkspaceMemorySeat {...sharesOf({
      useWorkspacePage: stub(null) as never,
    })} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when the workspace is gone', () => {
    const { container } = render(<WorkspaceMemorySeat {...sharesOf({
      useWorkspaces: stub({ items: [], archivedSessionIds: [] }) as never,
    })} />)
    expect(container.firstChild).toBeNull()
  })

  it('maps chats and activity from the session list', async () => {
    const turnOutline = [
      { turn: 2, seq: 4, prompt: 'second prompt', response: 'r2' },
      { turn: 1, seq: 1, prompt: 'first prompt', response: 'r1' },
    ]
    const props = sharesOf({
      useSessions: stub({
        byId: {
          s1: { id: 's1', displayTitle: 'First', updatedAt: 200, projectionValues: { turnOutline } },
          s2: { id: 's2', displayTitle: 'Second', updatedAt: 100 },
        },
      }) as never,
      useWorkspaces: stub({
        items: [{ workspaceId: 'ws-1', title: 'Project', path: '/work/project', sessionIds: ['s1', 's2', 'gone'] }],
        archivedSessionIds: [],
      }) as never,
    })
    render(<WorkspaceMemorySeat {...props} />)
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()
    // Chats follow workspace order, skipping unknown ids.
    expect(screen.getByText('First')).toBeDefined()
    expect(screen.getByText('Second')).toBeDefined()
    expect(screen.queryByText('gone')).toBeNull()
    // Activity orders by session recency, capped at 50 rows.
    fireEvent.click(screen.getByText('activity.title'))
    expect(screen.getByText('second prompt')).toBeDefined()
    expect(screen.getByText('first prompt')).toBeDefined()
  })

  it('renders a repeated id once and hides archived and blank sessions', async () => {
    const props = sharesOf({
      useSessions: stub({
        current: 's5',
        byId: {
          s1: { id: 's1', displayTitle: 'Same', updatedAt: 200 },
          s2: { id: 's2', displayTitle: 'Same', updatedAt: 100 },
          s3: { id: 's3', displayTitle: 'Archived', updatedAt: 300 },
          s4: { id: 's4', displayTitle: 'Blank', updatedAt: 400, blank: true },
          s5: { id: 's5', displayTitle: 'Current blank', updatedAt: 500, blank: true },
        },
      }) as never,
      useWorkspaces: stub({
        items: [{ workspaceId: 'ws-1', title: 'Project', path: '/work/project', sessionIds: ['s1', 's1', 's2', 's3', 's4', 's5', 'gone'] }],
        archivedSessionIds: ['s3'],
      }) as never,
    })
    render(<WorkspaceMemorySeat {...props} />)
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()
    // s1 and s2 are distinct sessions sharing a title, so both stay; the
    // repeated s1 id, the archived s3, the unselected blank s4, and the
    // unknown id go, while the selected blank s5 stays.
    expect(screen.getAllByText('Same')).toHaveLength(2)
    expect(screen.queryByText('Archived')).toBeNull()
    expect(screen.queryByText('Blank')).toBeNull()
    expect(screen.getByText('Current blank')).toBeDefined()
    expect(screen.queryByText('gone')).toBeNull()
  })

  it('opens sessions and leaves the page', async () => {
    const openSession = vi.fn()
    const closePage = vi.fn()
    const props = sharesOf({
      openSession,
      closePage,
      useSessions: stub({
        byId: { s1: { id: 's1', displayTitle: 'First', updatedAt: 200 } },
      }) as never,
      useWorkspaces: stub({
        items: [{ workspaceId: 'ws-1', title: 'Project', path: '/work/project', sessionIds: ['s1'] }],
      }) as never,
    })
    render(<WorkspaceMemorySeat {...props} />)
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()
    fireEvent.click(screen.getByText('First'))
    expect(openSession).toHaveBeenCalledWith('s1')
    expect(closePage).toHaveBeenCalled()
  })
})
