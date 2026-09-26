// @vitest-environment jsdom
/**
 * The MCP section's rendering: every documented connection state, the declared
 * trust label, the add/edit/remove flows, and the one thing the page must never
 * show — a stored environment or header value.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { McpServerView, McpServersView } from '@deepseek-ai/dsh-mcp-project-config/types'
import { McpServersSection } from '../src/client/McpServersSection.tsx'
import { en } from '../src/client/locales.ts'
import type { McpSettingsFace, McpSettingsState } from '../src/client/mcp-settings-controller.ts'

afterEach(cleanup)

/** One server view, with the fields a test cares about spelled out. */
function server(overrides: Partial<McpServerView> & Pick<McpServerView, 'name'>): McpServerView {
  return {
    layer: 'project',
    trust: 'untrusted',
    endpoint: { transport: 'stdio', command: 'npx', args: ['-y', 'server'], envKeys: [] },
    serverName: overrides.name,
    state: { kind: 'mounted', status: 'connected', attempt: 0, maxAttempts: 10 },
    ...overrides,
  }
}

/** The list row of one server, keyed by the name the section renders on it. */
function rowOf(name: string): HTMLElement {
  const row = screen.getAllByRole('listitem').find(item => item.dataset.server === name)
  if (row === undefined) throw new Error(`fixture: no row rendered for ${name}`)
  return row
}

/** A ready page state over the given servers. */
function state(servers: readonly McpServerView[]): McpSettingsState {
  const view: McpServersView = { servers, projectPath: 'p/.mcp.json', userPath: 'u/mcp.json' }
  return { status: 'ready', view, busy: false, notice: null }
}

/** Render the section with a store holding `initial` and stubbed actions. */
function renderSection(initial: McpSettingsState) {
  const save = vi.fn()
  const remove = vi.fn()
  const dismiss = vi.fn()
  const refresh = vi.fn()
  const props: Partial<InjectFace<McpSettingsFace>> = {
    useMcpSettings: bindSnapshotSelector(createSnapshotStore(initial)),
    save,
    remove,
    dismiss,
    refresh,
    t: key => en[key],
  }
  render(<McpServersSection {...props} />)
  return { save, remove, dismiss }
}

describe('McpServersSection', () => {
  it('renders every documented connection state', () => {
    renderSection(state([
      server({ name: 'up' }),
      server({ name: 'starting', state: { kind: 'mounted', status: 'connecting', attempt: 0, maxAttempts: 10 } }),
      server({ name: 'flaky', state: { kind: 'mounted', status: 'reconnecting', attempt: 3, maxAttempts: 10 } }),
      server({ name: 'down', state: { kind: 'mounted', status: 'disconnected', attempt: 11, maxAttempts: 10 } }),
      server({ name: 'rejected', endpoint: null, serverName: null, state: { kind: 'not-mounted', reason: 'unsupported type' } }),
    ]))

    expect(screen.getByText(en.statusConnected)).toBeDefined()
    expect(screen.getByText(en.statusConnecting)).toBeDefined()
    expect(screen.getByText(en.statusReconnecting)).toBeDefined()
    expect(screen.getByText(en.statusDisconnected)).toBeDefined()
    expect(screen.getByText(en.statusNotMounted)).toBeDefined()
    // The retry counter belongs to the outage, not to the label.
    expect(screen.getByText(`${en.attempt} 3/10`)).toBeDefined()
    expect(screen.getByText('unsupported type')).toBeDefined()
  })

  it('renders the declared trust label and the layer of each server', () => {
    renderSection(state([
      server({ name: 'owned', trust: 'trusted' }),
      server({ name: 'foreign', trust: 'untrusted', layer: 'user' }),
      server({ name: 'unclear', trust: 'unknown' }),
    ]))

    // Two servers declare the project layer, so each row is read on its own.
    expect(within(rowOf('owned')).getByText(en.trustTrusted)).toBeDefined()
    expect(within(rowOf('foreign')).getByText(en.trustUntrusted)).toBeDefined()
    expect(within(rowOf('unclear')).getByText(en.trustUnknown)).toBeDefined()
    expect(within(rowOf('owned')).getByText(en.layerProject)).toBeDefined()
    expect(within(rowOf('unclear')).getByText(en.layerProject)).toBeDefined()
    expect(within(rowOf('foreign')).getByText(en.layerUser)).toBeDefined()
  })

  it('names the credential a server sets and never its value', () => {
    renderSection(state([
      server({ name: 'github', endpoint: { transport: 'stdio', command: 'npx', args: [], envKeys: ['API_TOKEN'] } }),
    ]))

    expect(screen.getByText('API_TOKEN')).toBeDefined()
    expect(screen.getByText(en.secretsNote)).toBeDefined()
    // A stored value would reach the row as `NAME=value` beside its name; the
    // Host's view carries the names alone.
    expect(rowOf('github').textContent).not.toContain('API_TOKEN=')
  })

  it('adds a server through the editor', () => {
    const { save } = renderSection(state([]))

    expect(screen.getByText(en.empty)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.add }))
    // The name control's label also holds its hint, so the accessible name
    // begins with the label text rather than equalling it.
    fireEvent.change(screen.getByRole('textbox', { name: new RegExp(`^${en.name}`, 'u') }), { target: { value: 'github' } })
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'github', layer: 'project', transport: 'stdio', existing: false }))
  })

  it('edits an existing server with its endpoint and without its stored values', () => {
    const { save } = renderSection(state([
      server({ name: 'github', endpoint: { transport: 'stdio', command: 'npx', args: ['-y', 'server'], envKeys: ['API_TOKEN'] } }),
    ]))

    fireEvent.click(screen.getByRole('button', { name: en.edit }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ name: 'github', command: 'npx', args: '-y\nserver', env: '', existing: true }))
  })

  it('removes a server only after its confirmation', () => {
    const { remove } = renderSection(state([server({ name: 'github', layer: 'user' })]))

    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    expect(remove).not.toHaveBeenCalled()
    expect(screen.getByText(en.confirmRemove)).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: en.keep }))
    expect(remove).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    fireEvent.click(screen.getByRole('button', { name: en.remove }))
    expect(remove).toHaveBeenCalledWith('github', 'user')
  })

  it('renders a withheld approval as localized copy and dismisses it', () => {
    const { dismiss } = renderSection({
      status: 'ready',
      view: { servers: [server({ name: 'github' })], projectPath: 'p', userPath: 'u' },
      busy: false,
      notice: { kind: 'refused', refusal: 'approval-refused', detail: 'the approval ask resolved "rejected"' },
    })

    expect(screen.getByText(en.refusalApprovalRefused)).toBeDefined()
    expect(screen.getByText(`${en.detail}: the approval ask resolved "rejected"`)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: en.keep }))
    expect(dismiss).toHaveBeenCalled()
  })

  it('renders nothing before the inject face is bound', () => {
    const { container } = render(<McpServersSection />)
    expect(container.textContent).toBe('')
  })
})
