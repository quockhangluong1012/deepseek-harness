// @vitest-environment jsdom
/**
 * The Seats map framework state onto the page: the sidebar row's glyph keeps
 * its owner-given size, and the center-track panel resolves the selected
 * Session's Workspace — or renders the page's no-Scope state when no Session
 * names one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { EvolutionFollowFrame } from '../src/types.ts'
import type { EvolutionSeatProps } from '../src/client/Seat.tsx'
import { EvolutionPanelIcon, EvolutionSeat } from '../src/client/Seat.tsx'
import type { PageRemote } from '../src/client/rpc.ts'

afterEach(cleanup)

const t = ((key: string) => key) as never

/** Selector stub serving one fixed snapshot to any hook shape. */
function stub<T>(snapshot: T): (selector: (state: T) => unknown) => unknown {
  return selector => selector(snapshot)
}

function remoteOf(): PageRemote {
  return {
    read: vi.fn(async () => { throw new Error('unused') }),
    timeline: vi.fn(async () => { throw new Error('unused') }),
    approveStaged: vi.fn(),
    rejectStaged: vi.fn(),
    curatorStatus: vi.fn(async () => { throw new Error('unused') }),
    follow: () => (async function* () {})(),
    // An idle generation: the page's follow loop consumes nothing and quiesces.
    openStream: (options: RemoteStreamOptions<EvolutionFollowFrame>) => ({
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
  }
}

function sharesOf(overrides: Partial<EvolutionSeatProps> = {}): EvolutionSeatProps {
  return {
    useSessions: stub({ current: 's-1' }) as never,
    useWorkspaces: stub({
      items: [{
        workspaceId: 'ws-1',
        title: 'Project',
        path: '/work/project',
        sessionIds: ['s-1'],
        createdAt: '',
        updatedAt: '',
      }],
    }) as never,
    remote: remoteOf(),
    t,
    ...overrides,
  } as EvolutionSeatProps
}

describe('evolution journey seats', () => {
  it('renders the panel row glyph at the owner size', () => {
    const { container } = render(<EvolutionPanelIcon size={18} active />)
    const svg = container.querySelector('svg')
    expect(svg?.getAttribute('width')).toBe('18')
  })

  it('opens the selected session workspace as the Scope', async () => {
    const remote = remoteOf()
    render(<EvolutionSeat {...sharesOf({ remote })} />)
    expect(await screen.findByTestId('evolution-page')).toBeDefined()
    expect(remote.read).toHaveBeenCalledWith('ws-1')
  })

  it('renders the no-Scope state without a current session', () => {
    render(<EvolutionSeat {...sharesOf({ useSessions: stub({ current: undefined }) as never })} />)
    expect(screen.getByText('page.noScope')).toBeDefined()
  })

  it('renders the no-Scope state when the registry no longer lists the workspace', () => {
    render(<EvolutionSeat {...sharesOf({ useWorkspaces: stub({ items: [] }) as never })} />)
    expect(screen.getByText('page.noScope')).toBeDefined()
  })
})
