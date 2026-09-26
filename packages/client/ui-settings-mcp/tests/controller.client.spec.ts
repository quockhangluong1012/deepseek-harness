/**
 * The MCP page controller: draft parsing, the reads it makes, and what it
 * publishes for each Host answer. A scripted `remote.mcpServers` face stands in
 * for the Host, so a refusal is exercised without an interactive answerer.
 */
import { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  McpMutationOutcome, McpServerRemove, McpServerUpsert, McpServersView,
} from '@deepseek-ai/dsh-mcp-project-config/types'
import { describe, expect, it, type Mock, vi } from 'vitest'
import { McpSettingsController, draftDeclaration, type McpServerDraft } from '../src/client/mcp-settings-controller.ts'

/** Session id the page addresses its approval asks to. */
const SESSION = 'session-1' as SessionId

/** An empty merged view over two paths. */
const EMPTY_VIEW: McpServersView = { servers: [], projectPath: 'p/.mcp.json', userPath: 'u/mcp.json' }

/** A view holding one connected stdio server whose env names a secret. */
const ONE_VIEW: McpServersView = {
  ...EMPTY_VIEW,
  servers: [{
    name: 'github',
    layer: 'project',
    trust: 'untrusted',
    endpoint: { transport: 'stdio', command: 'npx', args: ['-y', 'server'], envKeys: ['API_TOKEN'] },
    serverName: 'github',
    state: { kind: 'mounted', status: 'connected', attempt: 0, maxAttempts: 10 },
  }],
}

/** A draft for one stdio server. */
function draft(overrides: Partial<McpServerDraft> = {}): McpServerDraft {
  return {
    name: 'github',
    layer: 'project',
    transport: 'stdio',
    command: 'npx',
    args: '-y\nserver',
    env: 'API_TOKEN=written-secret',
    url: '',
    headers: '',
    trust: 'untrusted',
    existing: false,
    ...overrides,
  }
}

/** One scripted mutation answer, as the spy that records the request it saw. */
type MutationSpy<Request> = Mock<(request: Request) => Promise<RemoteResult<McpMutationOutcome>>>

/** The scripted `mcpServers` face the controller reads and writes through. */
interface ScriptedFace {
  list: () => Promise<RemoteResult<McpServersView>>
  upsert: (request: McpServerUpsert) => Promise<RemoteResult<McpMutationOutcome>>
  remove: (request: McpServerRemove) => Promise<RemoteResult<McpMutationOutcome>>
}

/** Mount one controller over a scripted Remote face. */
function bench(face: ScriptedFace, session: () => SessionId | undefined = () => SESSION): {
  controller: McpSettingsController
  upsert: MutationSpy<McpServerUpsert>
  remove: MutationSpy<McpServerRemove>
} {
  const ctx = new Context()
  const upsert = vi.fn(face.upsert)
  const remove = vi.fn(face.remove)
  new TestRemote(ctx, { mcpServers: { list: vi.fn(face.list), upsert, remove } })
  return { controller: new McpSettingsController(ctx, session), upsert, remove }
}

/** One granted Host answer. */
function granted(view: McpServersView): Promise<RemoteResult<McpMutationOutcome>> {
  return Promise.resolve({ ok: true, value: { ok: true, refusal: null, detail: null, view } })
}

describe('draftDeclaration', () => {
  it('reads a stdio draft into the declaration the Host writes', () => {
    expect(draftDeclaration(draft())).toEqual({
      upsert: {
        name: 'github',
        layer: 'project',
        trust: 'untrusted',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'server'],
        env: { API_TOKEN: 'written-secret' },
      },
    })
  })

  it('reads an http draft and validates the URL scheme', () => {
    expect(draftDeclaration(draft({ transport: 'http', url: 'ftp://example.com', headers: '' }))).toEqual({ problem: 'url' })
    expect(draftDeclaration(draft({ transport: 'http', url: 'https://example.com/mcp', headers: 'Authorization: Bearer x' }))).toEqual({
      upsert: {
        name: 'github',
        layer: 'project',
        trust: 'untrusted',
        transport: 'http',
        url: 'https://example.com/mcp',
        headers: { Authorization: 'Bearer x' },
      },
    })
  })

  it('names the first field that cannot be read', () => {
    expect(draftDeclaration(draft({ name: '  ' }))).toEqual({ problem: 'name' })
    expect(draftDeclaration(draft({ command: '' }))).toEqual({ problem: 'command' })
    expect(draftDeclaration(draft({ env: 'NOT_A_PAIR' }))).toEqual({ problem: 'env' })
    expect(draftDeclaration(draft({ transport: 'http', url: 'https://x/mcp', headers: 'no-colon' }))).toEqual({ problem: 'headers' })
  })
})

