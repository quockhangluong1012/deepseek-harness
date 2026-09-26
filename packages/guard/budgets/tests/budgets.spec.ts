import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  SessionId,
  KNOWN_SESSION_EVENT_TYPES,
  type Session,
  type SessionEvent,
  type SessionEventMap,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as Budgets from '@deepseek-ai/dsh-budgets'
import type { Config } from '@deepseek-ai/dsh-budgets'
import '../src/types.ts'
import { CEILING_NAMES } from '../src/types.ts'
import type { CeilingName, CeilingState } from '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the budget guard: the counter, clock, billed-spend, and
 * context ceilings of every scope, the durable `budget/exceeded` record of a
 * cut, the human-input rule, turns and runs the plugin never observed, and
 * fail-loud config validation — all driven through a real agent loop against a
 * scripted mock adapter (no network). The mock's tool-call response bills ten
 * prompt tokens and five completion tokens.
 */

/** A mounted harness plus the guard's own warning lines. */
interface Rig {
  ctx: Context
  /** Every `budgets:` warning the guard logged, in order. */
  warnings: string[]
  /** The mounted guard, when the harness mounted one. */
  guard: { dispose(): Promise<void> } | undefined
}

/** Tokens one scripted tool-call response bills: ten prompt, five completion. */
const TOOL_TOKENS = 15

/** Boot the core spine, the token meter, and the loop; the guard mounts last unless the caller opts out. */
async function harness(config: Config = {}, mountGuard = true): Promise<Rig> {
  const ctx = new Context()
  const warnings: string[] = []
  // The built-in buffer exporter keeps the default INFO threshold, which drops
  // WARN records; this sink raises the threshold so the guard's warnings stay observable.
  ctx.logger.exporter({
    levels: { default: 2 },
    export: (message) => {
      const line: unknown = message.args[0]
      if (message.type === 'warn' && typeof line === 'string' && line.startsWith('budgets: ')) warnings.push(line)
    },
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  const guard = mountGuard ? await ctx.plugin(Budgets, config) : undefined
  // The probe declares its one parameter so every scripted call executes: the
  // parameter map is a closed object root, and an undeclared argument is
  // rejected before the tool runs — which would leave the clock hooks unfired.
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'p', parameters: { q: { type: 'number' } }, async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  return { ctx, warnings, guard }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve(undefined) } })
  return promise
}

/** Every durable turn-end reason in the agent's session, in log order. */
function turnEndReasons(agent: Agent): TurnEndReason[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'turn/end'> => event.type === 'turn/end')
    .map(event => event.data.reason)
}

/** Every `budget/exceeded` payload in one session, in log order. */
function budgetExceededEvents(session: Session): SessionEventMap['budget/exceeded'][] {
  return session.snapshotEvents()
    .filter((event): event is SessionEvent<'budget/exceeded'> => event.type === 'budget/exceeded')
    .map(event => event.data)
}

/** Every text fragment the model was sent, in request order. */
function sentTexts(adapter: MockAdapter): string[] {
  return adapter.requests.flatMap(request => request.messages.flatMap(message => message.content.map(block => block.type === 'text' ? block.text : '')))
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/**
 * Append the kernel's durable run marker. The guard reads run identity off the
 * log structurally, so this suite needs no kernel composition to open a run.
 */
function markRun(session: Session, runId: string): void {
  session.append('task/created', { metadata: { runId } } as never)
}

/** The ceiling state a record carries for one config: every axis the config leaves unset reads unbounded. */
function ceilingState(overrides: Partial<Record<CeilingName, CeilingState>>): Record<CeilingName, CeilingState> {
  const unbounded = Object.fromEntries(CEILING_NAMES.map(name => [name, 'unbounded'])) as Record<CeilingName, CeilingState>
  return { ...unbounded, ...overrides }
}

/** Boot the loop, a scripted tool-call turn, and one follow-up turn for the ceiling under test. */
async function cutTurn(config: Config, runId?: string): Promise<Rig & { adapter: MockAdapter; agent: Agent }> {
  const rig = await harness(config)
  const adapter = new MockAdapter([
    toolCallResponse('c1', 'probe', { q: 1 }),
    textResponse('done'),
  ])
  rig.ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await rig.ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
  if (runId !== undefined) markRun(agent.session, runId)
  followup(agent, 'go')
  await waitForIdle(rig.ctx, agent)
  return { ...rig, adapter, agent }
}

afterEach(() => { vi.useRealTimers() })

describe('ceilings off', () => {
  it('completes the turn and calls the model as scripted when no ceiling is configured', async () => {
    const { ctx, warnings } = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }])
    expect(warnings).toEqual([])
  })
})

