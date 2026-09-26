/**
 * The EX10 run flags at the runner boundary: each flag parses into config,
 * reaches the Agent or Session seam it names, and an unusable value fails loud
 * instead of being ignored. The bench mounts the real Agent registry, Session
 * store, prompt registry, and tool registry, and scripts one Agent factory, so
 * every assertion reads the real service state the flag changed.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { agentEvents, assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { ToolCallId, createAssistantMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { apply, Config } from '../src/index.ts'
import { internals } from '../src/runner-internals.ts'

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

/** What the scripted Agent does once the runner submits the task. */
interface Script {
  afterPrompt?(session: Session, agent: Agent): Promise<void> | void
}

/** One Session record the `--continue` lookup may return, newest first. */
interface RecordStub {
  id: string
  cwd: string
  createdAt: number
  parentSession?: string
  origin?: 'subagent'
}

/** Run-flag invocation options layered over the scripted Agent factory. */
interface FlagsBenchOptions {
  /** Provider-resolved cwd, which can differ from the harness process directory. */
  filesystemCwd?: string
  /** Run options forwarded to the runner's validated config. */
  model?: string
  permissionMode?: string
  maxTurns?: number
  systemPrompt?: string
  allowedTools?: string[]
  outputSchema?: ObjectJsonSchema
  /** Project the run as newline-delimited events instead of the answer line. */
  json?: boolean
  continueLatest?: boolean
  sessionId?: string
  /** Records the `--continue` lookup returns; absent leaves the query unmounted. */
  records?: RecordStub[]
  /** Leave the permission service unmounted to exercise the fail-loud path. */
  omitPermissionPresets?: boolean
  /** Stand-in permission service, so a switch can be observed without the sandbox stack. */
  permissionPresets?: { set: (session: Session, name: string) => void }
}

/** A scripted Agent's observable facts after one run. */
interface BenchObserved {
  agents: Agent[]
  sessions: Session[]
  submitted: boolean
}