describe('McpSettingsController', () => {
  it('publishes the merged view when the Host answers', async () => {
    const { controller } = bench({
      list: () => Promise.resolve({ ok: true, value: ONE_VIEW }),
      upsert: () => granted(ONE_VIEW),
      remove: () => granted(ONE_VIEW),
    })
    await controller.load()
    const state = controller.inject(key => key).hooks.mcpSettings.getSnapshot()

    expect(state.status).toBe('ready')
    expect(state.view?.servers[0]?.state).toEqual({ kind: 'mounted', status: 'connected', attempt: 0, maxAttempts: 10 })
    // The env name reaches the page; the stored value never does.
    expect(JSON.stringify(state)).toContain('API_TOKEN')
    expect(JSON.stringify(state)).not.toContain('written-secret')
  })

  it('reports a Host that cannot answer the read', async () => {
    const { controller } = bench({
      list: () => Promise.resolve({ ok: false, error: new RemoteError('gateway/internal', 'no host', {}) }),
      upsert: () => granted(EMPTY_VIEW),
      remove: () => granted(EMPTY_VIEW),
    })
    await controller.load()
    expect(controller.inject(key => key).hooks.mcpSettings.getSnapshot()).toMatchObject({ status: 'failed', notice: { kind: 'transport' } })
  })

  it('sends a reach-extending write with the viewed session and publishes the fresh view', async () => {
    const { controller, upsert } = bench({
      list: () => Promise.resolve({ ok: true, value: EMPTY_VIEW }),
      upsert: () => granted(ONE_VIEW),
      remove: () => granted(ONE_VIEW),
    })
    await controller.load()
    await controller.save(draft())

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ name: 'github', sessionId: SESSION }))
    const state = controller.inject(key => key).hooks.mcpSettings.getSnapshot()
    expect(state.view?.servers).toHaveLength(1)
    expect(state.notice).toBeNull()
    expect(state.busy).toBe(false)
  })

  it('asks the Host to keep stored secrets when the draft edits an existing server', async () => {
    const { controller, upsert } = bench({
      list: () => Promise.resolve({ ok: true, value: ONE_VIEW }),
      upsert: () => granted(ONE_VIEW),
      remove: () => granted(ONE_VIEW),
    })
    await controller.load()
    await controller.save(draft({ existing: true, env: '' }))

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ keepStoredSecrets: true }))
  })

  it('refuses a write when the client shows no session to ask on', async () => {
    const { controller, upsert } = bench({
      list: () => Promise.resolve({ ok: true, value: EMPTY_VIEW }),
      upsert: () => granted(EMPTY_VIEW),
      remove: () => granted(EMPTY_VIEW),
    }, () => undefined)
    await controller.load()
    await controller.save(draft())

    expect(upsert).not.toHaveBeenCalled()
    expect(controller.inject(key => key).hooks.mcpSettings.getSnapshot().notice)
      .toEqual({ kind: 'refused', refusal: 'approval-required', detail: null })
  })

  it('refuses a removal when the client shows no session to ask on', async () => {
    const { controller, remove } = bench({
      list: () => Promise.resolve({ ok: true, value: ONE_VIEW }),
      upsert: () => granted(ONE_VIEW),
      remove: () => granted(ONE_VIEW),
    }, () => undefined)
    await controller.load()
    await controller.remove('github', 'project')

    expect(remove).not.toHaveBeenCalled()
    expect(controller.inject(key => key).hooks.mcpSettings.getSnapshot().notice)
      .toEqual({ kind: 'refused', refusal: 'approval-required', detail: null })
  })

  it('publishes a withheld approval without dropping the view', async () => {
    const { controller } = bench({
      list: () => Promise.resolve({ ok: true, value: ONE_VIEW }),
      upsert: () => Promise.resolve({
        ok: true,
        value: { ok: false, refusal: 'approval-refused', detail: 'the approval ask resolved "rejected"', view: ONE_VIEW },
      }),
      remove: () => granted(ONE_VIEW),
    })
    await controller.load()
    await controller.save(draft())

    const state = controller.inject(key => key).hooks.mcpSettings.getSnapshot()
    expect(state.notice).toEqual({ kind: 'refused', refusal: 'approval-refused', detail: 'the approval ask resolved "rejected"' })
    expect(state.view?.servers).toHaveLength(1)
  })

  it('reports a draft problem without calling the Host', async () => {
    const { controller, upsert } = bench({
      list: () => Promise.resolve({ ok: true, value: EMPTY_VIEW }),
      upsert: () => granted(EMPTY_VIEW),
      remove: () => granted(EMPTY_VIEW),
    })
    await controller.save(draft({ name: '' }))

    expect(upsert).not.toHaveBeenCalled()
    expect(controller.inject(key => key).hooks.mcpSettings.getSnapshot().notice).toEqual({ kind: 'draft', problem: 'name' })
  })

  it('deletes through the Host and clears the message area on dismiss', async () => {
    const { controller, remove } = bench({
      list: () => Promise.resolve({ ok: true, value: ONE_VIEW }),
      upsert: () => granted(ONE_VIEW),
      remove: () => Promise.resolve({
        ok: true,
        value: { ok: false, refusal: 'unknown-server', detail: null, view: ONE_VIEW },
      }),
    })
    await controller.load()
    await controller.remove('github', 'project')

    expect(remove).toHaveBeenCalledWith({ name: 'github', layer: 'project', sessionId: SESSION })
    const face = controller.inject(key => key)
    expect(face.hooks.mcpSettings.getSnapshot().notice).toEqual({ kind: 'refused', refusal: 'unknown-server', detail: null })
    face.dismiss()
    expect(face.hooks.mcpSettings.getSnapshot().notice).toBeNull()
  })
})
