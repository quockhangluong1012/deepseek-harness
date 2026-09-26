// Proves the seam end to end and not as a hand-built context: a test-only
// cordis.yml booted through the real Loader mounts the agent verifiers beside
// the kernel, and the kernel's own completion gate records the verdict this
// plugin's reviewer produced for a `review` and a `browser` criterion. The
// subagent provider is the only stand-in — a test-only module answering each
// start — because a real one runs a model.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompletionDecision, CriterionResult } from '@deepseek-ai/dsh-agent-kernel'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import * as AgentVerifiers from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * The `subagents` service the booted composition provides: it answers each start
 * with the report the boot supplies for that start's position, and records what
 * it was asked for.
 */
class StubSubagents extends Service {
  /**
   * @param ctx - the booted Loader context.
   * @param starts - this boot's start log.
   * @param reply - the structured report for one start.
   */
  constructor(
    ctx: Context,
    readonly starts: SubagentStartRequest[],
    private readonly reply: (started: number) => unknown,
  ) {
    super(ctx, 'subagents')
  }

  /**
   * Record one start and answer it with this boot's report.
   * @param _name - the provider name the caller selected.
   * @param request - the start request the caller made.
   * @returns the settled reviewer run.
   */
  async start(_name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    this.starts.push(request)
    const result: SubagentResult = { output: [], structured: this.reply(this.starts.length), stopReason: 'completed' }
    return { id: SessionId('reviewer-child'), localAgent: undefined, result: Promise.resolve(result), dispose: () => Promise.resolve() }
  }
}

/**
 * Boot one test-only cordis.yml: the loop prerequisites, the kernel carrying the
 * acceptance criteria under test, this plugin, and the test-only subagent
 * service.
 * @param acceptance - YAML lines declaring the kernel's `acceptance` criteria.
 * @param reply - the structured report for one reviewer start.
 * @returns the booted context and its start log.
 */
async function boot(
  acceptance: readonly string[],
  reply: (started: number) => unknown,
): Promise<{ ctx: Context; starts: SubagentStartRequest[] }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-agent-verifiers-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-kernel'",
    '  config:',
    '    acceptance:',
    ...acceptance,
    "- name: 'stub-subagents'",
    "- name: '@deepseek-ai/dsh-agent-verifiers'",
    '',
  ].join('\n'))

  const starts: SubagentStartRequest[] = []
  const stub = {
    name: 'stub-subagents',
    Config: z.object({}),
    apply(ctx: Context): void { new StubSubagents(ctx, starts, reply) },
  }
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-kernel', AgentKernel],
    ['stub-subagents', stub],
    ['@deepseek-ai/dsh-agent-verifiers', AgentVerifiers],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, starts }
}

/**
 * Register a directly constructed Agent so the kernel has a session to attach a
 * task to.
 * @param ctx - the booted context.
 * @returns the registered Agent.
 */
