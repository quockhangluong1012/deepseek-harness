import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceMemoryExtractor, { type Config as ExtractorConfig } from '../src/index.ts'

interface FakeWorkspace {
  id: WorkspaceId
  title: string
  path: string
  sessionIds: SessionId[]
}

interface Harness {
  ctx: Context
  fiber: { dispose(): Promise<void> }
  calls: GenerateOptions[]
  streamImpl: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  workspaces: Map<string, FakeWorkspace>
  archived: SessionId[]
  dir: string
}

async function harness(overrides: ExtractorConfig = {}): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'wme-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const { default: WorkspaceMemoryStore } = await import('@deepseek-ai/dsh-workspace-memory')
  await ctx.plugin(WorkspaceMemoryStore, { capacityBytes: 1 << 20 })
  await ctx.plugin(SessionStore)
  const calls: GenerateOptions[] = []
  const harnessRef: { streamImpl: (options: GenerateOptions) => AsyncIterable<StreamChunk> } = {
    streamImpl: () => (async function* () {})(),
  }
  ctx.provide('llm', {
    stream: (options: GenerateOptions) => {
      calls.push(options)
      return harnessRef.streamImpl(options)
    },
  } as never)
  const workspaces = new Map<string, FakeWorkspace>()
  const archived: SessionId[] = []
  ctx.provide('workspaceRegistry', {
    list: () => [...workspaces.values()],
    get: (id: WorkspaceId) => workspaces.get(String(id)),
    archivedSessionIds: archived,
  } as never)
  const fiber = await ctx.plugin(
    WorkspaceMemoryExtractor,
    // Object.assign: the Config interface shares its name with the zod
    // schema value, which trips no-misused-spread's class-instance check.
    Object.assign({ cooldownMs: 0, minTurnTextBytes: 0 }, overrides),
  )
  return {
    ctx,
    fiber,
    calls,
    get streamImpl() {
      return harnessRef.streamImpl
    },
    set streamImpl(impl: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
      harnessRef.streamImpl = impl
    },
    workspaces,
    archived,
    dir,
  }
}

function textChunks(text: string, finish: FinishReason = { kind: 'stop' }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: finish },
  ]
}

function immediate(text: string, finish: FinishReason = { kind: 'stop' }) {
  return async function* (): AsyncIterable<StreamChunk> {
    yield* textChunks(text, finish)
  }
}

function sessionIn(ctx: Context, dir: string, name: string): Session {
  return ctx.sessions.create(SessionId(name), { meta: { cwd: dir } })
}

