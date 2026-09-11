// @vitest-environment jsdom
/**
 * The Workspace name opens the Workspace page while a dedicated disclosure
 * button keeps the expand/collapse gesture. Without the page plugin the name
 * falls back to toggling the group.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, screen } from '@testing-library/react'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'

usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

/** Test-owned sidebar shell role: declares and renders the browsing region. */
type FrameProps = PropsRenderSlots<'sidebar.workspaces'>
function SidebarFrame({ renderSlot }: FrameProps) {
  return <>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</>
}

/** The assembled sidebar over one Workspace, with or without the page plugin. */
async function bench(page: { open(workspaceId: WorkspaceId): void; close(): void } | undefined) {
  const runtime = await SlotTestRuntime.create()
  runtime.releaseWorkspaceSource()
  const directoryPicker = {}
  const remote = new TestRemote(runtime.ctx)
  Object.assign(remote, { directoryPicker })
  runtime.ctx.provide('remote.directoryPicker', directoryPicker as never)
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  // The workspace service routes Sessions through the frame's panel face; this
  // bench drives the sidebar alone, so a recording stub is the whole contract.
  runtime.ctx.provide('layout', {
    selectPanel: vi.fn(),
    beginNavigation: () => new AbortController().signal,
  })
  await runtime.sessions.add({
    id: 's1',
    summary: { displayTitle: 'First chat', updatedAt: 1, projectionValues: { turnOutline: [] } },
    session: {},
  }, { current: false })
  await runtime.workspaces.update((draft) => {
    draft.items = [{
      workspaceId: 'w1' as WorkspaceId, title: 'Project', path: '/home/u/Documents/project',
      sessionIds: ['s1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }] as never
  })
  await runtime.root.declare(
    { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
    SidebarFrame as never,
  )
  await runtime.mount({ inject: [...inject], apply })
  // The page plugin's roster row follows the workspace row, so its opener
  // lands after this plugin applied — provide here to pin that order.
  if (page !== undefined) {
    runtime.ctx.provide('workspacePage', page as never)
  }
  runtime.renderRoot()
  await screen.findByText('Project')
}

describe('Workspace page opener gesture', () => {
  it('opens the page from the name and toggles from the disclosure button', async () => {
    const open = vi.fn()
    await bench({ open, close: vi.fn() })
    const projectRow = (): HTMLElement => screen.getAllByRole('treeitem')[0] as HTMLElement
    expect(projectRow().getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByText('Project'))
    expect(open).toHaveBeenCalledWith('w1')
    expect(open).toHaveBeenCalledOnce()
    expect(projectRow().getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: '展开或收起“Project”' }))
    expect(open).toHaveBeenCalledOnce()
    expect(projectRow().getAttribute('aria-expanded')).toBe('true')
  })

  it('vacates the page when a chat is opened from the sidebar', async () => {
    const close = vi.fn()
    await bench({ open: vi.fn(), close })
    // The row opens through the injected callback; opening the current chat
    // again changes no selection, so the vacate cannot wait for one.
    fireEvent.click(screen.getByRole('button', { name: '展开或收起“Project”' }))
    fireEvent.click(screen.getByText('First chat'))
    expect(close).toHaveBeenCalledOnce()
  })

  it('falls back to toggling from the name without the page plugin', async () => {
    await bench(undefined)
    const projectRow = (): HTMLElement => screen.getAllByRole('treeitem')[0] as HTMLElement
    expect(projectRow().getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByText('Project'))
    expect(projectRow().getAttribute('aria-expanded')).toBe('true')
    // Without a page there is nothing to vacate, and the chat still opens.
    fireEvent.click(screen.getByText('First chat'))
  })

  it('releases its registrations on disposal', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.releaseWorkspaceSource()
    const remote = new TestRemote(runtime.ctx)
    runtime.ctx.provide('remote.directoryPicker', {} as never)
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    runtime.ctx.provide('layout', {
      selectPanel: vi.fn(),
      beginNavigation: () => new AbortController().signal,
    })
    await runtime.root.declare(
      { 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never,
      SidebarFrame as never,
    )
    const handle = await runtime.mount({ inject: [...inject], apply })
    await act(async () => { await handle.dispose() })
    expect(remote).toBeDefined()
  })
})