async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('agent-verifiers-agent')
  const value: Agent = {
    id,
    options: {},
    session: ctx.sessions.create(id),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

/**
 * Open the task contract the kernel verifies.
 * @param ctx - the booted context.
 * @param owner - the agent whose session records the task.
 * @returns the agent, after its contract exists.
 */
async function intake(ctx: Context, owner: Agent): Promise<Agent> {
  await ctx.waterfall(
    'agent/pre-step',
    {
      agent: owner,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  return owner
}

/** One acceptance criterion, as the kernel's `acceptance` list declares it. */
function criterion(id: string, verifier: string): readonly string[] {
  return [
    `      - id: ${id}`,
    `        description: ${id} must hold`,
    `        verifier: ${verifier}`,
    '        required: true',
  ]
}

/** Every durable payload of one event type in a session, in log order. */
function eventsOf<T extends keyof SessionEventMap>(owner: Agent, type: T): SessionEventMap[T][] {
  return owner.session.snapshotEvents()
    .filter((event): event is SessionEvent<T> => event.type === type)
    .map(event => event.data)
}

/** The criterion result the kernel's most recent verification recorded. */
function recorded(owner: Agent, criterionId: string): CriterionResult | undefined {
  return eventsOf(owner, 'verification/result').at(-1)?.criterionResults.find(result => result.criterionId === criterionId)
}

/**
 * Verify one agent's task inside the initiator boundary the agent loop
 * establishes around every turn: `closeTurn` runs inside that boundary, and the
 * `agentKernel.verify` API on its own establishes none.
 * @param ctx - the booted context.
 * @param owner - the agent whose task is verified.
 * @returns the completion decision.
 */
function verify(ctx: Context, owner: Agent): Promise<CompletionDecision | undefined> {
  return ctx.agents.withInitiator(owner, () => ctx.agentKernel.verify(owner))
}

describe('agent verifiers in real Loader composition', () => {
  it('records the independent reviewer\'s finding as the criterion verdict', async () => {
    const { ctx, starts } = await boot(
      criterion('code-review', 'review'),
      () => ({
        summary: 'the change drops an authorization check',
        findings: [{ file: 'src/a.ts', line: '12', severity: 'high', message: 'missing authorization' }],
      }),
    )
    const owner = await intake(ctx, await agent(ctx))

    const decision = await verify(ctx, owner)
    expect(decision?.allowed).toBe(false)
    expect(decision?.reasons).toContain('required criterion "code-review" is fail')
    expect(recorded(owner, 'code-review')).toMatchObject({ status: 'fail', evidence: ['src/a.ts'] })
    expect(recorded(owner, 'code-review')?.detail).toContain('[high] src/a.ts:12 — missing authorization')
    expect(starts).toHaveLength(1)
    expect(starts[0]?.label).toBe('review')
  }, 30_000)

  it('completes a task whose agent-verified criteria all pass', async () => {
    const { ctx, starts } = await boot(
      [...criterion('scenario', 'browser'), ...criterion('code-review', 'review')],
      started => started === 1
        ? { passed: true, detail: 'the settings page saved without a reload' }
        : { summary: 'no defect', findings: [] },
    )
    const owner = await intake(ctx, await agent(ctx))

    const decision = await verify(ctx, owner)
    expect(decision).toEqual({ allowed: true, reasons: [] })
    expect(recorded(owner, 'scenario')).toMatchObject({
      status: 'pass',
      detail: 'the settings page saved without a reload',
    })
    expect(recorded(owner, 'code-review')).toMatchObject({ status: 'pass' })
    // One reviewer per criterion, and no family is answered twice.
    expect(starts.map(start => start.label)).toEqual(['browser-check', 'review'])
  }, 30_000)

  it('leaves a family no verifier claims unresolved beside the families this plugin answers', async () => {
    const { ctx, starts } = await boot(
      [...criterion('build', 'build'), ...criterion('code-review', 'review')],
      () => ({ summary: 'no defect', findings: [] }),
    )
    const owner = await intake(ctx, await agent(ctx))

    const decision = await verify(ctx, owner)
    expect(decision?.allowed).toBe(false)
    expect(recorded(owner, 'build')).toMatchObject({
      status: 'unknown',
      detail: 'no verifier reported a result for this criterion',
    })
    expect(recorded(owner, 'code-review')).toMatchObject({ status: 'pass' })
    expect(starts).toHaveLength(1)
  }, 30_000)

  it('records the honest failure when an agentless verification cannot start a reviewer', async () => {
    const { ctx, starts } = await boot(criterion('code-review', 'review'), () => ({ summary: 'unused', findings: [] }))
    const owner = await intake(ctx, await agent(ctx))

    const decision = await ctx.agentKernel.verify(owner)
    expect(decision?.allowed).toBe(false)
    expect(recorded(owner, 'code-review')).toMatchObject({
      status: 'fail',
      detail: 'no initiating agent is active, so no independent reviewer could be started for this criterion',
    })
    expect(starts).toEqual([])
  }, 30_000)
})
