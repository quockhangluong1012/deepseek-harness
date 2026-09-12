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
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  SessionEventReadRequest,
  SessionEventSearchPage,
  SessionEventSearchRequest,
  SessionEventSearchHit,
  SessionEventWindow,
  SessionSearchHit,
  SessionSearchPage,
  SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionReviewer, { type Config as ReviewerConfig } from '../src/index.ts'

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
  scope: (name: string) => EvolutionScopeId
}

/**
 * Base reviewer config for specs covering the immediate path: no cooldown, no
 * text floor, and a `never` defer mode. Defer-queue specs override `defer`.
 */
const IMMEDIATE_TURNS: ReviewerConfig = {
  cooldownMs: 0,
  minTurnTextBytes: 0,
  profile: 'test',
  defer: 'never',
}

/** Surfaces handed back by the harness's `sessionQuery.readSurface`. */
type SurfaceReader = (sessionId: SessionId) => Promise<{ events: readonly SessionEvent[] }>

/**
 * Search half of the query seam. Every member is optional so a spec can pin
 * what the reviewer does when the seam is partly or wholly absent.
 */
interface SearchSeam {
  searchSessions: (request: SessionSearchRequest) => Promise<SessionSearchPage<SessionSearchHit>>
  searchEvents: (request: SessionEventSearchRequest) => Promise<SessionEventSearchPage>
  readEvent: (request: SessionEventReadRequest) => Promise<SessionEventWindow>
}

async function harness(
  overrides: ReviewerConfig = {},
  surface?: SurfaceReader,
  base: ReviewerConfig = IMMEDIATE_TURNS,
  search?: Partial<SearchSeam>,
): Promise<Harness> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'evr-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const { default: EvolutionMemoryStore } = await import('@deepseek-ai/dsh-evolution-memory')
  await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 1 << 20 })
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
  if (surface !== undefined || search !== undefined) {
    ctx.provide('sessionQuery', { readSurface: surface, ...search } as never)
  }
  const fiber = await ctx.plugin(
    EvolutionReviewer,
    // Object.assign: the Config interface shares its name with the zod
    // schema value, which trips no-misused-spread's class-instance check.
    Object.assign({}, base, overrides),
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
    scope: (name: string) => EvolutionScopeId('test', name),
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
      createUserMessage({ content: [{ type: 'text', text: bodies.injected }], source: { kind: 'plugin', plugin: 'other' } }),
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

/** One `user/message` surface event; `kind` selects human versus injected context. */
function userEvent(text: string, kind = 'user'): SessionEvent {
  return { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } } as unknown as SessionEvent
}

/** One `assistant/message` surface event. */
function assistantEvent(text: string): SessionEvent {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } } as unknown as SessionEvent
}

/** One ranked cross-session hit for the fake search seam. */
function recallHit(sessionId: string, seq: number, snippet: string): SessionSearchHit {
  return {
    header: { id: SessionId(sessionId) },
    live: false,
    persisted: true,
    bestMatch: recallEvent(sessionId, seq, 'user/message', snippet),
  } as unknown as SessionSearchHit
}

/** One ranked within-session event hit for the fake search seam. */
function recallEvent(sessionId: string, seq: number, type: string, snippet = 'excerpt'): SessionEventSearchHit {
  return {
    sessionId: SessionId(sessionId),
    seq: SessionSeq(seq),
    type,
    time: 0,
    surface: 'current',
    snippet,
  } as unknown as SessionEventSearchHit
}

/** Resolve one ranked event seq to the event the fake seam hands back. */
function recallTarget(seq: number): SessionEvent {
  if (seq === 3) return assistantEvent('the parser answer')
  if (seq === 2) return userEvent('the parser note')
  return userEvent('<evolution-brief>scope digest</evolution-brief>', 'evolution-memory')
}

/** Read the framed prompt text out of one extraction call. */
function framedText(call: GenerateOptions | undefined): string {
  const block = call?.messages[0]?.content.find(part => part.type === 'text')
  if (block === undefined || block.type !== 'text') throw new Error('framed call carries no text block')
  return block.text
}

/** Decode the JSON transcript rows out of one framed extraction call. */
function framedRows(call: GenerateOptions | undefined): unknown {
  const framed = framedText(call)
  return JSON.parse(framed.slice(framed.lastIndexOf('\n') + 1))
}

