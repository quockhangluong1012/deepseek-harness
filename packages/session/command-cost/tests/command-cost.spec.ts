import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { LlmModelCost } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as commandCost from '../src/index.ts'

const rates: LlmModelCost = {
  inputPerMTok: 1,
  outputPerMTok: 2,
  cacheReadPerMTok: 0.5,
  cacheWritePerMTok: 2,
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens }
}

function message(provider: string, model: string, inputTokens: number, outputTokens: number) {
  return {
    type: 'assistant/message',
    data: {
      message: { source: { kind: 'model', provider, model } },
      usage: usage(inputTokens, outputTokens),
      stream: [],
    },
  }
}

function attempt(inputTokens: number, outputTokens: number) {
  return {
    type: 'assistant/attempt',
    data: {
      stream: [{
        type: 'chunk',
        time: 1,
        chunk: { type: 'usage', usage: usage(inputTokens, outputTokens) },
      }],
    },
  }
}

function snapshot(id: string, events: readonly object[], inheritedEventCount = 0) {
  return { session: { id }, inheritedEventCount, events } as never
}

interface TestHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

interface HarnessOptions {
  readonly rootEvents: readonly object[]
  readonly children?: readonly object[]
  readonly sessions?: ReadonlyMap<string, object>
  readonly cost: LlmModelCost | undefined
}

async function harness(options: HarnessOptions): Promise<TestHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.provide('llm', {
    resolveModelInfo: vi.fn(() => Promise.resolve({ provider: 'test', id: 'model', name: 'Test', cost: options.cost })),
  } as never)
  ctx.provide('sessionQuery', {
    readSession: async (id: string) => {
      if (id === 'root') return snapshot('root', options.rootEvents)
      const recorded = options.sessions?.get(id)
      if (recorded !== undefined) return recorded
      return snapshot(id, [])
    },
  } as never)
  ctx.provide('subagents', { listDescendants: () => Promise.resolve([...(options.children ?? [])]) } as never)
  const plugin = await ctx.plugin(commandCost)
  const session = ctx.sessions.create(SessionId('root'))
  let status: AgentStatus = 'idle'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: createInboxStub(),
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
  await ctx.agents.register(agent)
  return { ctx, agent, plugin }
}

async function run(test: TestHarness): Promise<string> {
  const execution = await test.ctx.commands.execute(test.agent, '/cost', [], new AbortController().signal)
  if (execution === undefined) throw new Error('/cost was not registered')
  return execution.result.text ?? ''
}

describe('/cost', () => {
  it('includes this agent and billed subagent attempts without double-counting inherited events', async () => {
    const child = SessionId('child')
    const test = await harness({
      rootEvents: [
        { type: 'request/context', data: { provider: 'test', model: 'model' } },
        attempt(100, 50),
        message('test', 'model', 200, 100),
      ],
      children: [{
        kind: 'child',
        id: child,
        parentId: SessionId('root'),
        depth: 1,
        mode: 'one-shot',
        activity: 'inactive',
        hasChildren: false,
        label: 'researcher',
      }],
      sessions: new Map([
        [child, snapshot('child', [
          { type: 'request/context', data: { provider: 'test', model: 'model' } },
          message('test', 'model', 900, 900),
          attempt(50, 25),
        ], 2)],
      ]),
      cost: rates,
    })

    const output = await run(test)
    expect(output).toContain('Priced total: $0.00070000')
    expect(output).toContain('This agent: $0.00060000')
    expect(output).toContain('researcher: $0.00010000')
    await test.plugin.dispose()
  })

  it('labels missing route pricing as unknown instead of reporting free usage', async () => {
    const test = await harness({ rootEvents: [message('unpriced', 'model', 100, 50)], cost: undefined })
    const output = await run(test)
    expect(output).toContain('Unknown-priced attempts: 1')
    expect(output).toContain('unpriced/model')
    await test.plugin.dispose()
  })
})
