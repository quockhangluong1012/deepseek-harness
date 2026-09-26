import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import type { CommandExecution } from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as commandInit from '../src/index.ts'

interface TestHarness {
  readonly ctx: Context
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

async function harness(): Promise<TestHarness> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(AgentRegistry)
  const plugin = await ctx.plugin(commandInit)
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
    followup: (message) => { agent.inbox.append('next-turn', message) },
    steer: () => {},
    inject(input) { this.inbox.append('next-step', input) },
    cancel() { status = 'idle' },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  await ctx.agents.register(agent)
  return { ctx, agent, plugin }
}

function submittedText(agent: Agent): string {
  return agent.inbox.nextTurn
    .map(message => message.content
      .map(block => block.type === 'text' ? block.text : '')
      .join(''))
    .join('\n')
}

async function run(test: TestHarness, input: string): Promise<CommandExecution | undefined> {
  return test.ctx.commands.execute(test.agent, `/init${input}`, [], new AbortController().signal)
}

describe('/init', () => {
  it('submits one user message asking the agent to write AGENTS.md', async () => {
    const test = await harness()
    const execution = await run(test, '')

    expect(execution?.result).toEqual({
      kind: 'success',
      text: 'Asked the agent to write AGENTS.md for this workspace.',
    })
    const text = submittedText(test.agent)
    expect(text).toContain('create or update the root `AGENTS.md`')
    expect(test.agent.inbox.nextTurn).toHaveLength(1)
    await test.plugin.dispose()
  })

  it('rejects arguments without submitting anything', async () => {
    const test = await harness()
    const execution = await run(test, ' now')

    expect(execution?.result).toEqual({ kind: 'error', text: 'Usage: /init' })
    expect(test.agent.inbox.nextTurn).toEqual([])
    await test.plugin.dispose()
  })
})