describe('ceilings configured but not reached', () => {
  it('completes the turn normally when every ceiling of every scope stays above the observed activity', async () => {
    const { ctx, warnings } = await harness({
      maxInputTokens: 1_000,
      maxOutputTokens: 1_000,
      maxTotalTokens: 1_000,
      maxToolCalls: 10,
      maxWallMs: 3_600_000,
      maxSessionTokens: 1_000,
      maxSessionCost: 1_000,
      maxSessionWallTime: 3_600_000,
      maxRunTokens: 1_000,
      maxRunCost: 1_000,
      maxRunWallTime: 3_600_000,
      maxContextTokens: 1_000_000,
      maxCostUsd: 1_000,
      usdPerMillionTokens: 10,
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    markRun(agent.session, 'run-1')
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(3)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }])
    expect(budgetExceededEvents(agent.session)).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe('maxToolCalls', () => {
  it('blocks the turn at the ceiling and never calls the model again', async () => {
    const { ctx, warnings } = await harness({ maxToolCalls: 1 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'blocked' }])
    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'turn',
      name: 'maxToolCalls',
      observed: 1,
      limit: 1,
      ceilings: ceilingState({ maxToolCalls: 1 }),
      turn: 1,
      step: 2,
    }])
    expect(warnings).toEqual([
      'budgets: agent "a1" turn 1: maxToolCalls ceiling reached (observed 1 >= limit 1)',
    ])
  })
})

describe('maxWallMs', () => {
  it('blocks a turn that overruns its wall-clock ceiling', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    const { ctx, warnings } = await harness({ maxWallMs: 1_000 })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      vi.setSystemTime(Date.now() + 60_000)
      return next()
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'blocked' }])
    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'turn',
      name: 'maxWallMs',
      observed: 60_000,
      limit: 1_000,
      ceilings: ceilingState({ maxWallMs: 1_000 }),
      turn: 1,
      step: 2,
    }])
    expect(warnings).toEqual([
      'budgets: agent "a1" turn 1: maxWallMs ceiling reached (observed 60000 >= limit 1000)',
    ])
  })
})

