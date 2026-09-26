// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { RemoteStreamOptions } from '@deepseek-ai/dsh-api-gateway/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { WorkspaceMemoryValue } from '../src/types.ts'
import type { PageRemote } from '../src/client/rpc.ts'
import type { WorkspaceMemoryFollowFrame } from '../src/types.ts'
import { outputBasename, outputDirectory, relativeLabel, WorkspaceMemoryPage } from '../src/client/Page.tsx'
import type { WorkspaceMemoryPageProps } from '../src/client/Page.tsx'

afterEach(cleanup)

const t = ((key: string) => key) as never

function valueOf(overrides: Partial<WorkspaceMemoryValue> = {}): WorkspaceMemoryValue {
  return {
    workspaceId: 'ws-1' as WorkspaceId,
    description: 'blurb',
    instructions: 'rules',
    memory: 'doc',
    memoryUpdatedAt: null,
    contextItems: [],
    outputs: [],
    lastExtraction: null,
    usage: { usedBytes: 12, capacityBytes: 100 },
    updatedAt: new Date().toISOString(),
    ...overrides,
  }
}

/** Driver that advances the generation per frame so later snapshots replace. */
function bumpingStream(open: (signal: AbortSignal) => AsyncIterable<WorkspaceMemoryFollowFrame>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      const controller = new AbortController()
      try {
        let generation = 0
        for await (const value of open(controller.signal)) {
          yield { generation, value, signal: controller.signal, accept: () => {} }
          generation += 1
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

/** Minimal single-generation driver: opens, yields frames, ends. */
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

function remoteOf(overrides: Partial<PageRemote> = {}): PageRemote {
  return {
    read: vi.fn(async () => valueOf()),
    setDescription: vi.fn(async () => valueOf()),
    setInstructions: vi.fn(async () => valueOf()),
    setMemory: vi.fn(async () => valueOf()),
    addTextItem: vi.fn(async () => valueOf()),
    addFileItem: vi.fn(async () => valueOf()),
    removeContextItem: vi.fn(async () => valueOf()),
    listContextFiles: vi.fn(async () => []),
    follow: () => (async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {})(),
    openStream: (options: RemoteStreamOptions<WorkspaceMemoryFollowFrame>) => drivingStream(options.open),
    ...overrides,
  }
}

function propsOf(overrides: Partial<WorkspaceMemoryPageProps> = {}): WorkspaceMemoryPageProps {
  return {
    openWorkspaceId: 'ws-1',
    workspace: { workspaceId: 'ws-1', title: 'Project', path: '/work/project' },
    sessions: [],
    activity: [],
    remote: remoteOf(),
    onOpenSession: vi.fn(),
    t,
    ...overrides,
  }
}

describe('workspace-memory page', () => {
  it('renders nothing closed or orphaned', () => {
    const { container } = render(<WorkspaceMemoryPage {...propsOf({ openWorkspaceId: null })} />)
    expect(container.firstChild).toBeNull()
    const orphaned = render(<WorkspaceMemoryPage {...propsOf({ workspace: null })} />)
    expect(orphaned.container.firstChild).toBeNull()
  })

  it('renders three cards open with identity row, outputs, and tabs', async () => {
    const read = vi.fn(async () => valueOf())
    const remote = remoteOf({ read })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()
    expect(screen.getByText('Project')).toBeDefined()
    expect(screen.getByText('/work/project')).toBeDefined()
    expect(screen.getByText('card.instructions')).toBeDefined()
    expect(screen.getByText('card.memory')).toBeDefined()
    expect(screen.getByText('card.context')).toBeDefined()
    expect(screen.getByText('outputs.empty')).toBeDefined()
    expect(screen.getByText('chats.empty')).toBeDefined()
    expect(read).toHaveBeenCalled()
  })

  it('labels empty instruction and memory documents instead of rendering blank boxes', async () => {
    const remote = remoteOf({ read: vi.fn(async () => valueOf({ instructions: '', memory: '' })) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    expect(screen.getByText('instructions.empty')).toBeDefined()
    expect(screen.getByText('memory.empty')).toBeDefined()
  })

  it('previews loaded instruction and memory documents', async () => {
    const remote = remoteOf({ read: vi.fn(async () => valueOf()) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    expect(screen.getByText('rules')).toBeDefined()
    expect(screen.queryByText('instructions.empty')).toBeNull()
    expect(screen.queryByText('memory.empty')).toBeNull()
  })

  it('sizes the text dialogs for long documents', async () => {
    const remote = remoteOf({ read: vi.fn(async () => valueOf()) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getAllByText('card.edit')[0]!)
    // The wide card class sits on the dialog, the scroll class on its content
    // region, and the editor fills the scroll region rather than growing past
    // the viewport with a drag handle.
    const dialog = screen.getByRole('dialog', { name: 'card.instructions' })
    expect(dialog.className).toContain('textDialog')
    expect(dialog.firstElementChild?.className).toContain('textDialogContent')
    const editor = within(dialog).getByLabelText<HTMLTextAreaElement>('card.instructions')
    expect(editor.className).toContain('dialogEditor')
    expect(editor.className).toContain('editor')
  })

  it('shows loading and read failures', async () => {
    let resolveRead!: (value: WorkspaceMemoryValue) => void
    const remote = remoteOf({
      read: vi.fn(() => new Promise<WorkspaceMemoryValue>((resolve) => {
        resolveRead = resolve
      })),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByText('page.loading')).toBeDefined()
    act(() => {
      resolveRead(valueOf())
    })
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()

    const failing = remoteOf({ read: vi.fn(async () => { throw new Error('load down') }) })
    render(<WorkspaceMemoryPage {...propsOf({ remote: failing })} />)
    expect(await screen.findAllByText('load down')).toBeDefined()
  })

  it('applies follow baselines and upserts for the open workspace', async () => {
    const baseline = valueOf({ memory: 'live-one' })
    const foreign = valueOf({ workspaceId: 'ws-9' as WorkspaceId, memory: 'foreign' })
    const upsert = valueOf({ memory: 'live-two' })
    const remote = remoteOf({
      read: vi.fn(async () => valueOf({ memory: 'initial' })),
      follow: () => (async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {
        yield { type: 'baseline', values: [baseline] }
        yield { type: 'upsert', value: foreign }
        yield { type: 'upsert', value: upsert }
      })(),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByText('live-two')).toBeDefined()
    expect(screen.queryByText('foreign')).toBeNull()
  })

  it('shows follow failures and double snapshots as errors', async () => {
    const remote = remoteOf({
      follow: () => (async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {
        yield { type: 'baseline', values: [] }
        yield { type: 'baseline', values: [] }
      })(),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('more than one opening snapshot')
  })

  it('ignores late responses after unmount', async () => {
    let resolveRead!: (value: WorkspaceMemoryValue) => void
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const remote = remoteOf({
      read: vi.fn(() => new Promise<WorkspaceMemoryValue>((resolve) => {
        resolveRead = resolve
      })),
      follow: () => (async function* (): AsyncIterable<WorkspaceMemoryFollowFrame> {
        yield { type: 'baseline', values: [] }
        await gate
        yield { type: 'baseline', values: [] }
        yield { type: 'upsert', value: valueOf({ memory: 'late' }) }
        throw new Error('late failure')
      })(),
      openStream: (options: RemoteStreamOptions<WorkspaceMemoryFollowFrame>) => bumpingStream(options.open),
    })
    const view = render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByText('page.loading')).toBeDefined()
    view.unmount()
    act(() => {
      resolveRead(valueOf())
    })
    release()
    await act(async () => {})
    expect(screen.queryByTestId('workspace-memory-page')).toBeNull()

    // A read rejection after unmount is dropped the same way.
    cleanup()
    let rejectLate!: (reason: unknown) => void
    const rejecting = remoteOf({
      read: vi.fn(() => new Promise<WorkspaceMemoryValue>((_, reject) => {
        rejectLate = reject
      })),
    })
    const second = render(<WorkspaceMemoryPage {...propsOf({ remote: rejecting })} />)
    expect(await screen.findByText('page.loading')).toBeDefined()
    second.unmount()
    act(() => {
      rejectLate(new Error('late load'))
    })
    await act(async () => {})
  })

  it('a too-large failure renders card copy', async () => {
    const current = valueOf()
    const failure = Object.assign(new Error('too large'), {
      code: 'workspace-memory/too-large',
      details: { field: 'instructions', bytes: 10, maxBytes: 5 },
    })
    const remote = remoteOf({
      read: vi.fn(async () => current),
      setInstructions: vi.fn(async () => { throw failure }),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getAllByText('card.edit')[0]!)
    const dialog = screen.getByRole('dialog', { name: 'card.instructions' })
    fireEvent.change(within(dialog).getByLabelText('card.instructions'), { target: { value: 'new' } })
    fireEvent.click(within(dialog).getByText('card.save'))
    expect(await screen.findByText('error.tooLarge')).toBeDefined()
  })

  it('renders update time and which extraction wrote the document', async () => {
    const remote = remoteOf({
      read: vi.fn(async () => valueOf({
        memoryUpdatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        lastExtraction: {
          at: new Date().toISOString(),
          sessionId: 's1',
          provider: 'p',
          model: 'm',
          inputBytes: 3,
          truncated: false,
        },
      })),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByText('time.ago')).toBeDefined()
    expect(await screen.findByText('memory.model')).toBeDefined()
  })

  it('drafts edits from empty while the record loads', async () => {
    const remote = remoteOf({ read: vi.fn(() => new Promise<WorkspaceMemoryValue>(() => {})) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByText('page.loading')).toBeDefined()
    fireEvent.click(screen.getAllByText('card.edit')[0]!)
    const instrDialog = screen.getByRole('dialog', { name: 'card.instructions' })
    expect(within(instrDialog).getByLabelText<HTMLTextAreaElement>('card.instructions').value).toBe('')
    fireEvent.click(within(instrDialog).getByLabelText('page.close'))
    fireEvent.click(screen.getAllByText('card.edit')[1]!)
    const memDialog = screen.getByRole('dialog', { name: 'card.memory' })
    expect(within(memDialog).getByLabelText<HTMLTextAreaElement>('card.edit').value).toBe('')
  })

  it('a detail-less too-large failure renders zeroed card copy', async () => {
    const failure = Object.assign(new Error('too large'), { code: 'workspace-memory/too-large' })
    const remote = remoteOf({
      read: vi.fn(async () => valueOf()),
      setInstructions: vi.fn(async () => { throw failure }),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getAllByText('card.edit')[0]!)
    const dialog = screen.getByRole('dialog', { name: 'card.instructions' })
    fireEvent.change(within(dialog).getByLabelText('card.instructions'), { target: { value: 'new' } })
    fireEvent.click(within(dialog).getByText('card.save'))
    expect(await screen.findByText('error.tooLarge')).toBeDefined()
  })

  it('saves instructions and closes the modal', async () => {
    const setInstructions = vi.fn(async () => valueOf({ instructions: 'saved rules' }))
    const remote = remoteOf({ setInstructions })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getAllByText('card.edit')[0]!)
    const dialog = screen.getByRole('dialog', { name: 'card.instructions' })
    fireEvent.change(within(dialog).getByLabelText('card.instructions'), { target: { value: 'saved rules' } })
    fireEvent.click(within(dialog).getByText('card.save'))
    expect(await screen.findByText('saved rules')).toBeDefined()
    expect(setInstructions).toHaveBeenCalled()
  })

  it('shows generic instruction failures and cancels edits', async () => {
    const remote = remoteOf({ setInstructions: vi.fn(async () => { throw new Error('store down') }) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getAllByText('card.edit')[0]!)
    fireEvent.click(screen.getByText('card.cancel'))
    fireEvent.click(screen.getAllByText('card.edit')[0]!)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'card.instructions' })).getByLabelText('page.close'))
    fireEvent.click(screen.getAllByText('card.edit')[0]!)
    const dialog = screen.getByRole('dialog', { name: 'card.instructions' })
    fireEvent.change(within(dialog).getByLabelText('card.instructions'), { target: { value: 'x' } })
    fireEvent.click(within(dialog).getByText('card.save'))
    expect(await screen.findByText('store down')).toBeDefined()
  })

  it('previews memory as markdown and edits it', async () => {
    const remote = remoteOf({ setMemory: vi.fn(async () => valueOf({ memory: 'edited doc' })) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getByText('card.preview'))
    expect((await screen.findAllByText('doc')).length).toBeGreaterThan(1)
    const preview = screen.getByRole('dialog', { name: 'card.memory' })
    fireEvent.click(within(preview).getByText('page.close'))
    fireEvent.click(screen.getByText('card.preview'))
    // Escape belongs to the open Modal: it dismisses the preview and leaves
    // the page itself standing.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'card.memory' })).toBeNull()
    expect(screen.getByTestId('workspace-memory-page')).toBeDefined()
    fireEvent.click(screen.getAllByText('card.edit')[1]!)
    const dialog = screen.getByRole('dialog', { name: 'card.memory' })
    fireEvent.change(within(dialog).getByLabelText('card.edit'), { target: { value: 'edited doc' } })
    fireEvent.click(within(dialog).getByText('card.save'))
    expect(await screen.findByText('edited doc')).toBeDefined()
  })

  it('shows memory failures and cancels the edit', async () => {
    const remote = remoteOf({ setMemory: vi.fn(async () => { throw new Error('memory down') }) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getAllByText('card.edit')[1]!)
    fireEvent.click(screen.getByText('card.cancel'))
    fireEvent.click(screen.getAllByText('card.edit')[1]!)
    fireEvent.click(within(screen.getByRole('dialog', { name: 'card.memory' })).getByLabelText('page.close'))
    fireEvent.click(screen.getAllByText('card.edit')[1]!)
    const dialog = screen.getByRole('dialog', { name: 'card.memory' })
    fireEvent.change(within(dialog).getByLabelText('card.edit'), { target: { value: 'x' } })
    fireEvent.click(within(dialog).getByText('card.save'))
    expect(await screen.findByText('memory down')).toBeDefined()
  })

  it('shows a non-Error memory failure verbatim', async () => {
    const remote = remoteOf({ setMemory: vi.fn(async () => { throw 'plain failure' }) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getAllByText('card.edit')[1]!)
    const dialog = screen.getByRole('dialog', { name: 'card.memory' })
    fireEvent.change(within(dialog).getByLabelText('card.edit'), { target: { value: 'x' } })
    fireEvent.click(within(dialog).getByText('card.save'))
    expect(await screen.findByText('plain failure')).toBeDefined()
  })

  it('edits the description through placeholder, blur, save, and escape', async () => {
    const setDescription = vi.fn(async () => valueOf({ description: 'new blurb' }))
    const remote = remoteOf({ setDescription })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    const region = screen.getByRole('region', { name: 'description.label' })
    // Stored description renders as a paragraph that opens the same editor.
    fireEvent.click(within(region).getByText('blurb'))
    const editor = within(region).getByLabelText('description.label')
    fireEvent.change(editor, { target: { value: 'typed blurb' } })
    fireEvent.blur(editor)
    expect(await within(region).findByText('new blurb')).toBeDefined()
    expect(setDescription).toHaveBeenCalledWith('ws-1', 'typed blurb')

    fireEvent.click(within(region).getByText('new blurb'))
    const second = within(region).getByLabelText('description.label')
    fireEvent.change(second, { target: { value: 'abandoned' } })
    fireEvent.keyDown(second, { key: 'Enter' })
    fireEvent.keyDown(second, { key: 'Escape' })
    fireEvent.click(within(region).getByText('new blurb'))
    const third = within(region).getByLabelText('description.label')
    fireEvent.change(third, { target: { value: 'kept' } })
    fireEvent.click(within(region).getByText('description.save'))
    expect(setDescription).toHaveBeenCalledWith('ws-1', 'kept')
  })

  it('opens the placeholder editor for an empty description', async () => {
    const setDescription = vi.fn(async () => valueOf({ description: '' }))
    const remote = remoteOf({
      read: vi.fn(async () => valueOf({ description: '' })),
      setDescription,
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    const region = screen.getByRole('region', { name: 'description.label' })
    fireEvent.click(within(region).getByText('description.placeholder'))
    fireEvent.click(within(region).getByText('description.cancel'))
    expect(setDescription).not.toHaveBeenCalled()
  })

  it('shows description failures', async () => {
    const remote = remoteOf({ setDescription: vi.fn(async () => { throw new Error('desc down') }) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    const region = screen.getByRole('region', { name: 'description.label' })
    fireEvent.click(within(region).getByText('blurb'))
    fireEvent.change(within(region).getByLabelText('description.label'), { target: { value: 'x' } })
    fireEvent.click(within(region).getByText('description.save'))
    expect(await screen.findByText('desc down')).toBeDefined()
  })

  it('opens sessions from outputs, chats, and activity rows', async () => {
    const onOpenSession = vi.fn()
    const remote = remoteOf({
      read: vi.fn(async () => valueOf({
        outputs: [
          { path: '/work/project/out.ts', tool: 'write', sessionId: 's9', at: '2026-01-01T00:00:00.000Z' },
          { path: '/work/project/src/nested.ts', tool: 'edit', sessionId: 's9', at: '2026-01-01T00:00:00.000Z' },
        ],
      })),
    })
    const now = Date.now()
    render(<WorkspaceMemoryPage {...propsOf({
      remote,
      onOpenSession,
      sessions: [{ id: 's1', title: 'First', updatedAt: now }],
      activity: [{ sessionId: 's2', sessionTitle: 'Second', turn: 3, prompt: 'do it' }],
    })} />)
    await screen.findByTestId('workspace-memory-page')
    // A tile names its workspace-relative directory; a root file keeps the tool alone.
    expect(screen.getByText('src · edit')).toBeDefined()
    expect(screen.getByText('write')).toBeDefined()
    fireEvent.click(screen.getByTitle('/work/project/out.ts'))
    expect(onOpenSession).toHaveBeenCalledWith('s9')
    fireEvent.click(screen.getByText('First'))
    expect(onOpenSession).toHaveBeenCalledWith('s1')
    fireEvent.click(screen.getByText('activity.title'))
    fireEvent.click(screen.getByText('do it'))
    expect(onOpenSession).toHaveBeenCalledWith('s2')
    fireEvent.click(screen.getByText('chats.title'))
    expect(screen.getByText('First')).toBeDefined()
    // Output track controls scroll one container width per click.
    const track = screen.getByTestId('workspace-memory-track')
    Object.defineProperty(track, 'scrollWidth', { value: 300, configurable: true })
    Object.defineProperty(track, 'clientWidth', { value: 100, configurable: true })
    Object.defineProperty(track, 'scrollLeft', { value: 150, configurable: true, writable: true })
    fireEvent.scroll(track)
    const prev = screen.getByLabelText('outputs.previous') as HTMLButtonElement
    const next = screen.getByLabelText('outputs.next') as HTMLButtonElement
    expect(prev.disabled).toBe(false)
    expect(next.disabled).toBe(false)
    fireEvent.click(prev)
    fireEvent.click(next)
  })

  it('shows empty tabs and scrolls the output track', async () => {
    render(<WorkspaceMemoryPage {...propsOf({})} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getByText('activity.title'))
    expect(screen.getByText('activity.empty')).toBeDefined()
    const track = screen.getByTestId('workspace-memory-page')
    expect(track).toBeDefined()
    void track
  })

  it('fills its own surface and offers no dismissal of its own', async () => {
    render(<WorkspaceMemoryPage {...propsOf()} />)
    const page = await screen.findByTestId('workspace-memory-page')
    // A page, not a dialog: no mask, no dialog role, and a click that lands on
    // the surface itself never dismisses it.
    expect(screen.queryByTestId('workspace-memory-mask')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('region', { name: 'page.title' })).toBe(page)
    // The identity row opens on the Workspace's own name and path: no control
    // before the heading, so the page carries no dismissal of its own and
    // leaves through the surfaces that own the selection instead.
    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.textContent).toBe('Project')
    expect(heading.previousElementSibling).toBeNull()
    expect(heading.nextElementSibling?.textContent).toBe('/work/project')
    fireEvent.click(page)
    expect(screen.getByTestId('workspace-memory-page')).toBe(page)
  })

  it('manages context items end to end', async () => {
    const current = valueOf({
      contextItems: [{ kind: 'text', id: 'c1', label: 'note', text: 'hi', sizeBytes: 2, addedAt: '2026-01-01T00:00:00.000Z' }],
    })
    const removeContextItem = vi.fn(async () => valueOf({ contextItems: [] }))
    const addTextItem = vi.fn(async () => current)
    const remote = remoteOf({
      read: vi.fn(async () => current),
      removeContextItem,
      addTextItem,
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getByLabelText('card.remove note'))
    expect(await screen.findByText('context.empty')).toBeDefined()
    expect(removeContextItem).toHaveBeenCalled()

    fireEvent.click(screen.getByText('card.addText'))
    fireEvent.change(screen.getByLabelText('context.labelLabel'), { target: { value: 'lbl' } })
    fireEvent.change(screen.getByLabelText('context.textLabel'), { target: { value: '   ' } })
    fireEvent.click(screen.getByText('card.save'))
    expect(addTextItem).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('context.textLabel'), { target: { value: 'words' } })
    fireEvent.click(screen.getByText('card.save'))
    expect(await screen.findByText('note')).toBeDefined()
    expect(addTextItem).toHaveBeenCalledWith('ws-1', 'lbl', 'words')
    // An untouched label falls back to the default text label.
    fireEvent.click(screen.getByText('card.addText'))
    fireEvent.change(screen.getByLabelText('context.textLabel'), { target: { value: 'more' } })
    fireEvent.click(screen.getByText('card.save'))
    expect(addTextItem).toHaveBeenCalledWith('ws-1', 'context.textLabel', 'more')
  })

  it('shows add-text, add-file, and text-cancel outcomes', async () => {
    const addTextItem = vi.fn(async () => { throw new Error('add down') })
    const remote = remoteOf({
      addTextItem,
      addFileItem: vi.fn(async () => { throw new Error('file down') }),
      listContextFiles: vi.fn(async () => ['f.md']),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getByText('card.addText'))
    fireEvent.change(screen.getByLabelText('context.textLabel'), { target: { value: 'words' } })
    fireEvent.click(screen.getByText('card.save'))
    expect(await screen.findByText('add down')).toBeDefined()
    fireEvent.click(screen.getByText('card.cancel'))

    const region = screen.getByRole('region', { name: 'card.context' })
    fireEvent.click(within(region).getByText('card.addFile'))
    fireEvent.click(within(region).getByText('card.cancel'))
    fireEvent.click(within(region).getByText('card.addFile'))
    fireEvent.change(within(region).getByLabelText('context.queryPlaceholder'), { target: { value: 'f' } })
    fireEvent.click(await within(region).findByText('f.md'))
    expect(await screen.findByText('file down')).toBeDefined()
    expect(addTextItem).toHaveBeenCalled()
  })

  it('aborts superseded file searches', async () => {
    const deferreds: { resolve(paths: readonly string[]): void; reject(reason: unknown): void }[] = []
    const remote = remoteOf({
      listContextFiles: vi.fn(() => new Promise<readonly string[]>((resolve, reject) => {
        deferreds.push({ resolve, reject })
      })),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()
    fireEvent.click(screen.getByText('card.addFile'))
    const query = screen.getByLabelText('context.queryPlaceholder')
    // A fulfilled superseded search never touches state.
    fireEvent.change(query, { target: { value: 'a' } })
    await new Promise(resolve => setTimeout(resolve, 350))
    fireEvent.change(query, { target: { value: 'ab' } })
    act(() => {
      deferreds[0]?.resolve(['a.md'])
    })
    await new Promise(resolve => setTimeout(resolve, 350))
    // A rejected superseded search stays silent as well.
    fireEvent.change(query, { target: { value: 'abc' } })
    await new Promise(resolve => setTimeout(resolve, 350))
    act(() => {
      deferreds[1]?.reject(new Error('search down'))
    })
    act(() => {
      deferreds[2]?.resolve(['b.md'])
    })
    expect(await screen.findByText('b.md')).toBeDefined()
    expect(screen.queryByText('a.md')).toBeNull()
    expect(screen.queryByText('search down')).toBeNull()
  })

  it('shows remove failures', async () => {
    const current = valueOf({
      contextItems: [{ kind: 'text', id: 'c1', label: 'note', text: 'hi', sizeBytes: 2, addedAt: '2026-01-01T00:00:00.000Z' }],
    })
    const remote = remoteOf({
      read: vi.fn(async () => current),
      removeContextItem: vi.fn(async () => { throw new Error('remove down') }),
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    await screen.findByTestId('workspace-memory-page')
    fireEvent.click(screen.getByLabelText('card.remove note'))
    expect(await screen.findByText('remove down')).toBeDefined()
  })

  it('adds workspace files through the debounced picker', async () => {
    const listContextFiles = vi.fn(async () => ['notes.md'])
    const addFileItem = vi.fn(async () => valueOf())
    const remote = remoteOf({
      listContextFiles,
      addFileItem,
    })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()
    fireEvent.click(screen.getByText('card.addFile'))
    const query = screen.getByLabelText('context.queryPlaceholder')
    fireEvent.change(query, { target: { value: 'n' } })
    fireEvent.change(query, { target: { value: 'no' } })
    expect(await screen.findByText('notes.md')).toBeDefined()
    expect(listContextFiles).toHaveBeenCalledTimes(1)
    expect(listContextFiles).toHaveBeenCalledWith('ws-1', 'no', expect.anything())
    fireEvent.click(screen.getByText('notes.md'))
    expect(addFileItem).toHaveBeenCalled()
    expect(await screen.findByText('card.addFile')).toBeDefined()
  })

  it('shows picker failures and empty matches', async () => {
    const remote = remoteOf({ listContextFiles: vi.fn(async () => { throw new Error('list down') }) })
    render(<WorkspaceMemoryPage {...propsOf({ remote })} />)
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()
    fireEvent.click(screen.getByText('card.addFile'))
    fireEvent.change(screen.getByLabelText('context.queryPlaceholder'), { target: { value: 'x' } })
    expect(await screen.findByText('list down')).toBeDefined()
    fireEvent.click(screen.getByText('card.cancel'))

    cleanup()
    const empty = remoteOf({ listContextFiles: vi.fn(async () => []) })
    render(<WorkspaceMemoryPage {...propsOf({ remote: empty })} />)
    expect(await screen.findByTestId('workspace-memory-page')).toBeDefined()
    fireEvent.click(screen.getByText('card.addFile'))
    fireEvent.change(screen.getByLabelText('context.queryPlaceholder'), { target: { value: 'zzz' } })
    expect(await screen.findByText('context.noMatches')).toBeDefined()
  })

  it('formats output paths and relative times', () => {
    expect(outputBasename('/work/project/out.ts')).toBe('out.ts')
    expect(outputBasename('C:\\work\\out.ts')).toBe('out.ts')
    expect(outputDirectory('/work/project', '/work/project/out.ts')).toBe('')
    expect(outputDirectory('/work/project', '/work/project/sub/out.ts')).toBe('sub')
    expect(outputDirectory('/work/project', '/elsewhere/out.ts')).toBe('/elsewhere')
    expect(outputDirectory('/work/project/', '/work/project/sub/out.ts')).toBe('sub')
    expect(outputDirectory('C:\\work\\', 'C:\\work\\sub\\out.ts')).toBe('sub')
    expect(outputDirectory('C:/work/project', 'C:\\work\\project\\sub\\out.ts')).toBe('sub')
    expect(outputDirectory('/work/project', '/work/project')).toBe('')
    expect(relativeLabel(t, Date.now(), Date.now())).toBe('time.now')
    expect(relativeLabel(t, Date.now() - 5 * 60_000, Date.now())).toBe('time.ago')
  })
})