/** Mount the registries around a scripted Agent factory and run the flags under test. */
async function bench(script: Script, options: FlagsBenchOptions = {}): Promise<{
  ctx: Context
  observed: BenchObserved
  run(): Promise<{ code: number; out: string; err: string }>
}> {
  const ctx = new Context()
  const cwd = options.filesystemCwd ?? process.cwd()
  if (options.filesystemCwd !== undefined) {
    ctx.provide('fs', {
      resolve: async () => ({ targetKey: cwd, displayPath: cwd }),
      processPath: () => cwd,
    } as never)
  }
  const observed: BenchObserved = { agents: [], sessions: [], submitted: false }
  let out = ''
  let err = ''

  const mount = async (
    _ownerCtx: Context,
    session: Session,
    createOptions: CreateAgentOptions | ResumeAgentOptions,
  ): Promise<Agent> => {
    const inbox = createInboxStub()
    let idle = Promise.resolve()
    // The scope key is the Agent itself and `Agent.ctx` is readonly, so the
    // literal below reads its context through a getter filled in by the mint
    // that follows it — the same construction order the loop's own class uses.
    let scope: Scope
    const agent: Agent = {
      id: session.id,
      options: createOptions.agentOptions ?? {},
      session,
      inbox,
      status: 'idle',
      get ctx() { return scope.ctx },
      cancel: () => {},
      runMaintenance: () => Promise.reject(new Error('not used')),
      send: () => {},
      followup: (message: UserMessage) => {
        observed.submitted = true
        agent.inbox.append('next-turn', message)
        idle = Promise.resolve().then(() => script.afterPrompt?.(session, agent))
      },
      steer: () => {},
      inject: () => {},
      whenIdle: () => idle,
    }
    // The Agent is its own scope key in the production loop, so the run flags
    // register in the scope the real registry reads them back from.
    scope = createScope(minting, agent)
    observed.agents.push(agent)
    await createOptions.setup?.(scope.ctx, agent)
    await ctx.agents.register(agent)
    return agent
  }

  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  // The production loop mints each Agent's scope from ITS OWN plugin context,
  // so the scope inherits the dependency API the run flags reach through
  // (`agentCtx.tools`, `agentCtx.systemPrompt`). A root Context has no such
  // API, so the bench resolves one from a plugin that declares the same
  // dependencies the loop does.
  const scopeOwner = Promise.withResolvers<Context>()
  await ctx.plugin({
    name: 'headless-run-flags-bench',
    inject: ['agents', 'sessions', 'tools', 'systemPrompt'],
    apply(benchCtx: Context) { scopeOwner.resolve(benchCtx) },
  })
  const minting = await scopeOwner.promise
  ctx.tools.register(defineTool({
    name: 'read', description: 'read a file', parameters: { path: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'contents' },
  }))
  ctx.tools.register(defineTool({
    name: 'edit', description: 'edit a file', parameters: { path: { type: 'string' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'edited' },
  }))
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(createOptions.sessionId, {
        ...createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      })
      observed.sessions.push(session)
      return { agent: await mount(ownerCtx, session, createOptions), dispose: () => Promise.resolve() }
    },
    async resume(ownerCtx: Context, resumeOptions: ResumeAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.get(resumeOptions.resumeSessionId)
        ?? ctx.sessions.create(resumeOptions.resumeSessionId, { meta: { cwd } })
      observed.sessions.push(session)
      return { agent: await mount(ownerCtx, session, resumeOptions), dispose: () => Promise.resolve() }
    },
  })
  if (options.records !== undefined) {
    const records = options.records
    // The real query applies the clauses it was handed, so the stub must too:
    // a record from another directory is not a candidate for --continue.
    ctx.provide('sessionQuery', {
      filterSessions: async (filters: readonly { kind: string; values?: readonly (string | null)[] }[]) => records
        .filter(record => filters.every(filter => filter.kind !== 'cwd'
          || filter.values?.includes(record.cwd) === true))
        .map(record => ({
          header: {
            id: record.id, cwd: record.cwd, createdAt: record.createdAt,
            ...record.parentSession === undefined ? {} : { parentSession: record.parentSession },
            ...record.origin === undefined ? {} : { origin: record.origin },
          },
          live: false,
          persisted: true,
        })),
      observeSession: async (sessionId: string) => {
        const record = records.find(candidate => candidate.id === sessionId)
        if (record === undefined) throw new Error(`no recorded Session ${sessionId}`)
        return {
          header: {
            id: record.id, cwd: record.cwd, createdAt: record.createdAt,
            ...record.origin === undefined ? {} : { origin: record.origin },
          },
          events: [],
          [Symbol.dispose]() {},
        }
      },
    } as never)
    ctx.provide('sessionPersistence', {} as never)
  }
  if (options.omitPermissionPresets !== true && options.permissionMode !== undefined) {
    ctx.provide('permissionPresets', {
      set: options.permissionPresets?.set ?? (() => {}),
    } as never)
  }
  return {
    ctx,
    observed,
    run: async () => {
      internals.stdout = { write: (chunk: string) => { out += chunk; return true } }
      internals.stderr = { write: (chunk: string) => { err += chunk; return true } }
      const exited = new Promise<number>((resolve) => {
        ctx.provide('appExit', (code: number) => { resolve(code) })
      })
      apply(ctx, {
        task: 'do the thing',
        ...options.json === undefined ? {} : { json: options.json },
        ...options.model === undefined ? {} : { model: options.model },
        ...options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode },
        ...options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns },
        ...options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt },
        ...options.allowedTools === undefined ? {} : { allowedTools: options.allowedTools },
        ...options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema },
        ...options.continueLatest === undefined ? {} : { continueLatest: options.continueLatest },
        ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      })
      return { code: await exited, out, err }
    },
  }
}

/** Append one completed turn, so the runner's interval folding has an answer. */
function appendTurn(session: Session, message: UserMessage, text: string): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** The one Agent the run mounted, for a case whose subject cannot be absent. */
function mountedAgent(observed: BenchObserved): Agent {
  const agent = observed.agents[0]
  if (agent === undefined) throw new Error('test run mounted no Agent')
  return agent
}