describe('turn spend ceilings', () => {
  it('cuts a turn at the billed-token ceiling while context pressure stays under its own', async () => {
    // One scripted tool call bills ten prompt and five completion tokens, so the
    // second step is already over a fifteen-token ceiling; the context
    // measurement is orders of magnitude below its own ceiling, which is what
    // keeps the two axes apart.
    const { adapter, agent, warnings } = await cutTurn({ maxTotalTokens: TOOL_TOKENS, maxContextTokens: 1_000_000 })

    expect(adapter.requests).toHaveLength(1)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'blocked' }])
    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'turn',
      name: 'maxTotalTokens',
      observed: TOOL_TOKENS,
      limit: TOOL_TOKENS,
      ceilings: ceilingState({ maxTotalTokens: TOOL_TOKENS, maxContextTokens: 1_000_000 }),
      turn: 1,
      step: 2,
    }])
    expect(warnings).toEqual([
      'budgets: agent "a1" turn 1: maxTotalTokens ceiling reached (observed 15 >= limit 15)',
    ])
  })

  it.each([
    ['maxInputTokens', 10],
    ['maxOutputTokens', 5],
  ] as const)('cuts a turn at its %s ceiling', async (name, limit) => {
    const { agent } = await cutTurn({ [name]: limit, maxContextTokens: 1_000_000 })

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'turn',
      name,
      observed: limit,
      limit,
      ceilings: ceilingState({ [name]: limit, maxContextTokens: 1_000_000 }),
      turn: 1,
      step: 2,
    }])
  })

  it('cuts a turn at its priced spend ceiling', async () => {
    // One million USD per million billed tokens prices each token at one USD, so
    // the first scripted response already reaches a one-USD ceiling.
    const { agent } = await cutTurn({ maxCostUsd: 1, usdPerMillionTokens: 1_000_000 })

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'turn',
      name: 'maxCostUsd',
      observed: TOOL_TOKENS,
      limit: 1,
      ceilings: ceilingState({ maxCostUsd: 1 }),
      turn: 1,
      step: 2,
    }])
  })

  it('leaves a priced turn alone when no cost ceiling is configured', async () => {
    // A token ceiling the turn never reaches still walks past the priced axes
    // with no cost ceiling set.
    const { ctx, warnings } = await harness({ usdPerMillionTokens: 10, maxTotalTokens: 1_000_000 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }])
    expect(budgetExceededEvents(agent.session)).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe('session ceilings', () => {
  it('cuts a turn at the session token ceiling the turn itself billed past', async () => {
    const { agent, warnings } = await cutTurn({ maxSessionTokens: TOOL_TOKENS })

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'session',
      name: 'maxSessionTokens',
      observed: TOOL_TOKENS,
      limit: TOOL_TOKENS,
      ceilings: ceilingState({ maxSessionTokens: TOOL_TOKENS }),
      turn: 1,
      step: 2,
    }])
    expect(warnings).toEqual([
      'budgets: agent "a1" session: maxSessionTokens ceiling reached (observed 15 >= limit 15)',
    ])
  })

  it('cuts a turn at the session cost ceiling', async () => {
    const { agent } = await cutTurn({ maxSessionCost: 1, usdPerMillionTokens: 1_000_000 })

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'session',
      name: 'maxSessionCost',
      observed: TOOL_TOKENS,
      limit: 1,
      ceilings: ceilingState({ maxSessionCost: 1 }),
      turn: 1,
      step: 2,
    }])
  })

  it('cuts a turn at the session wall-clock ceiling measured from session creation', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    const { ctx } = await harness({ maxSessionWallTime: 1_000 })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      vi.setSystemTime(Date.now() + 60_000)
      return next()
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'session',
      name: 'maxSessionWallTime',
      observed: 60_000,
      limit: 1_000,
      ceilings: ceilingState({ maxSessionWallTime: 1_000 }),
      turn: 1,
      step: 2,
    }])
  })
})

