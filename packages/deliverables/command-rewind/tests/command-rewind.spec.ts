/**
 * `/rewind` modes: code restore through the real workspace-changes plugin, conversation
 * branching through the real Session Controller branch, and the replacement-message path.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentStatus, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine, {
  type SemanticSessionSearchHit,
  type SessionEventSearchPage,
  type SessionEventSearchRequest,
  type SessionSearchExecContext,
  type SessionSearchHit,
  type SessionSearchPage,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as commandRewind from '../src/index.ts'

/** Windows dev hosts run git in a temp tree an order of magnitude slower than the CI lanes. */
const TIMEOUT = 60_000

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** A repository holding the text file every case edits and a committed binary file. */
async function repository(): Promise<string> {
  const cwd = await scratchDir('dsh-command-rewind-repo-')
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n')
  await writeFile(join(cwd, 'b.bin'), Buffer.from([0, 1, 2, 3]))
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

/** One live Agent-shaped stub whose admitted follow-ups are recorded for assertions. */
interface StubSession {
  readonly agent: Agent
  readonly session: Session
  readonly followed: UserMessage[]
}

function stubAgent(ctx: Context, id: SessionId, cwd: string | undefined, seed?: CreateAgentOptions): StubSession {
  const session = ctx.sessions.create(id, {
    ...seed?.seed === undefined ? {} : { seed: [...seed.seed] },
    ...cwd === undefined ? {} : { meta: { cwd, ...seed?.meta } },
    ...seed?.inheritedEventCount === undefined ? {} : { inheritedEventCount: seed.inheritedEventCount },
  })
  const inbox = createInboxStub()
  const followed: UserMessage[] = []
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: (message) => { followed.push(message) },
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, followed }
}

/** Concrete query service for this suite: branching reads observations, never search. */
class StubSessionQuery extends SessionQueryEngine {
  override searchSessions(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SessionSearchHit>> {
    return Promise.resolve({ items: [] })
  }

  override searchSessionsSemantic(
    _request: SessionSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionSearchPage<SemanticSessionSearchHit>> {
    return Promise.reject(new Error('semantic session search is outside this suite'))
  }

  override searchEvents(
    _request: SessionEventSearchRequest,
    _exec?: SessionSearchExecContext,
  ): Promise<SessionEventSearchPage> {
    return Promise.reject(new Error('session event search is outside this suite'))
  }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly cwd: string
  /** Every Session the branch mechanism created, in creation order. */
  readonly spawned: StubSession[]
}

/**
 * Compose the command with the real workspace-changes recorder and the real Session
 * Controller branch, whose agent creation and resume are replaced by recording stubs.
 */
async function harness(options: { readonly git?: boolean } = {}): Promise<Harness> {
  const cwd = options.git === false
    ? await scratchDir('dsh-command-rewind-dir-')
    : await repository()
  const ctx = new Context()
  const spawned: StubSession[] = []
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(WorkspaceChanges)
  await ctx.plugin(AgentRegistry)
  new StubSessionQuery(ctx)
  ctx.provide('typert', {
    lookups: { configure: () => () => {} },
    contexts: { configureHost: () => () => {} },
  } as never)
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'mock', model: 'mock' }),
    saveSelection: async () => {},
  } as never)
  ctx.provide('llm', { listProviders: () => [{ id: 'mock', name: 'mock' }] } as never)
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 5 * 1024 * 1024,
      maxImagesPerMessage: 20,
      maxMessageImageBytes: 100 * 1024 * 1024,
      maxImagePixels: 40_000_000,
      maxImageDimension: 2000,
      mediaTypes: ['image/png', 'image/jpeg'],
    },
    admitPromptContent: async (content: readonly never[]) => [...content],
  } as never)
  ctx.provide('fileUploads', {
    registerAgentResolver: () => () => {},
    resolve: () => undefined,
    bindPrompt: () => ({ commit: () => {}, [Symbol.dispose]: () => {} }),
    retirePrompt: () => {},
  } as never)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, agentOptions: CreateAgentOptions): Promise<AgentHandle> => {
      const child = stubAgent(ctx, agentOptions.sessionId, cwd, agentOptions)
      spawned.push(child)
      await agentOptions.setup?.(ownerCtx, child.agent)
      await ctx.agents.register(child.agent)
      return { agent: child.agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('rewind tests keep every source live')),
  })
  new SessionController(ctx, { nativeOpen: false }, {})
  await ctx.plugin(commandRewind)
  const source = stubAgent(ctx, SessionId(`command-rewind-${Math.random()}`), cwd)
  await ctx.agents.register(source.agent)
  return { ctx, agent: source.agent, session: source.session, cwd, spawned }
}

/** One file an edit turn rewrites, with the content the tool leaves behind. */
interface Edit {
  readonly path: string
  readonly content: string | Uint8Array
}

