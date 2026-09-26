/**
 * S2's context source registry: a registered producer's items are placed
 * alongside the assembly, S1 point 3's delta placement surfaces an item once
 * per session until compaction clears it, and the disposer unregisters.
 */
import { describe, expect, it } from 'vitest'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session } from '@deepseek-ai/dsh-session'
import { eventsOf, makeAgent, rig } from './rig.ts'

describe('context source registry', () => {
  it('places a stable-core registration alongside the assembly', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    service.register(
      { producer: 'goal', kind: 'task', trust: 'trusted', placement: 'stable-core', maxBytes: 1000 },
      async () => [{ id: 'objective', text: 'ship the release', relevance: 1 }],
    )

    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const record = eventsOf(agent, 'context/compiled')[0]
    expect(record?.included.map(entry => entry.id)).toContain('goal:objective')
    expect(record?.included.find(entry => entry.id === 'goal:objective')?.retention).toBe('required')
  })

  it('surfaces a delta item once, then withholds it on the next compile', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    service.register(
      { producer: 'evidence', kind: 'evidence', trust: 'trusted', placement: 'delta', maxBytes: 1000 },
      async () => [{ id: 'e1', text: 'the build failed on main.ts', relevance: 1 }],
    )

    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const [first, second] = eventsOf(agent, 'context/compiled')
    expect(first?.included.map(entry => entry.id)).toContain('evidence:e1')
    expect(second?.included.map(entry => entry.id)).not.toContain('evidence:e1')
  })

  it('keeps a budget-omitted delta item eligible on the next compile', async () => {
    const { ctx, service } = await rig({ maxContextTokens: 0 })
    const agent = makeAgent(ctx)
    service.register(
      { producer: 'evidence', kind: 'evidence', trust: 'trusted', placement: 'delta', maxBytes: 1000 },
      () => Promise.resolve([{ id: 'e1', text: 'the build failed on main.ts', relevance: 1 }]),
    )

    const first = await service.compile(agent, { sections: [], contexts: [], tools: [], variables: {} })
    const second = await service.compile(agent, { sections: [], contexts: [], tools: [], variables: {} })

    expect(first.omitted).toContainEqual({ id: 'evidence:e1', reason: 'budget' })
    expect(second.omitted).toContainEqual({ id: 'evidence:e1', reason: 'budget' })
  })

  it('surfaces a delta item again once compaction clears the session', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    service.register(
      { producer: 'evidence', kind: 'evidence', trust: 'trusted', placement: 'delta', maxBytes: 1000 },
      async () => [{ id: 'e1', text: 'the build failed on main.ts', relevance: 1 }],
    )
    const empty = { sections: [], contexts: [], tools: [], variables: {} }

    const first = await service.compile(agent, empty)
    agent.session.append('compaction/end', { compactionId: CompactionId('c1'), turn: null })
    const second = await service.compile(agent, empty)
    const records = eventsOf(agent, 'context/compiled')
    expect(records).toHaveLength(2)
    expect(records[1]?.digest).toBe(records[0]?.digest)

    expect(first.included.map(entry => entry.source.id)).toContain('evidence:e1')
    expect(second.included.map(entry => entry.source.id)).toContain('evidence:e1')
  })

  it('never surfaces an item already past its expiry', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    service.register(
      { producer: 'reminder', kind: 'plan', trust: 'trusted', placement: 'tail-reminder', maxBytes: 1000 },
      async () => [{ id: 'stale', text: 'this expired', relevance: 1, expiresAt: '2000-01-01T00:00:00.000Z' }],
    )

    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const record = eventsOf(agent, 'context/compiled')[0]
    expect(record?.included.map(entry => entry.id)).not.toContain('reminder:stale')
  })

  it('stops placing a producer once its disposer runs', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    const dispose = service.register(
      { producer: 'goal', kind: 'task', trust: 'trusted', placement: 'stable-core', maxBytes: 1000 },
      async () => [{ id: 'objective', text: 'ship the release', relevance: 1 }],
    )
    dispose()

    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const record = eventsOf(agent, 'context/compiled')[0]
    expect(record?.included.map(entry => entry.id)).not.toContain('goal:objective')
  })

  it('truncates an item past the descriptor byte budget', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    service.register(
      { producer: 'notes', kind: 'memory', trust: 'trusted', placement: 'stable-core', maxBytes: 5 },
      async () => [{ id: 'n1', text: 'far too long a note', relevance: 1 }],
    )

    const compiled = await service.compile(agent, { sections: [], contexts: [], tools: [], variables: {} })

    const placed = compiled.included.find(entry => entry.source.id === 'notes:n1')
    expect(placed?.source.content).toBe('far t')
  })

  it('withholds a delta item after replaying its session in a new compiler', async () => {
    const first = await rig()
    const agent = makeAgent(first.ctx)
    const descriptor = { producer: 'evidence', kind: 'evidence' as const, trust: 'trusted' as const, placement: 'delta' as const, maxBytes: 1000 }
    first.service.register(descriptor, () => Promise.resolve([
      { id: 'e1', text: 'the build failed on main.ts', relevance: 1 },
    ]))
    const initial = await first.service.compile(agent, { sections: [], contexts: [], tools: [], variables: {} })
    const replayed = Session.create(agent.session.id, agent.session.snapshotEvents())

    const resumed = await rig()
    const resumedAgent = { ...makeAgent(resumed.ctx), id: replayed.id, session: replayed }
    resumed.service.register(descriptor, () => Promise.resolve([
      { id: 'e1', text: 'the build failed on main.ts', relevance: 1 },
    ]))
    const afterResume = await resumed.service.compile(resumedAgent, { sections: [], contexts: [], tools: [], variables: {} })

    expect(initial.included.map(entry => entry.source.id)).toContain('evidence:e1')
    expect(afterResume.included.map(entry => entry.source.id)).not.toContain('evidence:e1')
  })
})
