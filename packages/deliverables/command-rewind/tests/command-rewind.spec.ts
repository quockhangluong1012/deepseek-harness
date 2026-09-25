/** `/rewind` locates a turn's `workspace/changes` announcement and restores its code through the real workspace-changes plugin. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as WorkspaceChanges from '@deepseek-ai/dsh-workspace-changes'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as commandRewind from '../src/index.ts'

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

async function repository(): Promise<string> {
  const cwd = await scratchDir('dsh-command-rewind-repo-')
  git(cwd, 'init', '-q', '-b', 'main')
  await writeFile(join(cwd, 'a.txt'), 'l1\nl2\nl3\n')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
  return cwd
}

/** Build a live idle agent, matching the command-goal test's fixture shape. */
function stubAgent(ctx: Context, id: string, cwd: string): { agent: Agent; session: Session } {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd } })
  const inbox = createInboxStub()
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx: new Context(),
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  readonly cwd: string
}

async function harness(): Promise<Harness> {
  const cwd = await repository()
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(WorkspaceChanges)
  await ctx.plugin(commandRewind)
  const { agent, session } = stubAgent(ctx, `command-rewind-${Math.random()}`, cwd)
  return { ctx, agent, session, cwd }
}

/** Drive one turn's edit through the real tool pipeline the recorder observes. */
async function editTurn(test: Harness, turn: number, content: string): Promise<void> {
  test.session.append('turn/start', { turn })
  test.session.append('step/start', { turn, step: 1 })
  await test.ctx.waterfall('tools/pre-execute', { agent: { session: test.session }, name: 'edit', arguments: {} } as never, () => Promise.resolve(undefined as never))
  await writeFile(join(test.cwd, 'a.txt'), content)
  test.session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('c'), content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append' })
  test.session.append('step/end', { turn, step: 1 })
  test.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  await test.ctx.waterfall('tools/pre-execute', { agent: { session: test.session } } as never, () => Promise.resolve(undefined as never))
}

async function run(test: Harness, suffix = ''): Promise<string> {
  const execution = await test.ctx.commands.execute(test.agent, `/rewind${suffix}`, [], new AbortController().signal)
  if (execution === undefined) throw new Error('rewind command was not registered')
  const result = await execution.result
  if (result.kind === 'error') return `ERROR: ${result.text}`
  return result.text ?? ''
}

describe('@deepseek-ai/dsh-command-rewind', () => {
  it('registers the rewind command with Loader-safe exports', async () => {
    expect(commandRewind.name).toBe('command-rewind')
    expect(commandRewind.inject).toEqual(['commands', 'workspaceChanges'])
    const test = await harness()
    expect(test.ctx.commands.list()).toContainEqual(expect.objectContaining({ name: 'rewind' }))
  })

  it('restores a file to its content at the start of the given turn', async () => {
    const test = await harness()
    await editTurn(test, 1, 'l1\nl2 model\nl3\n')

    const text = await run(test, ' 1')
    expect(text).toContain('Rewound to the start of turn 1.')
    expect(text).toContain('a.txt')
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3\n')
  }, 15000)

  it('errors for a non-numeric or missing turn argument', async () => {
    const test = await harness()
    expect(await run(test)).toContain('ERROR')
    expect(await run(test, ' abc')).toContain('ERROR')
    expect(await run(test, ' 0')).toContain('ERROR')
  })

  it('errors when the turn has no recorded file changes', async () => {
    const test = await harness()
    expect(await run(test, ' 7')).toContain('no recorded file changes for turn 7')
  })

  it('shows usage text for --help without restoring anything', async () => {
    const test = await harness()
    await editTurn(test, 1, 'l1\nl2 model\nl3\n')
    const text = await run(test, ' --help')
    expect(text).toContain('Usage: /rewind')
    expect(await readFile(join(test.cwd, 'a.txt'), 'utf8')).toBe('l1\nl2 model\nl3\n')
  }, 15000)
})
