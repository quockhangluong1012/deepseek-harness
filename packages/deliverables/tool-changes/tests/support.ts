/** Shared fixtures: a git-backed workspace whose real recorder records turns, plus a calling agent. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createAssistantMessage, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolResult } from '@deepseek-ai/dsh-tools'
import * as WorkspaceChangesPlugin from '@deepseek-ai/dsh-workspace-changes'
import * as ToolChanges from '../src/index.ts'

let callNumber = 0

/** Run git synchronously inside a fixture repository. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Log one settled tool call so the recorder records the turn it belongs to. */
export function toolResult(session: Session, turn: number): void {
  const callId = ToolCallId(`call-${++callNumber}`)
  session.append('assistant/message', {
    stream: [], turn, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    }),
  }, { surfaceOp: 'append' })
  const source = session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  session.append('tool/result', {
    turn, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [source.seq] })
}

/** Wait for the recorder's queued git work through the same waterfall a tool execution uses. */
export async function settle(ctx: Context, session: Session): Promise<void> {
  await ctx.waterfall('tools/pre-execute', { agent: { session } } as never, () => Promise.resolve(undefined as never))
}

/**
 * Vitest deadline for one spec that records a real turn. A composed turn runs several git
 * subprocesses (turn-start snapshot, write-tree, numstat) beside the other forked suites, which
 * exceeds the five-second default on a loaded development host.
 */
export const GIT_SUBPROCESS_TIMEOUT_MS = 60_000

/** The single model-visible text block of one tool result. */
export function modelText(result: ToolResult): string {
  const [block] = result.content
  if (block === undefined || block.type !== 'text') {
    throw new Error(`expected one text block, got ${JSON.stringify(result.content)}`)
  }
  return block.text
}

/** Build the calling agent that owns one Session. */
export async function callingAgent(ctx: Context, session: Session): Promise<Agent> {
  let scope: Scope
  const value: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    get ctx() { return scope.ctx },
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, value) }, { inject: ['tools'] }))
  await ctx.agents.register(value)
  return value
}

/** The composed fixture surface one spec uses. */
export interface ChangesFixture {
  /** The composed context: real session store, recorder, tool registry, and this package. */
  readonly ctx: Context
  /** Working directory of the fixture repository. */
  readonly cwd: string
  /**
   * Execute one of the package's tools through the real registry.
   * @param name - tool name.
   * @param args - model-generated arguments.
   * @param withAgent - pass the calling agent, or omit it to exercise the detached path.
   * @returns the normalized tool result.
   */
  execute: (name: string, args: unknown, withAgent?: boolean) => Promise<ToolResult>
  /** Record one completed top-level turn through the real recorder, applying `mutate` inside it. */
  recordTurn: (turn: number, mutate: () => Promise<void>) => Promise<void>
  /** Append a `workspace/changes` event this Host process never recorded. */
  appendUnrecorded: (turn: number) => void
  /** Dispose the composed context and delete the fixture files. */
  dispose: () => Promise<void>
}

/**
 * Compose the real shipper set — session store, local subprocess runtime, the
 * workspace-changes recorder, the tool registry — plus this package's tools.
 * @param config - recorder bounds, when a spec needs a smaller cap than the default.
 * @returns the fixture, with real recording over a real git repository.
 */
export async function changesFixture(config?: { maxFileBytes?: number }): Promise<ChangesFixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-changes-'))
  git(root, 'init', '-q', root)
  const cwd = join(root, 'ws')
  await mkdir(cwd)
  await writeFile(join(cwd, 'tracked.txt'), 'one\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(LocalSubprocessRuntime)
  // The recorder's shipped defaults, so a spec narrows only the file cap it declares.
  await ctx.plugin(WorkspaceChangesPlugin, {
    timeoutMs: 30_000,
    outputMaxBytes: 8 * 1024 * 1024,
    maxFiles: 500,
    maxFileBytes: config?.maxFileBytes ?? 2 * 1024 * 1024,
    diffTimeoutMs: 100,
  })
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolChanges)
  const session = ctx.sessions.create(SessionId(`tool-changes-${++callNumber}`), { meta: { cwd } })
  const agent = await callingAgent(ctx, session)
  return {
    ctx,
    cwd,
    execute: (name, args, withAgent = true) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId(`call-${++callNumber}`),
      name,
      arguments: args,
      ...withAgent ? { agent } : {},
    }),
    async recordTurn(turn, mutate) {
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      await settle(ctx, session)
      await mutate()
      toolResult(session, turn)
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
      await settle(ctx, session)
    },
    appendUnrecorded(turn) {
      session.append('workspace/changes', { turn })
    },
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
