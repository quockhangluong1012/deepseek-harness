/**
 * Pre-step `form: 'snapshot'` injections: one producer's newest snapshot
 * supersedes its previous one on the surface while the log keeps every
 * injection. Drives the real loop, so the assertions read the surface and the
 * request the model actually received.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop, { restoreSnapshotSlots, SnapshotInjectionProjection, snapshotSlot } from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** One producer's superseding snapshot message. */
function snapshot(text: string, plugin = 'time-context'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin, form: 'snapshot', sections: [{ name: plugin, text }], supersedes: true },
  })
}

/** One producer's accumulating snapshot message: a reading per step. */
function reading(text: string, plugin = 'time-context'): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin, form: 'snapshot', sections: [{ name: plugin, text }] },
  })
}

/** Every user-message text a request carried. */
function requestTexts(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? []).flatMap(message =>
    message.role === 'user'
      ? message.content.flatMap(block => block.type === 'text' ? [block.text] : [])
      : [])
}

describe('pre-step snapshot injections', () => {
  it('supersedes a producer\u2019s earlier snapshot on the surface and keeps it in the log', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('snap-replace'), { provider: 'mock', model: 'mock' })
    let reading = 'first reading'
    ctx.on('agent/pre-step', ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      return next().then(decision => decision.kind === 'enter'
        ? { ...decision, messages: [...decision.messages, snapshot(reading)] }
        : decision)
    })

    send(agent, 'prompt one')
    await waitForIdle(ctx, agent)
    reading = 'second reading'
    send(agent, 'prompt two')
    await waitForIdle(ctx, agent)

    const logged = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(logged.map(event => event.type === 'user/message' && event.data.content[0]?.type === 'text' ? event.data.content[0].text : ''))
      .toEqual(['prompt one', 'first reading', 'prompt two', 'second reading'])
    // The surface carries the live reading; the superseded one is a log record.
    const readings = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.content[0]?.type === 'text'
      && (event.data.content[0].text === 'first reading' || event.data.content[0].text === 'second reading'))
    expect(readings).toHaveLength(2)
    expect(agent.session.surface.nodes).toContain(readings[1]?.seq)
    expect(agent.session.surface.nodes).not.toContain(readings[0]?.seq)
    const framed = requestTexts(adapter.requests.at(-1))
    expect(framed).toContain('second reading')
    expect(framed).not.toContain('first reading')
    const derived = agent.session.deriveMessages().filter(message => message.role === 'user').map(message =>
      message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
    expect(derived).toContain('second reading')
    expect(derived).not.toContain('first reading')
  })

  it('appends a snapshot that declares no supersede, keeping every reading', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('snap-readings'), { provider: 'mock', model: 'mock' })
    let moment = 'reading one'
    ctx.on('agent/pre-step', ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      return next().then(decision => decision.kind === 'enter'
        ? { ...decision, messages: [...decision.messages, reading(moment)] }
        : decision)
    })

    send(agent, 'prompt one')
    await waitForIdle(ctx, agent)
    moment = 'reading two'
    send(agent, 'prompt two')
    await waitForIdle(ctx, agent)

    const framed = requestTexts(adapter.requests.at(-1))
    expect(framed).toContain('reading one')
    expect(framed).toContain('reading two')
  })

  it('replaces a snapshot committed before this agent attached', async () => {
    const adapter = new MockAdapter([textResponse('one')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('snap-resume'), { provider: 'mock', model: 'mock' })
    // A previous process committed this brief; the restore scan must find it.
    agent.session.append('user/message', snapshot('earlier brief'), { surfaceOp: 'append' })
    ctx.on('agent/pre-step', ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      return next().then(decision => decision.kind === 'enter'
        ? { ...decision, messages: [...decision.messages, snapshot('resumed brief')] }
        : decision)
    })

    send(agent, 'prompt')
    await waitForIdle(ctx, agent)

    const logged = agent.session.snapshotEvents().filter(event => event.type === 'user/message'
      && event.data.content[0]?.type === 'text'
      && event.data.content[0].text === 'earlier brief')
    expect(logged).toHaveLength(1)
    expect(agent.session.surface.nodes).not.toContain(logged[0]?.seq)
    const framed = requestTexts(adapter.requests.at(-1))
    expect(framed).toContain('resumed brief')
    expect(framed).not.toContain('earlier brief')
  })

  it('appends again after another replacement shadowed the retained snapshot', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('snap-shadowed'), { provider: 'mock', model: 'mock' })
    let reading = 'slot one'
    ctx.on('agent/pre-step', ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      return next().then(decision => decision.kind === 'enter'
        ? { ...decision, messages: [...decision.messages, snapshot(reading)] }
        : decision)
    })

    send(agent, 'prompt one')
    await waitForIdle(ctx, agent)
    const retained = agent.session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.content[0]?.type === 'text' && event.data.content[0].text === 'slot one')
    expect(retained).toBeDefined()
    // Compaction-style replacement shadows the node the projection retained.
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: retained!.seq, endSeq: retained!.seq },
      sourceEventSeqs: [retained!.seq],
    })

    reading = 'slot two'
    send(agent, 'prompt two')
    await waitForIdle(ctx, agent)

    const framed = requestTexts(adapter.requests.at(-1))
    expect(adapter.requests).toHaveLength(2)
    expect(framed).toContain('slot two')
    expect(framed).not.toContain('slot one')
  })

  it('keeps snapshots from two producers apart and appends everything else', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('snap-slots'), { provider: 'mock', model: 'mock' })
    let clock = 'clock one'
    let panes = 'panes one'
    ctx.on('agent/pre-step', ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      return next().then(decision => decision.kind === 'enter'
        ? {
          ...decision,
          messages: [
            ...decision.messages,
            snapshot(clock, 'time-context'),
            snapshot(panes, 'tmux-context'),
            createUserMessage({ content: [{ type: 'text', text: 'plain context' }], source: { kind: 'plugin', plugin: 'plain' } }),
          ],
        }
        : decision)
    })

    send(agent, 'prompt one')
    await waitForIdle(ctx, agent)
    clock = 'clock two'
    panes = 'panes two'
    send(agent, 'prompt two')
    await waitForIdle(ctx, agent)

    const framed = requestTexts(adapter.requests.at(-1))
    expect(framed).toContain('clock two')
    expect(framed).toContain('panes two')
    expect(framed).not.toContain('clock one')
    expect(framed).not.toContain('panes one')
    // A message without the snapshot form is context, not a slot: both stay.
    expect(framed.filter(text => text === 'plain context')).toHaveLength(2)
  })
})

