/**
 * The built-ins plugin's §10.6 reviewer wiring: the shipped reviewer is what the
 * kernel's coding-lifecycle REVIEW phase spawns, its structured report is
 * consumed, a reviewer that did not finish parks the task instead of completing
 * it, a deployment that supplies its own reviewer switches this one off, and a
 * deployment that never enables the review phase spawns nothing.
 *
 * @module @deepseek-ai/dsh-agent-kernel-builtins/tests/reviewer
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import type { AgentKernelService } from '@deepseek-ai/dsh-agent-kernel'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply as applyBuiltins, Config as builtinsConfig, name } from '../src/index.ts'
import type { Config } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One settled reviewer result as the fake subagent service answers with it. */
interface ReviewerAnswer {
  readonly stopReason: string
  readonly structured?: unknown
  readonly diagnostic?: string
}

/** A `ctx.subagents` stand-in that answers every start with one scripted result. */
class FakeSubagents extends Service {
  /** Starts this service answered, in order. */
  starts = 0
  /** The prompt of the latest start request. */
  lastPrompt: string | undefined
  /** The output schema of the latest start request. */
  lastSchema: unknown
  private readonly answer: () => ReviewerAnswer

  constructor(ctx: Context, answer: () => ReviewerAnswer) {
    super(ctx, 'subagents')
    this.answer = answer
  }

  start(_provider: string, request: { prompt: readonly { text?: string }[]; outputSchema?: unknown }) {
    this.starts += 1
    this.lastPrompt = request.prompt.map(block => block.text ?? '').join('')
    this.lastSchema = request.outputSchema
    const settled = this.answer()
    return {
      id: SessionId(`fake-review-child-${String(this.starts)}`),
      localAgent: undefined,
      result: Promise.resolve({ output: [], ...settled }),
      dispose: () => Promise.resolve(),
    }
  }
}

/** Build one live agent over a fresh session. */
function makeAgent(ctx: Context, id: string): Agent {
  const scope = ctx.plugin(() => {})
  const session = ctx.sessions.create(SessionId(id))
  return {
    id: session.id,
    options: {},
    session,
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
}

/** Mount the loop prerequisites, the kernel under `config`, and the built-ins plugin. */
async function mounted(config: Record<string, unknown> = {}, builtins: Config = {}): Promise<{ ctx: Context; kernel: AgentKernelService }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentKernel, config)
  await ctx.plugin({ name, apply: (pluginCtx: Context) => { applyBuiltins(pluginCtx, builtins) }, inject: ['agentKernel'], Config: builtinsConfig })
  return { ctx, kernel: ctx.agentKernel }
}

/** Admit one step for a coding task whose completion needs no acceptance criterion. */
async function runCodingTurn(ctx: Context, agent: Agent): Promise<void> {
  ctx.agentKernel.intake(agent, {
    objective: 'change the parser',
    agentProfile: 'default',
    taskClass: 'coding',
    acceptance: [],
  })
  await ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [createUserMessage({ content: [{ type: 'text', text: 'change the parser' }], source: { kind: 'user' } })], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  await ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal })
}

/** Every event of one type this agent recorded. */
function eventsOf<T extends keyof SessionEventMap>(agent: Agent, type: T): SessionEventMap[T][] {
  return agent.session.snapshotEvents()
    .filter(event => event.type === type)
    .map(event => event.data as SessionEventMap[T])
}

const REVIEW: ReviewerAnswer = {
  stopReason: 'completed',
  structured: { summary: 'the change is correct', findings: [] },
}

describe('built-in coding-lifecycle reviewer', () => {
  it('spawns the shipped reviewer for the REVIEW phase and consumes its report', async () => {
    const { ctx, kernel } = await mounted({ codingLifecycle: { review: { enabled: true, ref: 'origin/main' } } })
    const subagents = new FakeSubagents(ctx, () => REVIEW)
    const agent = makeAgent(ctx, 'reviewer-clean')

    await runCodingTurn(ctx, agent)

    expect(subagents.starts).toBe(1)
    expect(subagents.lastPrompt).toContain('origin/main')
    expect(subagents.lastPrompt).toContain('change the parser')
    expect(subagents.lastSchema).toBeDefined()
    expect(eventsOf(agent, 'task/review')).toHaveLength(1)
    expect(eventsOf(agent, 'task/review')[0]?.report.summary).toBe('the change is correct')
    expect(eventsOf(agent, 'task/phase').map(record => record.phase))
      .toEqual(['understand', 'map', 'plan', 'contract', 'implement', 'local-verify', 'review', 'regression', 'complete'])
    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
  })

  it('parks the task when the reviewer did not finish', async () => {
    const { ctx, kernel } = await mounted({ codingLifecycle: { review: { enabled: true } } })
    const subagents = new FakeSubagents(ctx, () => ({ stopReason: 'max-turns', diagnostic: 'ran out of turns' }))
    const agent = makeAgent(ctx, 'reviewer-unfinished')

    await runCodingTurn(ctx, agent)

    expect(subagents.starts).toBe(1)
    expect(eventsOf(agent, 'task/review')).toHaveLength(0)
    const failures = eventsOf(agent, 'failure/recorded')
    expect(failures.map(record => record.kind)).toEqual(['workflow-failed'])
    expect(failures[0]?.detail).toContain('did not finish (max-turns) — ran out of turns')
    expect(kernel.state.view(agent.session)?.task.status).toBe('awaiting-user')
  })

  it('parks the task when the reviewer returned no structured report', async () => {
    const { ctx, kernel } = await mounted({ codingLifecycle: { review: { enabled: true } } })
    new FakeSubagents(ctx, () => ({ stopReason: 'completed' }))
    const agent = makeAgent(ctx, 'reviewer-unstructured')

    await runCodingTurn(ctx, agent)

    expect(eventsOf(agent, 'failure/recorded')[0]?.detail)
      .toContain('finished without returning a structured report')
    expect(kernel.state.view(agent.session)?.task.status).toBe('awaiting-user')
  })

  it('registers no reviewer when the deployment supplies its own', async () => {
    const { ctx, kernel } = await mounted({ codingLifecycle: { review: { enabled: true } } }, { reviewer: false })
    const subagents = new FakeSubagents(ctx, () => REVIEW)
    const agent = makeAgent(ctx, 'reviewer-replaced')

    await runCodingTurn(ctx, agent)

    expect(subagents.starts).toBe(0)
    expect(eventsOf(agent, 'failure/recorded')[0]?.detail)
      .toContain('no independent reviewer is registered')
    expect(kernel.state.view(agent.session)?.task.status).toBe('awaiting-user')
  })

  it('spawns no reviewer while the lifecycle review phase is switched off', async () => {
    const { ctx, kernel } = await mounted()
    const subagents = new FakeSubagents(ctx, () => REVIEW)
    const agent = makeAgent(ctx, 'reviewer-off')

    await runCodingTurn(ctx, agent)

    expect(subagents.starts).toBe(0)
    expect(eventsOf(agent, 'task/review')).toHaveLength(0)
    expect(eventsOf(agent, 'task/phase').map(record => record.phase))
      .toEqual(['understand', 'map', 'plan', 'contract', 'implement', 'local-verify', 'regression', 'complete'])
    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
  })
})
