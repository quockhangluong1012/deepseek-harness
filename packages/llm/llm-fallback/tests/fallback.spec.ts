import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, RetryPolicyConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as fallback from '../src/index.ts'
import type { LlmFallbackEventData } from '../src/types.ts'

type ScriptEntry = Error | Iterable<StreamChunk> | AsyncIterable<StreamChunk>

it('keeps the fallback payload identical to the session event', () => {
  expectTypeOf<LlmFallbackEventData>().toEqualTypeOf<SessionEventMap['llm/fallback']>()
})

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private retryPolicies: Readonly<Record<string, ResolvedRetryPolicy | undefined>> = {}

  constructor(private readonly entries: ScriptEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.entries.shift()
    if (entry === undefined) throw new Error('fallback test script exhausted')
    if (entry instanceof Error) throw entry
    yield* entry
  }

  configureRetryPolicies(
    policies: Readonly<Record<string, RetryPolicyConfig | undefined>>,
  ): void {
    this.retryPolicies = Object.fromEntries(Object.entries(policies).map(([provider, policy]) => [
      provider,
      policy === undefined
        ? undefined
        : resolveRetryPolicy(policy, `fallback test provider "${provider}" retryPolicy`),
    ]))
  }

  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    return this.retryPolicies[provider]
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

async function harness(
  adapter: ScriptedAdapter,
  config: Parameters<typeof fallback.apply>[1] = {},
  beforeFallback?: (ctx: Context) => void | Promise<void>,
  withRetry = false,
): Promise<{ ctx: Context; fallbackFiber: Fiber; disposeAdapter: () => void }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await beforeFallback?.(ctx)
  const fallbackFiber = await ctx.plugin(Object.assign((inner: Context) => {
    fallback.apply(inner, config)
  }, { inject: fallback.inject }))
  if (withRetry) {
    const retryNamespace = await import('@deepseek-ai/dsh-llm-retry')
    await ctx.plugin(retryNamespace)
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  const disposeAdapter = ctx.llm.registerAdapter(['mock', 'other', 'third'], adapter)
  return { ctx, fallbackFiber, disposeAdapter }
}

function waitForFallback(ctx: Context, agent: Agent): Promise<Extract<import('@deepseek-ai/dsh-session').SessionEvent, { type: 'llm/fallback' }>> {
  return new Promise((resolve) => {
    const dispose = ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'llm/fallback') {
        dispose()
        resolve(event)
      }
    })
  })
}

let context: Context | undefined

afterEach(async () => {
  vi.useRealTimers()
  await context?.fiber.dispose()
  context = undefined
})