describe('snapshot slots', () => {
  it('keys a producer by plugin name or by source kind, and only when it supersedes', () => {
    expect(snapshotSlot({ kind: 'plugin', plugin: 'time-context' } as never)).toBeUndefined()
    expect(snapshotSlot({ kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [] } as never)).toBeUndefined()
    expect(snapshotSlot({
      kind: 'plugin', plugin: 'time-context', form: 'snapshot', sections: [], supersedes: true,
    } as never)).toBe('plugin:time-context')
    expect(snapshotSlot({
      kind: 'evolution-memory', form: 'snapshot', sections: [], supersedes: true,
    } as never)).toBe('kind:evolution-memory')
  })

  it('restores the newest live snapshot per producer and skips a shadowed one', async () => {
    const ctx = await restoreHarness()
    const session = ctx.sessions.create(SessionId('restore'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', snapshot('first brief'), { surfaceOp: 'append' })
    const shadowed = session.append('user/message', snapshot('shadowed brief'), { surfaceOp: 'append' })
    session.append('user/message', snapshot('second brief'), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq },
      sourceEventSeqs: [shadowed.seq],
    })
    // A producer whose only snapshot a replacement shadowed holds no slot.
    const dropped = session.append('user/message', snapshot('dropped', 'tmux-context'), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted again' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: dropped.seq, endSeq: dropped.seq },
      sourceEventSeqs: [dropped.seq],
    })

    const slots = restoreSnapshotSlots(session)
    expect([...slots.keys()].sort()).toEqual(['plugin:time-context'])
    expect(slots.get('plugin:time-context')).toBe(
      session.snapshotEvents().filter(event => event.type === 'user/message'
        && event.data.content[0]?.type === 'text'
        && event.data.content[0].text === 'second brief')[0]?.seq,
    )
  })

  it('ignores another session\u2019s events and a replacement that cites no source', async () => {
    const ctx = await restoreHarness()
    const session = ctx.sessions.create(SessionId('listening'))
    const other = ctx.sessions.create(SessionId('other'))
    const projection = new SnapshotInjectionProjection(ctx, session)
    session.append('user/message', snapshot('live'), { surfaceOp: 'append' })

    other.append('user/message', snapshot('elsewhere'), { surfaceOp: 'append' })
    expect(projection.intentFor(snapshot('next').source)).toMatchObject({ surfaceOp: { op: 'replace' } })

    // A replacement that cites nothing leaves the retained slot in place.
    const shadowed = session.snapshotEvents().find(event => event.type === 'user/message'
      && event.data.content[0]?.type === 'text' && event.data.content[0].text === 'live')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compacted' }],
      source: { kind: 'user' },
    }), {
      surfaceOp: { op: 'replace', startSeq: shadowed!.seq, endSeq: shadowed!.seq },
      sourceEventSeqs: [shadowed!.seq],
    })
    expect(projection.intentFor(snapshot('after').source)).toEqual({ surfaceOp: 'append' })
  })
})

/** A context with a session store only, for the projection's own unit tests. */
async function restoreHarness() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  return ctx
}