describe('run ceilings', () => {
  it('cuts a turn at the run token ceiling and names the run it belongs to', async () => {
    const { agent, warnings } = await cutTurn({ maxRunTokens: TOOL_TOKENS }, 'run-1')

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'run',
      name: 'maxRunTokens',
      observed: TOOL_TOKENS,
      limit: TOOL_TOKENS,
      ceilings: ceilingState({ maxRunTokens: TOOL_TOKENS }),
      turn: 1,
      step: 2,
      runId: 'run-1',
    }])
    expect(warnings).toEqual([
      'budgets: agent "a1" run "run-1": maxRunTokens ceiling reached (observed 15 >= limit 15)',
    ])
  })

  it('cuts a turn at the run cost ceiling', async () => {
    const { agent } = await cutTurn({ maxRunCost: 1, usdPerMillionTokens: 1_000_000 }, 'run-1')

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'run',
      name: 'maxRunCost',
      observed: TOOL_TOKENS,
      limit: 1,
      ceilings: ceilingState({ maxRunCost: 1 }),
      turn: 1,
      step: 2,
      runId: 'run-1',
    }])
  })

  it('cuts a turn at the run wall-clock ceiling measured from its marker', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
    const { ctx } = await harness({ maxRunWallTime: 1_000 })
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      vi.setSystemTime(Date.now() + 60_000)
      return next()
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    markRun(agent.session, 'run-1')
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'run',
      name: 'maxRunWallTime',
      observed: 60_000,
      limit: 1_000,
      ceilings: ceilingState({ maxRunWallTime: 1_000 }),
      turn: 1,
      step: 2,
      runId: 'run-1',
    }])
  })

  it('leaves run ceilings unmeasurable until a run marker appears', async () => {
    const { adapter, agent, warnings } = await cutTurn({ maxRunTokens: TOOL_TOKENS })

    expect(adapter.requests).toHaveLength(2)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }])
    expect(budgetExceededEvents(agent.session)).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe('maxContextTokens', () => {
  it('cuts a turn whose measured context pressure reaches the context ceiling', async () => {
    const { adapter, agent, warnings } = await cutTurn({ maxContextTokens: 1 })

    expect(adapter.requests).toHaveLength(1)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'blocked' }])
    const exceeded = budgetExceededEvents(agent.session)
    expect(exceeded).toHaveLength(1)
    expect(exceeded[0]).toMatchObject({ scope: 'context', name: 'maxContextTokens', limit: 1, turn: 1, step: 2 })
    expect(exceeded[0]?.observed).toBeGreaterThanOrEqual(1)
    expect(warnings[0]).toMatch(/^budgets: agent "a1" turn 1 context: maxContextTokens ceiling reached \(observed \d+ >= limit 1\)$/)
  })
})

describe('unpriced cost ceilings', () => {
  it('loads, warns once, records the axes as unmeasurable, and never cuts on them', async () => {
    // The harness owns no price source, so a cost ceiling without a deployment
    // price stays present and inert rather than failing the composition.
    const { ctx, warnings } = await harness({ maxCostUsd: 1, maxSessionCost: 1, maxRunCost: 1, maxToolCalls: 1 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(budgetExceededEvents(agent.session)).toEqual([{
      scope: 'turn',
      name: 'maxToolCalls',
      observed: 1,
      limit: 1,
      ceilings: ceilingState({
        maxCostUsd: 'unmeasurable',
        maxSessionCost: 'unmeasurable',
        maxRunCost: 'unmeasurable',
        maxToolCalls: 1,
      }),
      turn: 1,
      step: 2,
    }])
    expect(warnings).toEqual([
      'budgets: maxCostUsd, maxSessionCost, maxRunCost cannot be measured: the harness owns no price source, '
      + 'so set usdPerMillionTokens (USD per million billed tokens) or the cost ceilings stay inert',
      'budgets: agent "a1" turn 1: maxToolCalls ceiling reached (observed 1 >= limit 1)',
    ])
  })
})

describe('budget/exceeded durability', () => {
  it('records the cut once, before the blocked turn end, and replays as a required event', async () => {
    const { ctx } = await harness({ maxToolCalls: 1 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()
    const exceeded = budgetExceededEvents(agent.session)
    expect(exceeded).toEqual([{
      scope: 'turn',
      name: 'maxToolCalls',
      observed: 1,
      limit: 1,
      ceilings: ceilingState({ maxToolCalls: 1 }),
      turn: 1,
      step: 2,
    }])
    // The record lands immediately before the `blocked` end it explains.
    expect(events.findIndex(event => event.type === 'turn/end')).toBe(
      events.findIndex(event => event.type === 'budget/exceeded') + 1,
    )

    // Read-path admission runs off the regenerated known vocabulary; the writer
    // cannot mark the event ignorable, so membership is the only way a reader
    // accepts it instead of refusing the log.
    expect(KNOWN_SESSION_EVENT_TYPES.has('budget/exceeded')).toBe(true)
    expect(events.find(event => event.type === 'budget/exceeded')?.ignorable).toBeUndefined()

    // Persistence boundary: the log re-enters a fresh Session through the
    // documented seed (replay/restore) constructor, and the record survives
    // JSON re-materialization unchanged.
    const seed = JSON.parse(JSON.stringify(events)) as SessionEvent[]
    const restored = ctx.sessions.prepare(SessionId('a1-restored'), { seed })
    expect(budgetExceededEvents(restored)).toEqual(exceeded)
  })
})

describe('human input', () => {
  it('enters a step that claims a user message even when the ceiling is already reached', async () => {
    const { ctx, warnings } = await harness({ maxTotalTokens: 1 })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }), // turn 1 step 1: its claimed user message enters
      // turn 1 step 2 is rejected: the billing ceiling is reached and nothing is claimed
      textResponse('turn two answer'), // turn 2 step 1: the claimed user message enters again
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)
    followup(agent, 'again')
    await waitForIdle(ctx, agent)

    expect(turnEndReasons(agent)).toEqual([{ kind: 'blocked' }, { kind: 'completed' }])
    expect(adapter.requests).toHaveLength(2)
    expect(sentTexts(adapter)).toContain('go')
    expect(sentTexts(adapter)).toContain('again')
    expect(warnings).toHaveLength(1)
  })
})

describe('turns the plugin never observed', () => {
  it('never cuts a turn already open when the plugin loaded', async () => {
    const { ctx, warnings } = await harness({}, false)
    let mounted = false
    ctx.on('tools/post-execute', async (_exec, _result, next) => {
      if (!mounted) {
        mounted = true
        await ctx.plugin(Budgets, { maxToolCalls: 1 })
      }
      return next()
    })
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      toolCallResponse('c3', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    followup(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(4)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'completed' }])
    expect(warnings).toEqual([])
  })
})