function appendTurn(
  session: Session,
  turn: number,
  bodies: {
    user?: string
    injected?: string
    assistant?: string
    calls?: { name: string; args: string; ok?: boolean }[]
    extraCalls?: { name: string; args: string }[]
  },
): void {
  session.append('turn/start', { turn })
  if (bodies.user !== undefined) {
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: bodies.user }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
  }
  if (bodies.injected !== undefined) {
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text: bodies.injected }], source: { kind: 'workspace-memory-llm' } }),
      { surfaceOp: 'append' },
    )
  }
  if (bodies.assistant !== undefined) {
    session.append(
      'assistant/message',
      {
        turn,
        step: 1,
        message: createAssistantMessage({
          content: [{ type: 'text', text: bodies.assistant }],
          source: { provider: 'p', model: 'm' },
        }),
        stream: [],
      },
      { surfaceOp: 'append' },
    )
  }
  for (const [index, call] of (bodies.calls ?? []).entries()) {
    const callId = ToolCallId(`call-${turn}-${index}`)
    session.append('tool/call', { turn, step: 1, callId, name: call.name, arguments: call.args })
    session.append(
      'tool/result',
      {
        turn,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'done' }],
          isError: call.ok === false,
        }),
      },
      { surfaceOp: 'append' },
    )
  }
  for (const [index, call] of (bodies.extraCalls ?? []).entries()) {
    session.append('tool/call', {
      turn,
      step: 1,
      callId: ToolCallId(`extra-${turn}-${index}`),
      name: call.name,
      arguments: call.args,
    })
  }
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('workspace-memory extractor', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('indexes produced files without calling the model when autoExtract is false', async () => {
    const h = await harness({ autoExtract: false })
    dirs.push(h.dir)
    try {
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      const produced = join(h.dir, 'out.ts')
      await writeFile(produced, 'export const x = 1\n')
      appendTurn(session, 1, {
        user: 'write a file',
        assistant: 'writing',
        calls: [
          { name: 'write', args: JSON.stringify({ file_path: produced }) },
          { name: 'read', args: JSON.stringify({ file_path: produced }) },
          { name: 'write', args: JSON.stringify({ file_path: join(h.dir, 'missing.ts') }) },
          { name: 'write', args: 'not-json' },
          { name: 'str_replace_editor', args: JSON.stringify({ command: 'view', path: produced }) },
          { name: 'str_replace_editor', args: JSON.stringify({ command: 'create', path: 'other.ts' }) },
          { name: 'write', args: JSON.stringify({ path: '/outside-root-file.ts' }) },
          { name: 'write', args: JSON.stringify({ file_path: produced }), ok: false },
        ],
        extraCalls: [{ name: 'write', args: JSON.stringify({ file_path: 'unanswered.ts' }) }],
      })
      await vi.waitFor(() => {
        expect(h.ctx.workspaceMemory.read(id)?.outputs.map(entry => entry.path).sort()).toEqual(
          [join(h.dir, 'missing.ts'), join(h.dir, 'other.ts'), produced].sort(),
        )
      })
      expect(h.calls).toHaveLength(0)

      // A result without any call identity indexes nothing.
      session.append('turn/start', { turn: 2 })
      session.append(
        'tool/result',
        {
          turn: 2,
          step: 1,
          message: { content: [{ type: 'text', text: 'done' }] },
        } as never,
        { surfaceOp: 'append' },
      )
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.workspaceMemory.read(id)?.outputs).toHaveLength(3)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('ignores turns outside any workspace and unparseable tool arguments', async () => {
    const h = await harness({ autoExtract: false })
    dirs.push(h.dir)
    try {
      // No workspace exists while these turns close: nothing is indexed.
      const session = sessionIn(h.ctx, h.dir, 's1')
      appendTurn(session, 1, {
        user: 'hello',
        calls: [{ name: 'write', args: JSON.stringify({ file_path: 'x.ts' }) }],
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      expect(h.ctx.workspaceMemory.read(id)).toBeUndefined()

      // Unparseable arguments index nothing even with membership.
      const strange = sessionIn(h.ctx, h.dir, 's2')
      const id2 = WorkspaceId('ws-2')
      h.workspaces.set(id2, { id: id2, title: 'Other', path: h.dir, sessionIds: [strange.id] })
      appendTurn(strange, 1, {
        user: 'hello',
        calls: [
          { name: 'write', args: JSON.stringify(['not-an-object']) },
          { name: 'write', args: '"just-a-string"' },
          { name: 'write', args: 'null' },
        ],
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.workspaceMemory.read(id2)?.outputs ?? []).toHaveLength(0)
      expect(h.calls).toHaveLength(0)

      // Sessions without a working directory resolve to no workspace, as do
      // sessions whose directory no longer resolves or resolves elsewhere.
      const homeless = h.ctx.sessions.create(SessionId('homeless'))
      appendTurn(homeless, 1, { user: 'hello' })
      const lost = sessionIn(h.ctx, join(h.dir, 'gone'), 'lost')
      appendTurn(lost, 1, { user: 'hello' })
      const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'wme-else-')))
      dirs.push(elsewhere)
      const outsider = sessionIn(h.ctx, elsewhere, 'outsider')
      appendTurn(outsider, 1, { user: 'hello' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.calls).toHaveLength(0)

      // Disposing a session with no extraction in flight is a no-op.
      h.ctx.emit('session/disposed', strange)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('extracts memory with provenance through the configured route', async () => {
    const h = await harness({ provider: 'deepseek', model: 'chat' })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nWork\n## Preferences\nNone\n## Decisions\nNone\n## References\nNone')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, {
        user: 'remember that the sky is blue',
        injected: 'injected context',
        assistant: 'noted',
      })
      await vi.waitFor(() => {
        expect(h.ctx.workspaceMemory.read(id)?.memory).toContain('Work')
      })
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]).toMatchObject({
        provider: 'deepseek',
        model: 'chat',
        temperature: 0,
        purpose: 'workspace-memory',
      })
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('the sky is blue')
      expect(framed).not.toContain('injected context')
      expect(h.ctx.workspaceMemory.read(id)?.lastExtraction).toMatchObject({
        provider: 'deepseek',
        model: 'chat',
        truncated: false,
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('reuses the session route when no pair is configured and skips routeless turns', async () => {
    const h = await harness()
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nA\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      session.append('request/header', {
        header: { config: { provider: 'deepseek', model: 'reasoner' } },
        reason: 'initial',
      })
      appendTurn(session, 1, { user: 'remember alpha', assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.workspaceMemory.read(id)?.memory).toContain('## Purpose')
      })
      expect(h.calls[0]).toMatchObject({ provider: 'deepseek', model: 'reasoner' })

      const routeless = sessionIn(h.ctx, h.dir, 's2')
      const id2 = WorkspaceId('ws-2')
      h.workspaces.set(id2, { id: id2, title: 'Other', path: h.dir, sessionIds: [routeless.id] })
      appendTurn(routeless, 1, { user: 'remember beta', assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.calls).toHaveLength(1)
      expect(h.ctx.workspaceMemory.read(id2)).toBeUndefined()
    } finally {
      await h.fiber.dispose()
    }
  })

  it('skips trivial turns and honors the cooldown', async () => {
    const h = await harness({ provider: 'p', model: 'm', minTurnTextBytes: 200, cooldownMs: 60000 })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nA\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: 'hi', assistant: 'hello' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.calls).toHaveLength(0)

      appendTurn(session, 2, { user: `remember ${'x'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.workspaceMemory.read(id)?.memory).toContain('## Purpose')
      })
      appendTurn(session, 3, { user: `remember ${'y'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.calls).toHaveLength(1)

      // Empty message text contributes no transcript rows.
      appendTurn(session, 4, { user: '', assistant: '' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.calls).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('tolerates max-tokens and keeps the previous document on failures', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    try {
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      await h.ctx.workspaceMemory.setMemory(id, 'stable doc')

      h.streamImpl = immediate('partial doc', { kind: 'max-tokens' })
      appendTurn(session, 1, { user: `remember ${'a'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.workspaceMemory.read(id)?.lastExtraction).toMatchObject({ truncated: true })
      })
      expect(h.ctx.workspaceMemory.read(id)?.memory).toBe('partial doc')

      h.streamImpl = immediate('', { kind: 'error', failure: { message: 'boom', code: 'E_UPSTREAM' } })
      appendTurn(session, 2, { user: `remember ${'b'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.workspaceMemory.read(id)?.memory).toBe('partial doc')

      h.streamImpl = async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: ToolCallId('t1'), name: 'write', arguments: '{}' },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      appendTurn(session, 3, { user: `remember ${'c'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.workspaceMemory.read(id)?.memory).toBe('partial doc')

      h.streamImpl = async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
      appendTurn(session, 4, { user: `remember ${'d'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.workspaceMemory.read(id)?.memory).toBe('partial doc')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('truncates over-budget output before the store write', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate(`## Purpose\n${'z'.repeat(70000)}\n## Preferences\n-\n## Decisions\n-\n## References\n-`)
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'q'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.workspaceMemory.read(id)?.memory.length).toBeGreaterThan(0)
      })
      const record = h.ctx.workspaceMemory.read(id)
      expect(Buffer.byteLength(record?.memory ?? '', 'utf8')).toBeLessThanOrEqual(65536)
      expect(record?.lastExtraction).toMatchObject({ truncated: true })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('warns instead of rejecting when turn observation fails', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      const registry = h.ctx.workspaceRegistry as unknown as { list(): never }
      const list = vi.spyOn(registry, 'list').mockImplementation(() => {
        throw new Error('registry offline')
      })
      try {
        appendTurn(session, 1, { user: `remember ${'z'.repeat(300)}`, assistant: 'ok' })
        await vi.waitFor(() => {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn observation failed'))
        })
        expect(h.calls).toHaveLength(0)
      } finally {
        list.mockRestore()
      }
    } finally {
      warn.mockRestore()
      await h.fiber.dispose()
    }
  })

  it('serializes extractions per workspace and aborts on session disposal', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    try {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      h.streamImpl = () => (async function* (): AsyncIterable<StreamChunk> {
        await gate
        yield* textChunks('## Purpose\nA\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      })()
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'a'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.calls).toHaveLength(1)
      })
      const signal = h.calls[0]?.signal as AbortSignal
      h.ctx.emit('session/disposed', session)
      expect(signal.aborted).toBe(true)
      release()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.workspaceMemory.read(id)?.memory ?? '').not.toContain('## Purpose')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuilds from chat history newest-first and skips archived sessions', async () => {
    const h = await harness({ provider: 'p', model: 'm', rebuildSessionLimit: 5, autoExtract: false })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const old = sessionIn(h.ctx, h.dir, 'old')
      appendTurn(old, 1, { user: 'old fact one', assistant: 'ok' })
      old.append(
        'user/message',
        createUserMessage({ content: [{ type: 'text', text: '' }], source: { kind: 'user' } }),
        { surfaceOp: 'append' },
      )
      old.append(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: createAssistantMessage({ content: [{ type: 'text', text: '' }], source: { provider: 'p', model: 'm' } }),
          stream: [],
        },
        { surfaceOp: 'append' },
      )
      const current = sessionIn(h.ctx, h.dir, 'current')
      appendTurn(current, 1, { user: 'new fact two', assistant: 'ok' })
      const archived = sessionIn(h.ctx, h.dir, 'archived')
      appendTurn(archived, 1, { user: 'archived fact three', assistant: 'ok' })
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, {
        id,
        title: 'Project',
        path: h.dir,
        sessionIds: [current.id, old.id, archived.id, SessionId('ghost')],
      })
      h.archived.push(archived.id)
      await h.ctx.workspaceMemoryExtractor.rebuild(id, new AbortController().signal)
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('new fact two')
      expect(framed).toContain('old fact one')
      expect(framed).not.toContain('archived fact three')
      expect(framed.indexOf('new fact two')).toBeLessThan(framed.indexOf('old fact one'))
      expect(h.ctx.workspaceMemory.read(id)?.memory).toContain('## Purpose')
      expect(h.ctx.workspaceMemory.read(id)?.lastExtraction).toMatchObject({ provider: 'p', model: 'm' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuilds through sessionQuery when present and reuses live routes', async () => {
    const h = await harness({ autoExtract: false })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      session.append('request/header', {
        header: { config: { provider: 'qp', model: 'qm' } },
        reason: 'initial',
      })
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      h.ctx.provide('sessionQuery', {
        filterEvents: async () => [{ text: 'semantic one' }, { text: '' }, {}, { text: 'semantic two' }],
      } as never)
      await h.ctx.workspaceMemoryExtractor.rebuild(id, new AbortController().signal)
      expect(h.calls[0]).toMatchObject({ provider: 'qp', model: 'qm' })
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('semantic one')
      expect(framed).toContain('semantic two')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild rejects without a route and for unknown workspaces', async () => {
    const h = await harness({ autoExtract: false })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      appendTurn(session, 1, { user: 'hello world', assistant: 'ok' })
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      await expect(h.ctx.workspaceMemoryExtractor.rebuild(id, new AbortController().signal)).rejects.toMatchObject({
        code: 'workspace-memory/extraction-failed',
      })
      await expect(
        h.ctx.workspaceMemoryExtractor.rebuild(WorkspaceId('missing'), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'workspace/not-found' })
      await new Promise(resolve => setTimeout(resolve, 50))
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild skips sessions whose query fails', async () => {
    const h = await harness({ provider: 'p', model: 'm', autoExtract: false })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [SessionId('ghost')] })
      h.ctx.provide('sessionQuery', {
        filterEvents: async () => {
          throw new Error('index offline')
        },
      } as never)
      await h.ctx.workspaceMemoryExtractor.rebuild(id, new AbortController().signal)
      expect(h.ctx.workspaceMemory.read(id)?.memory).toContain('## Purpose')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuilds sessionless workspaces and caps one over-budget row', async () => {
    const h = await harness({ provider: 'p', model: 'm', maxInputBytes: 60, autoExtract: false })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const solo = sessionIn(h.ctx, h.dir, 'solo')
      appendTurn(solo, 1, { user: `lone ${'w'.repeat(500)}` })
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [solo.id] })
      await h.ctx.workspaceMemoryExtractor.rebuild(id, new AbortController().signal)
      const record = h.ctx.workspaceMemory.read(id)
      expect(record?.memory).toContain('## Purpose')
      expect(record?.lastExtraction).toMatchObject({ sessionId: String(solo.id), truncated: false })
      // The lone over-budget row is kept whole instead of dropped.
      expect(record?.lastExtraction?.inputBytes).toBeGreaterThan(60)
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('lone')

      const emptyId = WorkspaceId('ws-empty')
      h.workspaces.set(emptyId, { id: emptyId, title: 'Empty', path: h.dir, sessionIds: [] })
      await h.ctx.workspaceMemoryExtractor.rebuild(emptyId, new AbortController().signal)
      expect(h.ctx.workspaceMemory.read(emptyId)?.memory).toContain('## Purpose')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('drops the superseded chain entry when turns overlap', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      h.streamImpl = () => {
        if (h.calls.length > 1) return immediate('## Purpose\nB\n## Preferences\nB\n## Decisions\nB\n## References\nB')()
        return (async function* (): AsyncIterable<StreamChunk> {
          await gate
          yield* textChunks('## Purpose\nA\n## Preferences\nA\n## Decisions\nA\n## References\nA')
        })()
      }
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'a'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.calls).toHaveLength(1)
      })
      appendTurn(session, 2, { user: `remember ${'b'.repeat(300)}`, assistant: 'ok' })
      release()
      await vi.waitFor(() => {
        expect(h.calls).toHaveLength(2)
      })
      await vi.waitFor(() => {
        expect(h.ctx.workspaceMemory.read(id)?.memory).toContain('## Purpose')
      })
      await new Promise(resolve => setTimeout(resolve, 50))
    } finally {
      release()
    }
  })

  it('aborts in-flight extractions on context teardown', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    let release = (): void => {}
    try {
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      h.streamImpl = () => (async function* (): AsyncIterable<StreamChunk> {
        await gate
        yield* textChunks('## Purpose\nA\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      })()
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'a'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.calls).toHaveLength(1)
      })
      await h.fiber.dispose()
      expect((h.calls[0]?.signal as AbortSignal).aborted).toBe(true)
      release()
      await new Promise(resolve => setTimeout(resolve, 50))
    } finally {
      release()
    }
  })

  it('indexes workspace files for sessions attached by id without a cwd', async () => {
    const h = await harness({ autoExtract: false })
    dirs.push(h.dir)
    try {
      const session = h.ctx.sessions.create(SessionId('nocwd'))
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      const produced = join(h.dir, 'out.ts')
      await writeFile(produced, 'export const x = 1\n')
      appendTurn(session, 1, {
        user: 'write a file',
        assistant: 'writing',
        calls: [{ name: 'write', args: JSON.stringify({ file_path: produced }) }],
      })
      await vi.waitFor(() => {
        expect(h.ctx.workspaceMemory.read(id)?.outputs.map(entry => entry.path)).toEqual([produced])
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('warns instead of rejecting when output indexing fails', async () => {
    const h = await harness({ autoExtract: false })
    dirs.push(h.dir)
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      const produced = join(h.dir, 'out.ts')
      await writeFile(produced, 'export const x = 1\n')
      const record = vi.spyOn(h.ctx.workspaceMemory, 'recordOutputs').mockRejectedValueOnce(new Error('index offline'))
      appendTurn(session, 1, {
        user: 'write a file',
        calls: [{ name: 'write', args: JSON.stringify({ file_path: produced }) }],
      })
      await vi.waitFor(() => {
        expect(record).toHaveBeenCalled()
      })
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('output indexing failed'))
      })
      expect(h.ctx.workspaceMemory.read(id)?.outputs ?? []).toHaveLength(0)
    } finally {
      warn.mockRestore()
      await h.fiber.dispose()
    }
  })

  it('caps rebuild input and survives store write races', async () => {
    const h = await harness({ provider: 'p', model: 'm', maxInputBytes: 60, autoExtract: false })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      appendTurn(session, 1, { user: `remember ${'w'.repeat(500)}`, assistant: 'ok' })
      const id = WorkspaceId('ws-1')
      h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
      await h.ctx.workspaceMemoryExtractor.rebuild(id, new AbortController().signal)
      expect(h.ctx.workspaceMemory.read(id)?.memory).toContain('## Purpose')

      const failing = await harness({ provider: 'p', model: 'm' })
      dirs.push(failing.dir)
      try {
        failing.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
        const other = sessionIn(failing.ctx, failing.dir, 's2')
        appendTurn(other, 1, { user: `remember ${'v'.repeat(300)}`, assistant: 'ok' })
        const otherId = WorkspaceId('ws-2')
        failing.workspaces.set(otherId, { id: otherId, title: 'P', path: failing.dir, sessionIds: [other.id] })
        const recordSpy = vi.spyOn(failing.ctx.workspaceMemory, 'setMemory').mockRejectedValueOnce(new Error('lost write'))
        appendTurn(other, 2, { user: `remember ${'u'.repeat(300)}`, assistant: 'ok' })
        await vi.waitFor(() => {
          expect(recordSpy).toHaveBeenCalled()
        })
        await new Promise(resolve => setTimeout(resolve, 100))
      } finally {
        await failing.fiber.dispose()
      }
    } finally {
      await h.fiber.dispose()
    }
  })

  it('performs no extraction or indexing after teardown', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
    const session = sessionIn(h.ctx, h.dir, 's1')
    const id = WorkspaceId('ws-1')
    h.workspaces.set(id, { id, title: 'Project', path: h.dir, sessionIds: [session.id] })
    await h.fiber.dispose()
    appendTurn(session, 1, { user: `remember ${'w'.repeat(300)}`, assistant: 'ok' })
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    setTimeout(gate.resolve, 100)
    await gate.promise
    expect(h.calls).toHaveLength(0)
    expect(h.ctx.workspaceMemory.read(id)).toBeUndefined()
  })
})