describe('llm-fallback', () => {
  it('resolves defaults and copies routes', () => {
    expect(fallback.resolveConfig({})).toEqual({
      fallbackRoutes: [],
      failureThreshold: 3,
      coolMs: 60000,
      eligibleCodes: undefined,
    })
    const routes = [{ provider: 'other', model: 'other-model' }]
    const resolved = fallback.resolveConfig({ fallbackRoutes: routes, eligibleCodes: ['AUTH'] })
    expect(resolved.fallbackRoutes).toEqual(routes)
    expect(resolved.fallbackRoutes).not.toBe(routes)
  })

  it('rejects invalid deployment choices loudly', () => {
    expect(() => fallback.resolveConfig({ fallbackRoutes: [{ provider: '', model: 'm' }] }))
      .toThrow('non-empty provider and model')
    expect(() => fallback.resolveConfig({ fallbackRoutes: [{ provider: 'p', model: '' }] }))
      .toThrow('non-empty provider and model')
    expect(() => fallback.resolveConfig({ breaker: { failureThreshold: 0 } }))
      .toThrow('positive integer')
    expect(() => fallback.resolveConfig({ breaker: { failureThreshold: 1.5 } }))
      .toThrow('positive integer')
    expect(() => fallback.resolveConfig({ breaker: { coolMs: -1 } }))
      .toThrow('non-negative number')
    expect(() => fallback.resolveConfig({ breaker: { coolMs: Number.NaN } }))
      .toThrow('non-negative number')
  })

  it('switches provider on a declined failure and logs the event', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('bad key', 'AUTH'),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      fallbackRoutes: [{ provider: 'other', model: 'other-model' }],
      eligibleCodes: ['AUTH'],
    }))
    const agent = await context.agentLoop.create(SessionId('fallback-switch'), {
      provider: 'mock',
      model: 'mock',
    })
    const switched = waitForFallback(context, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    const event = await switched
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
    expect(event.data).toMatchObject({
      turn: 1,
      step: 1,
      fromProvider: 'mock',
      toProvider: 'other',
      toModel: 'other-model',
      failure: { message: 'bad key', code: 'AUTH' },
      attempt: 1,
    })
    expect(typeof event.data.fallbackId).toBe('string')
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')).toHaveLength(1)
  })

  it('preserves a downstream retry without switching', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('busy', 'SERVER'),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      fallbackRoutes: [{ provider: 'other', model: 'other-model' }],
    }, async () => {
      adapter.configureRetryPolicies({
        mock: {
          mode: 'normal',
          maxRetries: 2,
          retryableCodes: ['SERVER'],
          backoff: { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
        },
      })
    }, true))
    const agent = await context.agentLoop.create(SessionId('fallback-retry-wins'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'mock'])
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')).toHaveLength(0)
  })

  it('declines ineligible codes terminally', async () => {
    const adapter = new ScriptedAdapter([new LlmError('busy', 'SERVER')])
    ;({ ctx: context } = await harness(adapter, {
      fallbackRoutes: [{ provider: 'other', model: 'other-model' }],
      eligibleCodes: ['AUTH'],
    }))
    const agent = await context.agentLoop.create(SessionId('fallback-ineligible'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')).toHaveLength(0)
  })

  it('stays inert without routes', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    ;({ ctx: context } = await harness(adapter))
    const agent = await context.agentLoop.create(SessionId('fallback-inert'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')).toHaveLength(0)
  })

  it('opens failing routes and lets them cool back in', async () => {
    vi.useFakeTimers()
    const adapter = new ScriptedAdapter([
      new LlmError('mock down', 'AUTH'),
      new LlmError('other down', 'AUTH'),
      textResponse('via third'),
      new LlmError('third down', 'AUTH'),
      new LlmError('third down', 'AUTH'),
      textResponse('via other once more'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      fallbackRoutes: [
        { provider: 'other', model: 'other-model' },
        { provider: 'third', model: 'third-model' },
      ],
      breaker: { failureThreshold: 1, coolMs: 1000 },
    }))
    const agent = await context.agentLoop.create(SessionId('fallback-breaker'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'third'])
    const firstEvents = agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')
    expect(firstEvents).toHaveLength(2)
    expect(firstEvents[0]?.data).toMatchObject({ attempt: 1, toProvider: 'other' })
    expect(firstEvents[1]?.data).toMatchObject({ attempt: 2, toProvider: 'third' })
    expect(firstEvents[0]?.data.fallbackId).toBe(firstEvents[1]?.data.fallbackId)

    // The route persists into the next turn, where every alternative is still
    // open: the failure stays terminal with no new event.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'third', 'third'])
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(1001)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'third' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other', 'third', 'third', 'third', 'other'])
    const allEvents = agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')
    expect(allEvents).toHaveLength(3)
    expect(allEvents[2]?.data).toMatchObject({ attempt: 1, toProvider: 'other' })
  })

  it('rotates keys through the hook and survives hook failure', async () => {
    const rotated: { provider: string; code: string }[] = []
    const adapter = new ScriptedAdapter([
      new LlmError('bad key', 'AUTH'),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      fallbackRoutes: [{ provider: 'other', model: 'other-model' }],
    }))
    context.provide('llmFallbackKeyRotation', async (route, failure) => {
      rotated.push({ provider: route.provider, code: failure.code })
    })
    const agent = await context.agentLoop.create(SessionId('fallback-rotation'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(rotated).toEqual([{ provider: 'other', code: 'AUTH' }])
    expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
  })

  it('warns and still switches when rotation throws', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('bad key', 'AUTH'),
      textResponse('recovered'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      fallbackRoutes: [{ provider: 'other', model: 'other-model' }],
    }))
    context.provide('llmFallbackKeyRotation', () => {
      throw new Error('rotation exploded')
    })
    const warn = vi.spyOn(context.logger, 'warn')
    try {
      const agent = await context.agentLoop.create(SessionId('fallback-rotation-fails'), {
        provider: 'mock',
        model: 'mock',
      })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.requests.map(request => request.provider)).toEqual(['mock', 'other'])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('key rotation'))
    } finally {
      warn.mockRestore()
    }
  })

  it('lets turn cancellation win without switching', async () => {
    const adapter = new ScriptedAdapter([
      new LlmError('bad key', 'AUTH'),
      textResponse('must not run'),
    ])
    ;({ ctx: context } = await harness(adapter, {
      fallbackRoutes: [{ provider: 'other', model: 'other-model' }],
    }))
    const agent = await context.agentLoop.create(SessionId('fallback-cancel'), {
      provider: 'mock',
      model: 'mock',
    })
    const stop = context.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'assistant/attempt') agent.cancel({ kind: 'user' })
    })
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    } finally {
      stop()
    }

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')).toHaveLength(0)
  })

  it('ignores stale recovery callbacks after disposal', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    let captured: ((payload: never, next: () => Promise<RequestErrorAction>) => Promise<RequestErrorAction>) | undefined
    ;({ ctx: context } = await harness(adapter, {
      fallbackRoutes: [{ provider: 'other', model: 'other-model' }],
    }, (ctx) => {
      const originalOn = ctx.on.bind(ctx)
      ctx.on = function (this: Context, event: string, ...args: never[]) {
        const disposer = (originalOn as (...call: [string, ...never[]]) => () => void)(event, ...args)
        if (event === 'agent/request-error') {
          captured = args[0]
        }
        return disposer
      } as typeof ctx.on
    }))
    await context.fiber.dispose()
    if (captured === undefined) throw new Error('expected a captured recovery listener')
    await expect(captured(
      { signal: new AbortController().signal } as never,
      () => Promise.resolve(undefined),
    )).resolves.toBeUndefined()
  })

  it('stops recovering after plugin disposal', async () => {
    const adapter = new ScriptedAdapter([new LlmError('bad key', 'AUTH')])
    const mounted = await harness(adapter, {
      fallbackRoutes: [{ provider: 'other', model: 'other-model' }],
    })
    ;({ ctx: context } = mounted)
    await mounted.fallbackFiber.dispose()
    const agent = await context.agentLoop.create(SessionId('fallback-disposed'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.snapshotEvents().filter(item => item.type === 'llm/fallback')).toHaveLength(0)
  })
})