/** Drive one turn's file mutations through the real tool pipeline the recorder observes. */
async function editTurn(test: Harness, turn: number, first: Edit, also?: Edit): Promise<void> {
  test.session.append('turn/start', { turn })
  test.session.append('step/start', { turn, step: 1 })
  for (const edit of also === undefined ? [first] : [first, also]) {
    await test.ctx.waterfall('tools/pre-execute', {
      agent: { session: test.session },
      name: 'edit',
      arguments: { file_path: edit.path, old_string: 'l2', new_string: 'l2' },
    } as never, () => Promise.resolve(undefined as never))
    await writeFile(join(test.cwd, edit.path), edit.content)
  }
  test.session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' })
  test.session.append('step/end', { turn, step: 1 })
  test.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  await test.ctx.waterfall('tools/pre-execute', { agent: { session: test.session } } as never, () => Promise.resolve(undefined as never))
}

/** Append one turn with no file work, so a conversation boundary costs no git snapshot. */
function plainTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function run(test: Harness, args = ''): Promise<string> {
  const execution = await test.ctx.commands.execute(test.agent, `/rewind${args}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('rewind command was not registered')
  const result = execution.result
  if (result.kind === 'error') return `ERROR: ${result.text}`
  return result.text ?? ''
}

/** Every text block admitted as a follow-up by one stub agent. */
function followedText(agent: StubSession): string[] {
  return agent.followed.flatMap(message =>
    message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
}

describe('@deepseek-ai/dsh-command-rewind', () => {
  it('registers the rewind command with Loader-safe exports', async () => {
    expect(commandRewind.name).toBe('command-rewind')
    expect(commandRewind.inject).toEqual(['commands', 'workspaceChanges', 'sessionController'])
    const test = await harness()
    expect(test.ctx.commands.list(test.agent)).toContainEqual(expect.objectContaining({ name: 'rewind' }))
  }, TIMEOUT)

  it('restores a file to its content at the start of the given turn', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 model\nl3\n' })

    const text = await run(test, ' code 1')
    expect(text).toContain('Restored working-directory files to the start of turn 1.')
    expect(text).toContain('a.txt')
    expect(text).toContain('not recoverable through /rewind')
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
    expect(test.spawned).toEqual([])
  }, TIMEOUT)

  it('skips a binary file and reports it beside what it restored', async () => {
    const test = await harness()
    // One turn rewrites the text file and the binary file a rewind must leave alone.
    await editTurn(
      test, 1,
      { path: 'a.txt', content: 'l1\nl2 model\nl3\n' },
      { path: 'b.bin', content: Buffer.from([0, 9, 9, 9]) },
    )

    const text = await run(test, ' code 1')
    expect(text).toContain('Left untouched (could not restore):')
    expect(text).toContain('b.bin (binary)')
    expect(await readFile(join(test.cwd, 'b.bin'))).toEqual(Buffer.from([0, 9, 9, 9]))
  }, TIMEOUT)

  it('reports a turn whose changes were already reverted by hand', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 model\nl3\n' })
    await writeFile(join(test.cwd, 'a.txt'), 'l1\nl2\nl3\n')

    expect(await run(test, ' code 1')).toContain('Nothing changed since that turn.')
  }, TIMEOUT)

  it('requires the mode and never infers one', async () => {
    const test = await harness()
    expect(await run(test)).toContain('expected a mode')
    expect(await run(test, ' 1')).toContain('unknown mode "1"')
    expect(await run(test, ' chat 1')).toContain('unknown mode "chat"')
    expect(await run(test, ' code')).toContain('expected a positive turn number')
    expect(await run(test, ' code abc')).toContain('turn must be a positive integer')
    expect(await run(test, ' code 0')).toContain('turn must be a positive integer')
    expect(await run(test, ' code 1 2')).toContain('unexpected argument 2')
    expect(await run(test, ' code 1 extra more')).toContain('unexpected arguments extra more')
  }, TIMEOUT)

  it('rejects --edit on a code-only rewind and an empty replacement', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 model\nl3\n' })
    expect(await run(test, ' code 1 --edit')).toContain('--edit needs the replacement text')
    expect(await run(test, ' code 1 --edit new text')).toContain('needs a conversation rewind')
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2 model\nl3\n')
  }, TIMEOUT)

  it('errors when the named turn never started in the session', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 model\nl3\n' })
    expect(await run(test, ' conversation 4')).toContain('turn 4 never started in this session')
  }, TIMEOUT)

  it('errors for a code rewind of a turn with no recorded changes', async () => {
    const test = await harness()
    expect(await run(test, ' code 7')).toContain('no recorded file changes for turn 7')
  }, TIMEOUT)

  it('shows usage text for --help without restoring or branching anything', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 model\nl3\n' })
    const text = await run(test, ' --help')
    expect(text).toContain('Usage: /rewind <mode> <turn> [--edit <text>]')
    expect(text).toContain('Conversation rewind never changes this conversation')
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2 model\nl3\n')
    expect(test.spawned).toEqual([])
  }, TIMEOUT)

  it('branches the conversation and leaves both the tree and the source log untouched', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 first\nl3\n' })
    plainTurn(test.session, 2)
    const before = test.session.snapshotEvents()

    const text = await run(test, ' conversation 2')
    expect(text).toContain('Conversation rewound to just before turn 2: branched to session-')
    expect(text).toContain('This conversation is unchanged')
    // Only this command's own lifecycle records are appended; the history and the tree stay put.
    expect(test.session.snapshotEvents().slice(0, before.length)).toEqual(before)
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2 first\nl3\n')
    expect(test.spawned).toHaveLength(1)
    const child = test.spawned[0]
    if (child === undefined) throw new Error('the conversation branch created no session')
    expect(child.session.header.parentSession).toBe(test.session.id)
    expect(child.session.header.isSeeded).toBe(true)
    const types = child.session.snapshotEvents().map(event => event.type)
    expect(types.filter(type => type === 'turn/start')).toHaveLength(1)
    expect(child.session.snapshotEvents().at(-1)?.type).toBe('session/end-seed')
    expect(followedText(child)).toEqual([])
  }, TIMEOUT)

  it('replaces the message that opened the turn and sends it into the branch', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 first\nl3\n' })
    plainTurn(test.session, 2)

    const text = await run(test, ' conversation 2 --edit use the config loader instead')
    expect(text).toContain('Replaced the message that opened turn 2 in the branch and sent it there.')
    expect(test.spawned).toHaveLength(1)
    const child = test.spawned[0]
    if (child === undefined) throw new Error('the conversation branch created no session')
    expect(followedText(child)).toEqual(['use the config loader instead'])
    const admitted = child.followed[0]
    expect(admitted?.source.kind).toBe('user')
    expect(String((admitted?.source as { rpcId?: unknown } | undefined)?.rpcId)).toMatch(/^rewind-/u)
    expect(test.session.snapshotEvents().filter(event => event.type === 'user/message')).toEqual([])
  }, TIMEOUT)

  it('branches a turn that opens the session at its opening event', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 first\nl3\n' })

    const text = await run(test, ' conversation 1')
    expect(text).toContain('Conversation rewound to the start of turn 1: branched to session-')
    expect(test.spawned).toHaveLength(1)
    const child = test.spawned[0]
    if (child === undefined) throw new Error('the conversation branch created no session')
    const events = child.session.snapshotEvents()
    expect(events.map(event => event.type)).toEqual(['turn/start', 'session/end-seed', 'turn/end'])
    expect(events.at(-1)?.data).toEqual({ turn: 1, reason: { kind: 'forked' } })
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2 first\nl3\n')
  }, TIMEOUT)

  it('branches the conversation and restores the tree for the combined mode', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 first\nl3\n' })

    const text = await run(test, ' both 1')
    expect(text).toContain('Conversation rewound to the start of turn 1: branched to session-')
    expect(text).toContain('Restored working-directory files to the start of turn 1.')
    expect(test.spawned).toHaveLength(1)
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
  }, TIMEOUT)

  it('reports the code half as failed when the turn holds no git snapshot', async () => {
    const test = await harness({ git: false })
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 first\nl3\n' })

    const codeOnly = await run(test, ' code 1')
    expect(codeOnly).toContain('was not recorded with a git snapshot')
    const both = await run(test, ' both 1')
    expect(both).toContain('Incomplete — code rewind failed:')
    expect(both).toContain('branched to session-')
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2 first\nl3\n')
  }, TIMEOUT)

  it('reports a code half whose turn made no file changes', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 first\nl3\n' })
    plainTurn(test.session, 2)

    const text = await run(test, ' both 2')
    expect(text).toContain('Code: turn 2 has no recorded file changes, so nothing was restored.')
    expect(text).toContain('branched to session-')
    expect(test.spawned).toHaveLength(1)
  }, TIMEOUT)

  it('reports a branch that could not be taken and touches nothing', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 first\nl3\n' })
    vi.spyOn(test.ctx.sessionController, 'fork').mockRejectedValue(new Error('fork unavailable'))

    const text = await run(test, ' conversation 1')
    expect(text).toContain('ERROR: /rewind: conversation rewind failed: Error: fork unavailable')
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2 first\nl3\n')
  }, TIMEOUT)

  it('reports a failed restore beside the branch it already took', async () => {
    const test = await harness()
    await editTurn(test, 1, { path: 'a.txt', content: 'l1\nl2 first\nl3\n' })
    vi.spyOn(test.ctx.workspaceChanges, 'restore').mockRejectedValue(new Error('snapshot read failed'))

    const text = await run(test, ' both 1')
    expect(text).toContain('Incomplete — code rewind failed: Error: snapshot read failed')
    expect(text).toContain('branched to session-')
    expect(test.spawned).toHaveLength(1)
  }, TIMEOUT)
})