describe('headless run flags', () => {
  it('--model replaces the model id and keeps the deployment provider', async () => {
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'answered') },
    }, { model: 'flagged-model' })
    try {
      const result = await test.run()
      expect(result.code).toBe(0)
      expect(test.observed.agents[0]?.options).toEqual({ provider: 'test-provider', model: 'flagged-model' })
    } finally { await test.ctx.fiber.dispose() }
  })

  it('--allowed-tools hides every global tool the allow list does not name', async () => {
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'answered') },
    }, { allowedTools: ['read'] })
    try {
      const result = await test.run()
      const agent = test.observed.agents[0]
      expect(result.code).toBe(0)
      expect(test.ctx.tools.get('read', agent)).toBeDefined()
      expect(test.ctx.tools.get('edit', agent)).toBeUndefined()
    } finally { await test.ctx.fiber.dispose() }
  })

  it('fails loud for an --allowed-tools name no composed tool provides', async () => {
    const test = await bench({}, { allowedTools: ['nope'] })
    try {
      const result = await test.run()
      expect(result.code).toBe(1)
      expect(result.err).toContain('tools.restrict() names unknown global tool "nope"')
      expect(test.observed.submitted).toBe(false)
    } finally { await test.ctx.fiber.dispose() }
  })

  it('--system-prompt is the run\'s whole prompt in the Agent scope', async () => {
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'answered') },
    }, { systemPrompt: 'You are a CI bot.' })
    try {
      const result = await test.run()
      const agent = mountedAgent(test.observed)
      expect(result.code).toBe(0)
      expect(renderPrompt(await test.ctx.systemPrompt.assemble(assembleContextFor(agent)))).toBe('You are a CI bot.')
    } finally { await test.ctx.fiber.dispose() }
  })

  it('leaves the composed prompt in place without --system-prompt', async () => {
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'answered') },
    }, {})
    try {
      const result = await test.run()
      const agent = mountedAgent(test.observed)
      expect(result.code).toBe(0)
      expect(renderPrompt(await test.ctx.systemPrompt.assemble(assembleContextFor(agent))))
        .toContain('You are an AI agent powered by DeepSeek Harness.')
    } finally { await test.ctx.fiber.dispose() }
  })

  it('--max-turns refuses the step past the ceiling and admits the ones inside it', async () => {
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'answered') },
    }, { maxTurns: 2 })
    try {
      const result = await test.run()
      const agent = mountedAgent(test.observed)
      expect(result.code).toBe(0)
      expect(await preStep(test.ctx, agent, 2)).toEqual({ kind: 'enter', messages: [] })
      expect(await preStep(test.ctx, agent, 3)).toEqual({ kind: 'reject' })
    } finally { await test.ctx.fiber.dispose() }
  })

  it('admits every step without --max-turns', async () => {
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'answered') },
    }, {})
    try {
      const result = await test.run()
      const agent = mountedAgent(test.observed)
      expect(result.code).toBe(0)
      expect(await preStep(test.ctx, agent, 9)).toEqual({ kind: 'enter', messages: [] })
    } finally { await test.ctx.fiber.dispose() }
  })

  it('--permission-mode pins the run\'s Session through the permission service', async () => {
    const switches: { session: Session; preset: string }[] = []
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'answered') },
    }, {
      permissionMode: 'read-only',
      permissionPresets: { set: (session, preset) => { switches.push({ session, preset }) } },
    })
    try {
      const result = await test.run()
      expect(result.code).toBe(0)
      expect(switches).toHaveLength(1)
      expect(switches[0]?.preset).toBe('read-only')
      expect(switches[0]?.session).toBe(test.observed.sessions[0])
    } finally { await test.ctx.fiber.dispose() }
  })

  it('fails loud when --permission-mode has no permission service to pin', async () => {
    const test = await bench({}, { permissionMode: 'read-only', omitPermissionPresets: true })
    try {
      const result = await test.run()
      expect(result.code).toBe(1)
      expect(result.err).toContain('--permission-mode requires the permissionPresets service')
      expect(test.observed.submitted).toBe(false)
    } finally { await test.ctx.fiber.dispose() }
  })

  it('reports a preset the composed table rejects without running the task', async () => {
    const test = await bench({}, {
      permissionMode: 'nope',
      permissionPresets: {
        set() { throw new Error('permission: unknown preset "nope" (known: read-only, workspace-write)') },
      },
    })
    try {
      const result = await test.run()
      expect(result.code).toBe(1)
      expect(result.err).toContain('permission: unknown preset "nope"')
      expect(test.observed.submitted).toBe(false)
    } finally { await test.ctx.fiber.dispose() }
  })

  it('--output-schema registers the schema and reports the captured value', async () => {
    const schema = structuredSchema()
    const test = await bench({
      async afterPrompt(session, agent) {
        const result = await test.ctx.tools.execute({
          name: 'structured_output',
          arguments: { answer: 42 },
          callId: ToolCallId('call-1'),
          signal: new AbortController().signal,
          agent,
        })
        expect(result.isError).toBe(false)
        appendTurn(session, message(), 'answered in prose')
      },
    }, { outputSchema: schema })
    try {
      const result = await test.run()
      const agent = test.observed.agents[0]
      expect(result.code).toBe(0)
      expect(result.out).toBe('{"answer":42}\n')
      expect(test.ctx.tools.get('structured_output', agent)?.parameters).toEqual(schema)
    } finally { await test.ctx.fiber.dispose() }
  })

  it('carries the structured result on the --json final event too', async () => {
    const test = await bench({
      async afterPrompt(session, agent) {
        await test.ctx.tools.execute({
          name: 'structured_output',
          arguments: { answer: 42 },
          callId: ToolCallId('call-1'),
          signal: new AbortController().signal,
          agent,
        })
        appendTurn(session, message(), 'answered in prose')
      },
    }, { outputSchema: structuredSchema(), json: true })
    try {
      const result = await test.run()
      expect(result.code).toBe(0)
      const lines = result.out.trim().split('\n').map(line => JSON.parse(line) as { type: string })
      expect(lines.at(-1)).toEqual({ type: 'final', text: 'answered in prose', structured: { answer: 42 } })
    } finally { await test.ctx.fiber.dispose() }
  })

  it('fails loud when a --output-schema run never produced a structured result', async () => {
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'answered in prose') },
    }, { outputSchema: structuredSchema() })
    try {
      const result = await test.run()
      expect(result.code).toBe(1)
      expect(result.out).toBe('')
      expect(result.err).toContain('the run finished without a structured result')
    } finally { await test.ctx.fiber.dispose() }
  })

  it('--continue adopts the newest top-level Session recorded in this directory', async () => {
    const cwd = '/remote/workspace'
    const test = await bench({
      afterPrompt(session) { appendTurn(session, message(), 'continued') },
    }, {
      filesystemCwd: cwd,
      continueLatest: true,
      records: [
        { id: 'session-child', cwd, createdAt: 30, parentSession: 'session-newest', origin: 'subagent' },
        { id: 'session-newest', cwd, createdAt: 20 },
        { id: 'session-older', cwd, createdAt: 10 },
      ],
    })
    try {
      const result = await test.run()
      expect(result.code).toBe(0)
      expect(test.observed.sessions[0]?.id).toBe('session-newest')
    } finally { await test.ctx.fiber.dispose() }
  })

  it('fails loud when --continue finds no Session in this directory', async () => {
    const test = await bench({}, {
      filesystemCwd: '/remote/workspace',
      continueLatest: true,
      records: [{ id: 'session-elsewhere', cwd: '/somewhere/else', createdAt: 20 }],
    })
    try {
      const result = await test.run()
      expect(result.code).toBe(1)
      expect(result.err).toContain('no top-level Session is recorded in "/remote/workspace"')
      expect(test.observed.submitted).toBe(false)
    } finally { await test.ctx.fiber.dispose() }
  })

  it('rejects an overlay that names the Session twice', async () => {
    const test = await bench({}, { sessionId: 'session-exact', continueLatest: true })
    try {
      const result = await test.run()
      expect(result.code).toBe(1)
      expect(result.err).toContain('sessionId and continueLatest are mutually exclusive')
    } finally { await test.ctx.fiber.dispose() }
  })

  it('validates the run-option config shape', () => {
    expect(Config({})).toEqual({})
    expect(() => Config({ maxTurns: 0 })).toThrow()
    expect(() => Config({ maxTurns: 2.5 })).toThrow()
  })
})

/** One user message carrying the task text, as the runner submits it. */
function message(): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'do the thing' }],
    source: { kind: 'user' },
    id: brandString<MessageId>('message-task'),
  }
}

/** Dispatch one proposed step through the Agent's own pre-step waterfall. */
function preStep(ctx: Context, agent: Agent, step: number): Promise<{ kind: string }> {
  // The fused dispatcher injects `agent` into the payload and dispatches with
  // the Agent's own scope carrier, so the ceiling listener the flag registered
  // in that scope sees this step and no other agent's.
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

/** The object-rooted schema used by the structured-output cases. */
function structuredSchema(): ObjectJsonSchema {
  return {
    type: 'object',
    properties: { answer: { type: 'number' } },
    required: ['answer'],
    additionalProperties: false,
  }
}
