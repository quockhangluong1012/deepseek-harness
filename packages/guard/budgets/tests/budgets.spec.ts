import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, KNOWN_SESSION_EVENT_TYPES, type Session, type SessionEvent, type SessionEventMap, type TurnEndReason } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as Budgets from '@deepseek-ai/dsh-budgets'
import type { Config } from '@deepseek-ai/dsh-budgets'
import '../src/types.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the per-turn budget guard: every ceiling (tool calls,
 * wall clock, measured tokens), the durable `budget/exceeded` record of a cut,
 * the human-input rule, turns the plugin never observed, and fail-loud config
 * validation — all driven through a real agent loop against a scripted mock
 * adapter (no network).
 */

/** A mounted harness plus the guard's own warning lines. */
interface Rig {
  ctx: Context
  /** Every `budgets:` warning the guard logged, in order. */
  warnings: string[]
  /** The mounted guard, when the harness mounted one. */
  guard: { dispose(): Promise<void> } | undefined
}

/** Boot the core spine, the token meter, and the loop; the guard mounts last unless the caller opts out. */
async function harness(config: Config = {}, mountGuard = true): Promise<Rig> {
  const ctx = new Context()
  const warnings: string[] = []
  // The built-in buffer exporter keeps the default INFO threshold, which drops
  // WARN records; this sink raises the threshold so the guard's warnings stay observable.
  ctx.logger.exporter({
    levels: { default: 2 },
    export: (message) => {
      const line = message.args[0]
      if (message.type === 'warn' && typeof line === 'string' && line.startsWith('budgets: ')) warnings.push(line)
    },
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(AgentLoop, { agents: [] })
  const guard = mountGuard ? await ctx.plugin(Budgets, config) : undefined
  ctx.tools.register(defineContentToolFixture({
    name: 'probe', description: 'p', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] },
  }))
  return { ctx, warnings, guard }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => { const d = ctx.on('agent/status', ({ agent: s, status: st }) => { if (s === agent && st === 'idle') { d(); resolve() } }) })
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
  it('completes the turn normally when every ceiling stays above the observed activity', async () => {
    const { ctx, warnings } = await harness({ maxTotalTokens: 1_000_000, maxToolCalls: 10, maxWallMs: 3_600_000 })
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
    expect(budgetExceededEvents(agent.session)).toEqual([
      { name: 'maxToolCalls', observed: 1, limit: 1, turn: 1, step: 2 },
    ])
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
    expect(budgetExceededEvents(agent.session)).toEqual([
      { name: 'maxWallMs', observed: 60_000, limit: 1_000, turn: 1, step: 2 },
    ])
    expect(warnings).toEqual([
      'budgets: agent "a1" turn 1: maxWallMs ceiling reached (observed 60000 >= limit 1000)',
    ])
  })
})

describe('maxTotalTokens', () => {
  it('blocks a turn whose measured request pressure reaches the token ceiling', async () => {
    const { ctx, warnings } = await harness({ maxTotalTokens: 1 })
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
    expect(budgetExceededEvents(agent.session)).toHaveLength(1)
    expect(budgetExceededEvents(agent.session)[0]).toMatchObject({ name: 'maxTotalTokens', limit: 1, turn: 1, step: 2 })
    expect(budgetExceededEvents(agent.session)[0]!.observed).toBeGreaterThanOrEqual(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^budgets: agent "a1" turn 1: maxTotalTokens ceiling reached \(observed \d+ >= limit 1\)$/)
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
    expect(exceeded).toEqual([{ name: 'maxToolCalls', observed: 1, limit: 1, turn: 1, step: 2 }])
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
      // turn 1 step 2 is rejected: the ceiling is reached and nothing is claimed
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
  /** A spine with the injected token meter, so the guard's load reaches `apply`. */
  async function spine(): Promise<Rig> {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(TokenMeter)
    return { ctx, warnings: [], guard: undefined }
  }

  it.each([
    ['a zero ceiling', { maxTotalTokens: 0 }],
    ['a negative ceiling', { maxToolCalls: -1 }],
    ['a NaN ceiling', { maxTotalTokens: Number.NaN }],
    ['an infinite ceiling', { maxWallMs: Number.POSITIVE_INFINITY }],
  ])('rejects %s at plugin load', async (_label, config) => {
    const { ctx } = await spine()
    await expect(Promise.resolve(ctx.plugin(Budgets, config))).rejects.toThrow(/must be a positive finite number/)
  })
})