describe('disposal', () => {
  it('stops cutting turns and observing events once the guard is disposed', async () => {
    const rig = await harness({ maxToolCalls: 1 })
    const { ctx, warnings } = rig
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', { q: 1 }),
      toolCallResponse('c2', 'probe', { q: 1 }),
      textResponse('cut here'),
      toolCallResponse('c3', 'probe', { q: 1 }),
      toolCallResponse('c4', 'probe', { q: 1 }),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(turnEndReasons(agent)).toEqual([{ kind: 'blocked' }])
    expect(warnings).toHaveLength(1)

    await rig.guard?.dispose()

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(turnEndReasons(agent)).toEqual([{ kind: 'blocked' }, { kind: 'completed' }])
    expect(warnings).toHaveLength(1)
  })
})

describe('config validation fails loud', () => {
  it.each([
    ['a zero turn ceiling', { maxTotalTokens: 0 }],
    ['a negative counter ceiling', { maxToolCalls: -1 }],
    ['a NaN turn ceiling', { maxTotalTokens: Number.NaN }],
    ['an infinite turn clock', { maxWallMs: Number.POSITIVE_INFINITY }],
    ['a zero session ceiling', { maxSessionTokens: 0 }],
    ['a negative session clock', { maxSessionWallTime: -1 }],
    ['a negative run ceiling', { maxRunCost: -2, usdPerMillionTokens: 1 }],
    ['a NaN context ceiling', { maxContextTokens: Number.NaN }],
    ['a free price', { usdPerMillionTokens: 0 }],
    ['a negative price', { usdPerMillionTokens: -5 }],
  ])('rejects %s at plugin load', async (_label, config) => {
    const { ctx } = await harness({}, false)
    await expect(Promise.resolve(ctx.plugin(Budgets, config))).rejects.toThrow(/must be a positive finite number/)
  })

  it('accepts a cost ceiling with no price and warns that it is unmeasurable', async () => {
    const { ctx, warnings } = await harness({}, false)
    await ctx.plugin(Budgets, { maxCostUsd: 1 })

    expect(warnings).toEqual([
      'budgets: maxCostUsd cannot be measured: the harness owns no price source, '
      + 'so set usdPerMillionTokens (USD per million billed tokens) or the cost ceilings stay inert',
    ])
  })
})