describe('evolution reviewer', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('indexes produced files without calling the model when disabled', async () => {
    const h = await harness({ enabled: false })
    dirs.push(h.dir)
    try {
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
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
          { name: 'write', args: JSON.stringify({ file_path: '   ', path: produced }) },
          { name: 'write', args: JSON.stringify({ command: 'create' }) },
        ],
        extraCalls: [{ name: 'write', args: JSON.stringify({ file_path: 'unanswered.ts' }) }],
      })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.outputs.map(entry => entry.path).sort()).toEqual(
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
      expect(h.ctx.evolutionMemory.read(id)?.outputs).toHaveLength(3)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('ignores turns outside any workspace', async () => {
    const h = await harness({ enabled: false })
    dirs.push(h.dir)
    try {
      // No workspace exists while these turns close: nothing is indexed.
      const session = sessionIn(h.ctx, h.dir, 's1')
      appendTurn(session, 1, {
        user: 'hello',
        calls: [{ name: 'write', args: JSON.stringify({ file_path: 'x.ts' }) }],
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      expect(h.ctx.evolutionMemory.read(h.scope('ws-1'))).toBeUndefined()

      // Unparseable arguments index nothing even with membership.
      const strange = sessionIn(h.ctx, h.dir, 's2')
      h.workspaces.set('ws-2', { id: WorkspaceId('ws-2'), title: 'Other', path: h.dir, sessionIds: [strange.id] })
      appendTurn(strange, 1, {
        user: 'hello',
        calls: [
          { name: 'write', args: JSON.stringify(['not-an-object']) },
          { name: 'write', args: '"just-a-string"' },
          { name: 'write', args: 'null' },
        ],
      })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.evolutionMemory.read(h.scope('ws-2'))?.outputs ?? []).toHaveLength(0)
      expect(h.calls).toHaveLength(0)

      // Sessions without a working directory resolve to no workspace, as do
      // sessions whose directory no longer resolves or resolves elsewhere.
      const homeless = h.ctx.sessions.create(SessionId('homeless'))
      appendTurn(homeless, 1, { user: 'hello' })
      const lost = sessionIn(h.ctx, join(h.dir, 'gone'), 'lost')
      appendTurn(lost, 1, { user: 'hello' })
      const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'evr-else-')))
      dirs.push(elsewhere)
      const outsider = sessionIn(h.ctx, elsewhere, 'outsider')
      appendTurn(outsider, 1, { user: 'hello' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.calls).toHaveLength(0)

      // Sessions found by directory rather than session id still resolve.
      const byPath = sessionIn(h.ctx, h.dir, 'bypath')
      appendTurn(byPath, 1, {
        user: 'hello',
        calls: [{ name: 'write', args: JSON.stringify({ file_path: 'found.ts' }) }],
      })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(h.scope('ws-1'))?.outputs.map(entry => entry.path)).toEqual([
          join(h.dir, 'found.ts'),
        ])
      })

      // Disposing a session with no extraction in flight is a no-op.
      h.ctx.emit('session/disposed', strange)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('extracts lessons with provenance through the configured route', async () => {
    const h = await harness({ provider: 'deepseek', model: 'chat' })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nWork\n## Preferences\nNone\n## Decisions\nNone\n## References\nNone')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, {
        user: 'remember that the sky is blue',
        injected: 'injected context',
        assistant: 'noted',
      })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('Work')
      })
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0]).toMatchObject({
        provider: 'deepseek',
        model: 'chat',
        temperature: 0,
        purpose: 'evolution-review',
      })
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('the sky is blue')
      expect(framed).not.toContain('injected context')
      expect(h.ctx.evolutionMemory.read(id)?.lastExtraction).toMatchObject({
        provider: 'deepseek',
        model: 'chat',
        origin: 'background_review',
        truncated: false,
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('skips non-text content blocks without failing the turn', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nSeen\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      session.append('turn/start', { turn: 1 })
      session.append(
        'user/message',
        {
          content: [{ type: 'image', image: { id: 'img-1' } }, { type: 'text' }],
          source: { kind: 'user' },
        } as never,
        { surfaceOp: 'append' },
      )
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('Seen')
      })
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('[]')
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
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      session.append('request/header', {
        header: { config: { provider: 'deepseek', model: 'reasoner' } },
        reason: 'initial',
      })
      appendTurn(session, 1, { user: 'remember alpha', assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
      })
      expect(h.calls[0]).toMatchObject({ provider: 'deepseek', model: 'reasoner' })

      const routeless = sessionIn(h.ctx, h.dir, 's2')
      const id2 = h.scope('ws-2')
      h.workspaces.set('ws-2', { id: WorkspaceId('ws-2'), title: 'Other', path: h.dir, sessionIds: [routeless.id] })
      appendTurn(routeless, 1, { user: 'remember beta', assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.calls).toHaveLength(1)
      expect(h.ctx.evolutionMemory.read(id2)).toBeUndefined()
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
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: 'hi', assistant: 'hello' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.calls).toHaveLength(0)

      appendTurn(session, 2, { user: `remember ${'x'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
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

  it('extracts at turn end when defer is never', async () => {
    const h = await harness({ provider: 'p', model: 'm', defer: 'never' })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nImmediate\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'n'.repeat(300)}`, assistant: 'noted' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('Immediate')
      })
      expect(h.calls).toHaveLength(1)
      expect(h.ctx.evolutionMemory.read(id)?.lastExtraction).toMatchObject({ origin: 'background_review' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('defers turn extraction to the next timer turn', async () => {
    const h = await harness({ provider: 'p', model: 'm', defer: 'auto', deferMaxAgeMs: 0 })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nDeferred\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'q'.repeat(300)}`, assistant: 'ok' })
      expect(h.calls).toHaveLength(0)
      await new Promise(resolve => setTimeout(resolve, 0))
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('Deferred')
      })
      expect(h.calls).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('queues turn extraction when no defer mode is configured', async () => {
    const h = await harness({ provider: 'p', model: 'm' }, undefined, { cooldownMs: 0, minTurnTextBytes: 0, profile: 'test' })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nDefault\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'z'.repeat(300)}`, assistant: 'ok' })
      expect(h.calls).toHaveLength(0)
      // The default mode queues behind the default 30-minute ceiling, so an
      // immediate mode would have extracted by the next timer turn.
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(h.calls).toHaveLength(0)
      expect(h.ctx.evolutionMemory.read(id)).toBeUndefined()
    } finally {
      await h.fiber.dispose()
    }
  })

  it('coalesces queued turns into one extraction of the newest snapshot', async () => {
    const h = await harness({ provider: 'p', model: 'm', defer: 'auto', deferMaxAgeMs: 0 })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nCoalesced\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: 'remember the alpha detail', assistant: 'alpha acknowledged' })
      appendTurn(session, 2, { user: 'remember the beta detail', assistant: 'beta acknowledged' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('Coalesced')
      })
      expect(h.calls).toHaveLength(1)
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('beta acknowledged')
      expect(framed).not.toContain('alpha acknowledged')
      expect(framed).not.toContain('alpha detail')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(h.calls).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('drops a queued turn on teardown', async () => {
    const h = await harness({ provider: 'p', model: 'm', defer: 'auto', deferMaxAgeMs: 60000 })
    dirs.push(h.dir)
    h.streamImpl = immediate('## Purpose\nTorn\n## Preferences\nB\n## Decisions\nC\n## References\nD')
    const session = sessionIn(h.ctx, h.dir, 's1')
    const id = h.scope('ws-1')
    h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
    appendTurn(session, 1, { user: `remember ${'t'.repeat(300)}`, assistant: 'ok' })
    // Let the queue arm before teardown drops its entry.
    await new Promise(resolve => setTimeout(resolve, 20))
    await h.fiber.dispose()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(h.calls).toHaveLength(0)
    expect(h.ctx.evolutionMemory.read(id)).toBeUndefined()
  })

  it('ignores an armed timer whose session was disposed before the flush', async () => {
    const h = await harness({ provider: 'p', model: 'm', defer: 'auto', deferMaxAgeMs: 0 })
    dirs.push(h.dir)
    // Disposal and the armed timer race in the same tick here: neutralizing
    // clearTimeout leaves the timer to fire, so only the flush's own re-check
    // can keep the aborted turn from extracting.
    const cleared = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    try {
      h.streamImpl = immediate('## Purpose\nDropped\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      const disposed = new Promise<void>((resolve) => {
        setTimeout(() => {
          h.ctx.emit('session/disposed', session)
          resolve()
        }, 0)
      })
      appendTurn(session, 1, { user: `remember ${'d'.repeat(300)}`, assistant: 'ok' })
      await disposed
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(h.calls).toHaveLength(0)
      expect(h.ctx.evolutionMemory.read(id)).toBeUndefined()
    } finally {
      cleared.mockRestore()
      await h.fiber.dispose()
    }
  })

  it('tolerates max-tokens and keeps the previous document on failures', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    try {
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      await h.ctx.evolutionMemory.setLessons(id, 'stable doc')

      h.streamImpl = immediate('partial doc', { kind: 'max-tokens' })
      appendTurn(session, 1, { user: `remember ${'a'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.lastExtraction).toMatchObject({ truncated: true })
      })
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toBe('partial doc')

      h.streamImpl = immediate('', { kind: 'error', failure: { message: 'boom', code: 'E_UPSTREAM' } })
      appendTurn(session, 2, { user: `remember ${'b'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toBe('partial doc')

      h.streamImpl = immediate('', { kind: 'aborted', failure: { message: 'gone', code: 'ABORTED' } })
      appendTurn(session, 3, { user: `remember ${'c'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toBe('partial doc')

      h.streamImpl = async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: ToolCallId('t1'), name: 'write', arguments: '{}' },
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
      appendTurn(session, 4, { user: `remember ${'d'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toBe('partial doc')

      h.streamImpl = async function* (): AsyncIterable<StreamChunk> {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
      appendTurn(session, 5, { user: `remember ${'e'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toBe('partial doc')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('clips over-budget output to the store cap before retrying', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate(`## Purpose\n${'z'.repeat(70000)}\n## Preferences\n-\n## Decisions\n-\n## References\n-`)
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'q'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons.length).toBeGreaterThan(0)
      })
      const record = h.ctx.evolutionMemory.read(id)
      expect(Buffer.byteLength(record?.agentLessons ?? '', 'utf8')).toBeLessThanOrEqual(65536)
      expect(record?.lastExtraction).toMatchObject({ truncated: true })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('stages background extractions for approval when configured', async () => {
    const h = await harness({ provider: 'p', model: 'm', writeApproval: true })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nStaged\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'s'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.staged).toHaveLength(1)
      })
      const record = h.ctx.evolutionMemory.read(id)
      expect(record?.agentLessons).toBe('')
      expect(record?.staged[0]).toMatchObject({ kind: 'memory', op: 'setLessons', originSessionId: String(session.id) })
      expect(record?.staged[0]?.gist).toContain('turn 1')
      await h.ctx.evolutionMemory.approveStaged(record?.staged[0]?.id as string)
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('Staged')
      expect(h.ctx.evolutionMemory.read(id)?.staged).toHaveLength(0)
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
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
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

  it('serializes extractions per scope and aborts on session disposal', async () => {
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
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'a'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.calls).toHaveLength(1)
      })
      const signal = h.calls[0]?.signal as AbortSignal
      h.ctx.emit('session/disposed', session)
      expect(signal.aborted).toBe(true)
      release()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons ?? '').not.toContain('## Purpose')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuilds from session history newest-first and skips archived sessions', async () => {
    const surfaces = new Map<string, readonly SessionEvent[]>()
    const h = await harness(
      { provider: 'p', model: 'm', rebuildSessionLimit: 5, enabled: false },
      async (sessionId: SessionId) => ({ events: surfaces.get(String(sessionId)) ?? [] }),
    )
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const old = sessionIn(h.ctx, h.dir, 'old')
      appendTurn(old, 1, { user: 'old fact one', assistant: 'ok' })
      const current = sessionIn(h.ctx, h.dir, 'current')
      appendTurn(current, 1, { user: 'new fact two', assistant: 'ok' })
      const archived = sessionIn(h.ctx, h.dir, 'archived')
      appendTurn(archived, 1, { user: 'archived fact three', assistant: 'ok' })
      surfaces.set(String(old.id), [userEvent('old fact one'), userEvent('')])
      surfaces.set(String(current.id), [userEvent('new fact two')])
      surfaces.set(String(archived.id), [userEvent('archived fact three')])
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: h.dir,
        sessionIds: [current.id, old.id, archived.id],
      })
      h.archived.push(archived.id)
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('new fact two')
      expect(framed).toContain('old fact one')
      expect(framed).not.toContain('archived fact three')
      expect(framed.indexOf('new fact two')).toBeLessThan(framed.indexOf('old fact one'))
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
      expect(h.ctx.evolutionMemory.read(id)?.lastExtraction).toMatchObject({
        provider: 'p',
        model: 'm',
        origin: 'rebuild',
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild caps the session roster to rebuildSessionLimit newest-first', async () => {
    const surfaces = new Map<string, readonly SessionEvent[]>()
    const h = await harness(
      { provider: 'p', model: 'm', rebuildSessionLimit: 1, enabled: false },
      async (sessionId: SessionId) => ({ events: surfaces.get(String(sessionId)) ?? [] }),
    )
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const newest = sessionIn(h.ctx, h.dir, 'newest')
      const older = sessionIn(h.ctx, h.dir, 'older')
      surfaces.set(String(newest.id), [userEvent('newest fact')])
      surfaces.set(String(older.id), [userEvent('older fact')])
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: h.dir,
        sessionIds: [newest.id, older.id],
      })
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      const framed = framedText(h.calls[0])
      expect(framed).toContain('newest fact')
      expect(framed).not.toContain('older fact')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild frames assistant turns as the assistant role', async () => {
    const h = await harness({ provider: 'p', model: 'm', enabled: false }, async () => ({
      events: [userEvent('what changed'), assistantEvent('I updated the parser')],
    }))
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      // Newest-first framing reverses the surface order while keeping roles.
      expect(framedRows(h.calls[0])).toEqual([
        { role: 'assistant', text: 'I updated the parser' },
        { role: 'user', text: 'what changed' },
      ])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild drops injected context and keeps only human and assistant turns', async () => {
    const h = await harness({ provider: 'p', model: 'm', enabled: false }, async () => ({
      events: [
        userEvent('<evolution-brief>scope digest</evolution-brief>', 'evolution-memory'),
        userEvent('Read AGENTS.md before editing', 'agent-instructions'),
        userEvent('make the tea'),
        assistantEvent('brewing'),
      ],
    }))
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      const framed = framedText(h.calls[0])
      expect(framed).not.toContain('scope digest')
      expect(framed).not.toContain('Read AGENTS.md')
      expect(framedRows(h.calls[0])).toEqual([
        { role: 'assistant', text: 'brewing' },
        { role: 'user', text: 'make the tea' },
      ])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild reuses live session routes', async () => {
    const h = await harness({ enabled: false }, async () => ({
      events: [userEvent('semantic one'), userEvent('semantic two')],
    }))
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      session.append('request/header', {
        header: { config: { provider: 'qp', model: 'qm' } },
        reason: 'initial',
      })
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      expect(h.calls[0]).toMatchObject({ provider: 'qp', model: 'qm' })
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('semantic one')
      expect(framed).toContain('semantic two')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild rejects a scope key without a workspace part', async () => {
    const h = await harness({ enabled: false }, async () => ({ events: [] }))
    dirs.push(h.dir)
    try {
      await expect(
        h.ctx.evolutionReviewer.rebuild('plain' as EvolutionScopeId, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'workspace/not-found' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild rejects without a route, without a query, and for unknown scopes', async () => {
    const h = await harness({ enabled: false }, async () => ({ events: [userEvent('hello world')] }))
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      appendTurn(session, 1, { user: 'hello world', assistant: 'ok' })
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      await expect(h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)).rejects.toMatchObject({
        code: 'evolution/extraction-failed',
      })
      await expect(
        h.ctx.evolutionReviewer.rebuild(EvolutionScopeId('test', 'missing'), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'workspace/not-found' })
      await expect(
        h.ctx.evolutionReviewer.rebuild(EvolutionScopeId('test'), new AbortController().signal),
      ).rejects.toMatchObject({ code: 'evolution/extraction-failed' })
      await new Promise(resolve => setTimeout(resolve, 50))
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild requires the session query seam', async () => {
    const h = await harness({ enabled: false })
    dirs.push(h.dir)
    try {
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      await expect(h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)).rejects.toMatchObject({
        code: 'evolution/extraction-failed',
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('rebuild skips sessions whose surface read fails with a warning', async () => {
    const h = await harness(
      { provider: 'p', model: 'm', enabled: false },
      async () => {
        throw new Error('index offline')
      },
    )
    dirs.push(h.dir)
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [SessionId('ghost')] })
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rebuild skipped session'))
    } finally {
      warn.mockRestore()
      await h.fiber.dispose()
    }
  })

  it('rebuilds empty scopes and caps one over-budget row', async () => {
    const h = await harness({ provider: 'p', model: 'm', enabled: false }, async () => ({ events: [] }))
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const emptyId = h.scope('ws-empty')
      h.workspaces.set('ws-empty', {
        id: WorkspaceId('ws-empty'),
        title: 'Empty',
        path: h.dir,
        sessionIds: [],
      })
      await h.ctx.evolutionReviewer.rebuild(emptyId, new AbortController().signal)
      expect(h.ctx.evolutionMemory.read(emptyId)?.agentLessons).toContain('## Purpose')
      expect(h.calls[0]).toMatchObject({ provider: 'p', model: 'm' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps a lone over-budget rebuild row whole', async () => {
    const h = await harness({ provider: 'p', model: 'm', maxInputBytes: 60, enabled: false }, async () => ({
      events: [userEvent(`lone ${'w'.repeat(500)}`)],
    }))
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const only = sessionIn(h.ctx, h.dir, 'solo')
      appendTurn(only, 1, { user: 'placeholder', assistant: 'ok' })
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: h.dir,
        sessionIds: [only.id],
      })
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      const record = h.ctx.evolutionMemory.read(id)
      expect(record?.agentLessons).toContain('## Purpose')
      expect(record?.lastExtraction).toMatchObject({ sessionId: String(only.id), truncated: false })
      // The lone over-budget row is kept whole instead of dropped.
      expect(record?.lastExtraction?.inputBytes).toBeGreaterThan(60)
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('lone')
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
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
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
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
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
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'a'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.calls).toHaveLength(1)
      })
      expect(h.ctx.evolutionMemory.read(id)).toBeUndefined()
      await h.fiber.dispose()
      expect((h.calls[0]?.signal as AbortSignal).aborted).toBe(true)
      release()
      await new Promise(resolve => setTimeout(resolve, 50))
    } finally {
      release()
    }
  })

  it('indexes scope files for sessions attached by id without a cwd', async () => {
    const h = await harness({ enabled: false })
    dirs.push(h.dir)
    try {
      const session = h.ctx.sessions.create(SessionId('nocwd'))
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      const produced = join(h.dir, 'out.ts')
      await writeFile(produced, 'export const x = 1\n')
      appendTurn(session, 1, {
        user: 'write a file',
        assistant: 'writing',
        calls: [{ name: 'write', args: JSON.stringify({ file_path: produced }) }],
      })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.outputs.map(entry => entry.path)).toEqual([produced])
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('warns instead of rejecting when output indexing fails', async () => {
    const h = await harness({ enabled: false })
    dirs.push(h.dir)
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      const produced = join(h.dir, 'out.ts')
      await writeFile(produced, 'export const x = 1\n')
      const record = vi.spyOn(h.ctx.evolutionMemory, 'recordOutputs').mockRejectedValueOnce(new Error('index offline'))
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
      expect(h.ctx.evolutionMemory.read(id)?.outputs ?? []).toHaveLength(0)
    } finally {
      warn.mockRestore()
      await h.fiber.dispose()
    }
  })

  it('caps rebuild input and survives store write races', async () => {
    const h = await harness({ provider: 'p', model: 'm', maxInputBytes: 60, enabled: false }, async () => ({
      events: [userEvent(`dropped ${'w'.repeat(500)}`), userEvent(`kept ${'v'.repeat(500)}`)],
    }))
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      appendTurn(session, 1, { user: `remember ${'w'.repeat(500)}`, assistant: 'ok' })
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('kept')
      expect(framed).not.toContain('dropped')

      const failing = await harness({ provider: 'p', model: 'm' })
      dirs.push(failing.dir)
      try {
        failing.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
        const other = sessionIn(failing.ctx, failing.dir, 's2')
        appendTurn(other, 1, { user: `remember ${'v'.repeat(300)}`, assistant: 'ok' })
        const otherWorkspace = { id: WorkspaceId('ws-2'), title: 'P', path: failing.dir, sessionIds: [other.id] }
        failing.workspaces.set('ws-2', otherWorkspace)
        const recordSpy = vi.spyOn(failing.ctx.evolutionMemory, 'setLessons').mockRejectedValueOnce(new Error('lost write'))
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

  it('handles a turn end with no buffered turn', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nLate\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      session.append('turn/end', { turn: 7, reason: { kind: 'completed' } })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('Late')
      })
      const framed = (h.calls[0]?.messages[0]?.content[0] as { text: string }).text
      expect(framed).toContain('[]')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('performs no extraction or indexing after teardown', async () => {
    const h = await harness({ provider: 'p', model: 'm' })
    dirs.push(h.dir)
    h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
    const session = sessionIn(h.ctx, h.dir, 's1')
    const id = h.scope('ws-1')
    h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
    await h.fiber.dispose()
    appendTurn(session, 1, { user: `remember ${'w'.repeat(300)}`, assistant: 'ok' })
    const gate: PromiseWithResolvers<void> = Promise.withResolvers()
    setTimeout(gate.resolve, 100)
    await gate.promise
    expect(h.calls).toHaveLength(0)
    expect(h.ctx.evolutionMemory.read(id)).toBeUndefined()
  })

  it('recalls one ranked hit per turn and rewrites it only when it changes', async () => {
    const requests: SessionSearchRequest[] = []
    let snippet = 'prior parser fix'
    const h = await harness(
      { provider: 'p', model: 'm' },
      undefined,
      { ...IMMEDIATE_TURNS, enabled: true },
      {
        searchSessions: async (request) => {
          requests.push(request)
          return {
            items: [
              recallHit('s1', 4, 'own material'),
              recallHit('s2', 7, snippet),
            ],
          }
        },
        readEvent: async () => ({ target: userEvent('an older parser fix') }) as SessionEventWindow,
      },
    )
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: 'fix the parser', assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.contextItems).toHaveLength(1)
      })
      const first = h.ctx.evolutionMemory.read(id)?.contextItems[0]
      expect(first).toMatchObject({ kind: 'text', label: 'Recall: s2', text: 'prior parser fix' })
      // The search is ranked and scoped to the scope directory, and the
      // asking session never supplies its own recall material.
      expect(requests[0]).toMatchObject({
        query: 'fix the parser',
        sessionFilters: [{ kind: 'cwd', values: [h.dir] }],
      })

      appendTurn(session, 2, { user: 'fix the parser', assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      const repeated = h.ctx.evolutionMemory.read(id)?.contextItems[0]
      expect(repeated?.id).toBe(first?.id)
      expect(repeated?.addedAt).toBe(first?.addedAt)

      snippet = 'a different prior fix'
      appendTurn(session, 3, { user: 'fix the parser', assistant: 'ok' })
      await vi.waitFor(() => {
        expect((h.ctx.evolutionMemory.read(id)?.contextItems[0] as { text: string })?.text).toBe('a different prior fix')
      })
      // Replacement keeps exactly one recalled item.
      expect(h.ctx.evolutionMemory.read(id)?.contextItems).toHaveLength(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('never recalls a candidate that is injected context', async () => {
    const h = await harness(
      { provider: 'p', model: 'm' },
      undefined,
      { ...IMMEDIATE_TURNS, enabled: true },
      {
        searchSessions: async () => ({ items: [recallHit('s2', 7, 'brief text')] }),
        readEvent: async () => ({
          target: userEvent('<system-reminder>brief</system-reminder>', 'evolution-memory'),
        }) as SessionEventWindow,
      },
    )
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: 'fix the parser', assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
      })
      expect(h.ctx.evolutionMemory.read(id)?.contextItems).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('recalls nothing without a search seam or a human request', async () => {
    const exact = await harness(
      { provider: 'p', model: 'm' },
      undefined,
      { ...IMMEDIATE_TURNS, enabled: true },
      { searchSessions: async () => ({ items: [] }) },
    )
    dirs.push(exact.dir)
    const bare = await harness({ provider: 'p', model: 'm' }, undefined, { ...IMMEDIATE_TURNS, enabled: true })
    dirs.push(bare.dir)
    try {
      const stream = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      exact.streamImpl = stream
      bare.streamImpl = stream
      const searched = sessionIn(exact.ctx, exact.dir, 's1')
      const searchedId = exact.scope('ws-1')
      exact.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: exact.dir,
        sessionIds: [searched.id],
      })
      appendTurn(searched, 1, { user: `remember ${'a'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(exact.ctx.evolutionMemory.read(searchedId)?.agentLessons).toContain('## Purpose')
      })
      expect(exact.ctx.evolutionMemory.read(searchedId)?.contextItems).toEqual([])

      const unsearched = sessionIn(bare.ctx, bare.dir, 's1')
      const unsearchedId = bare.scope('ws-1')
      bare.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: bare.dir,
        sessionIds: [unsearched.id],
      })
      // Context arrives without a human message, so there is no recall query.
      appendTurn(unsearched, 1, { injected: `injected ${'b'.repeat(300)}`, assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(bare.ctx.evolutionMemory.read(unsearchedId)?.contextItems).toEqual([])
    } finally {
      await exact.fiber.dispose()
      await bare.fiber.dispose()
    }
  })

  it('recalls nothing for a blank request or a hit inside the asking session', async () => {
    const onlySelf = await harness(
      { provider: 'p', model: 'm' },
      undefined,
      { ...IMMEDIATE_TURNS, enabled: true },
      {
        searchSessions: async () => ({ items: [recallHit('s1', 4, 'own material')] }),
        readEvent: async () => ({ target: userEvent('own material') }) as SessionEventWindow,
      },
    )
    dirs.push(onlySelf.dir)
    const blank = await harness({ provider: 'p', model: 'm' }, undefined, { ...IMMEDIATE_TURNS, enabled: true })
    dirs.push(blank.dir)
    try {
      const stream = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      onlySelf.streamImpl = stream
      blank.streamImpl = stream
      const session = sessionIn(onlySelf.ctx, onlySelf.dir, 's1')
      const id = onlySelf.scope('ws-1')
      onlySelf.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: onlySelf.dir,
        sessionIds: [session.id],
      })
      appendTurn(session, 1, { user: `remember ${'c'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(onlySelf.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
      })
      expect(onlySelf.ctx.evolutionMemory.read(id)?.contextItems).toEqual([])

      const whitespace = sessionIn(blank.ctx, blank.dir, 's1')
      const blankId = blank.scope('ws-1')
      blank.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: blank.dir,
        sessionIds: [whitespace.id],
      })
      appendTurn(whitespace, 1, { user: '   ', assistant: 'ok' })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(blank.ctx.evolutionMemory.read(blankId)?.contextItems).toEqual([])
    } finally {
      await onlySelf.fiber.dispose()
      await blank.fiber.dispose()
    }
  })

  it('warns instead of rejecting when the recall search fails', async () => {
    const h = await harness(
      { provider: 'p', model: 'm' },
      undefined,
      { ...IMMEDIATE_TURNS, enabled: true },
      {
        searchSessions: async () => { throw new Error('index offline') },
        readEvent: async () => ({ target: userEvent('older work') }) as SessionEventWindow,
      },
    )
    dirs.push(h.dir)
    const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: 'fix the parser', assistant: 'ok' })
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('recall failed'))
      })
      expect(h.ctx.evolutionMemory.read(id)?.contextItems).toEqual([])
    } finally {
      warn.mockRestore()
      await h.fiber.dispose()
    }
  })

  it('rebuilds from ranked recall across the scope directory', async () => {
    const requests: SessionSearchRequest[] = []
    const h = await harness(
      { provider: 'p', model: 'm', enabled: false },
      undefined,
      { ...IMMEDIATE_TURNS, enabled: false },
      {
        searchSessions: async (request) => {
          requests.push(request)
          return { items: [recallHit('older', 3, 'older material')] }
        },
        searchEvents: async () => ({
          session: {} as never,
          items: [
            recallEvent('older', 3, 'assistant/message'),
            recallEvent('older', 2, 'user/message'),
            recallEvent('older', 1, 'user/message'),
          ],
        }),
        readEvent: async request => ({ target: recallTarget(Number(request.seq)) }) as SessionEventWindow,
      },
    )
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      const session = sessionIn(h.ctx, h.dir, 'asker')
      const older = sessionIn(h.ctx, h.dir, 'older')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: h.dir,
        sessionIds: [session.id, older.id],
      })
      appendTurn(session, 1, { user: 'what did we decide about the parser', assistant: 'ok' })
      // The turn observation is asynchronous; let it record the recall query.
      await new Promise(resolve => setTimeout(resolve, 50))
      await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
      // Ranked, directory-scoped, and restricted to the scope's roster.
      expect(requests[0]).toMatchObject({
        query: 'what did we decide about the parser',
        sessionFilters: [
          { kind: 'id', values: [session.id, older.id] },
          { kind: 'cwd', values: [h.dir] },
        ],
      })
      // The ranked event order is reversed back into rank order, roles
      // survive, and the injected-context candidate is dropped.
      expect(framedRows(h.calls[0])).toEqual([
        { role: 'assistant', text: 'the parser answer' },
        { role: 'user', text: 'the parser note' },
      ])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('falls back to the exact scan when ranked recall cannot run or finds nothing', async () => {
    const searches = new Map<string, number>()
    const counted = (label: string, impl: SearchSeam['searchSessions']): SearchSeam['searchSessions'] => async (request) => {
      searches.set(label, (searches.get(label) ?? 0) + 1)
      return await impl(request)
    }
    const partial = await harness(
      { provider: 'p', model: 'm', enabled: false },
      async () => ({ events: [userEvent('surface material')] }),
      { ...IMMEDIATE_TURNS, enabled: false },
      {
        searchSessions: counted('partial', async () => ({ items: [] })),
        searchEvents: async () => ({ session: {} as never, items: [] }),
      },
    )
    dirs.push(partial.dir)
    const empty = await harness(
      { provider: 'p', model: 'm', enabled: false },
      async () => ({ events: [userEvent('surface material')] }),
      { ...IMMEDIATE_TURNS, enabled: false },
      {
        searchSessions: counted('empty', async () => ({ items: [] })),
        searchEvents: async () => ({ session: {} as never, items: [] }),
        readEvent: async () => ({ target: userEvent('surface material') }) as SessionEventWindow,
      },
    )
    dirs.push(empty.dir)
    const failing = await harness(
      { provider: 'p', model: 'm', enabled: false },
      async () => ({ events: [userEvent('surface material')] }),
      { ...IMMEDIATE_TURNS, enabled: false },
      {
        searchSessions: counted('failing', async () => { throw new Error('index offline') }),
        searchEvents: async () => ({ session: {} as never, items: [] }),
        readEvent: async () => ({ target: userEvent('surface material') }) as SessionEventWindow,
      },
    )
    dirs.push(failing.dir)
    const unseen = await harness(
      { provider: 'p', model: 'm', enabled: false },
      async () => ({ events: [userEvent('surface material')] }),
      { ...IMMEDIATE_TURNS, enabled: false },
      {
        searchSessions: counted('unseen', async () => ({ items: [] })),
        searchEvents: async () => ({ session: {} as never, items: [] }),
        readEvent: async () => ({ target: userEvent('surface material') }) as SessionEventWindow,
      },
    )
    dirs.push(unseen.dir)
    try {
      const stream = immediate('## Purpose\nR\n## Preferences\nB\n## Decisions\nC\n## References\nD')
      // A scope with no observed turn has no recall query, ranked or not.
      unseen.streamImpl = stream
      const quiet = sessionIn(unseen.ctx, unseen.dir, 'quiet')
      const quietId = unseen.scope('ws-1')
      unseen.workspaces.set('ws-1', {
        id: WorkspaceId('ws-1'),
        title: 'Project',
        path: unseen.dir,
        sessionIds: [quiet.id],
      })
      await unseen.ctx.evolutionReviewer.rebuild(quietId, new AbortController().signal)
      expect(framedText(unseen.calls[0])).toContain('surface material')
      for (const h of [partial, empty, failing]) {
        h.streamImpl = stream
        const session = sessionIn(h.ctx, h.dir, 'asker')
        const id = h.scope('ws-1')
        h.workspaces.set('ws-1', {
          id: WorkspaceId('ws-1'),
          title: 'Project',
          path: h.dir,
          sessionIds: [session.id],
        })
        appendTurn(session, 1, { user: 'ranked query', assistant: 'ok' })
        await new Promise(resolve => setTimeout(resolve, 50))
        await h.ctx.evolutionReviewer.rebuild(id, new AbortController().signal)
        expect(framedText(h.calls[0])).toContain('surface material')
      }
      // A seam missing one ranked reader is rejected before any search runs.
      expect(searches.get('partial')).toBeUndefined()
      expect(searches.get('unseen')).toBeUndefined()
      expect(searches.get('empty')).toBe(1)
      expect(searches.get('failing')).toBe(1)
    } finally {
      await partial.fiber.dispose()
      await empty.fiber.dispose()
      await failing.fiber.dispose()
      await unseen.fiber.dispose()
    }
  })

  it('clips to the store cap when the squeeze budget exceeds it', async () => {
    const h = await harness({ provider: 'p', model: 'm', squeezeBytes: 70000 })
    dirs.push(h.dir)
    try {
      h.streamImpl = immediate(`## Purpose\n${'z'.repeat(70000)}\n## Preferences\n-\n## Decisions\n-\n## References\n-`)
      const session = sessionIn(h.ctx, h.dir, 's1')
      const id = h.scope('ws-1')
      h.workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: h.dir, sessionIds: [session.id] })
      appendTurn(session, 1, { user: `remember ${'q'.repeat(300)}`, assistant: 'ok' })
      await vi.waitFor(() => {
        expect(h.ctx.evolutionMemory.read(id)?.agentLessons).toContain('## Purpose')
      })
      const record = h.ctx.evolutionMemory.read(id)
      expect(Buffer.byteLength(record?.agentLessons ?? '', 'utf8')).toBeLessThanOrEqual(65536)
      expect(record?.lastExtraction).toMatchObject({ truncated: true })
    } finally {
      await h.fiber.dispose()
    }
  })
})
