/**
 * S2's context source registry: a registered producer's items are placed
 * alongside the assembly, S1 point 3's delta placement surfaces an item once
 * per session until compaction clears it, and the disposer unregisters.
 */
import { describe, expect, it } from 'vitest'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
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

  it('surfaces a delta item again once compaction clears the session', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    service.register(
      { producer: 'evidence', kind: 'evidence', trust: 'trusted', placement: 'delta', maxBytes: 1000 },
      async () => [{ id: 'e1', text: 'the build failed on main.ts', relevance: 1 }],
    )
    const empty = { sections: [], contexts: [] }

    const first = await service.compile(agent, empty)
    agent.session.append('compaction/end', { compactionId: 'c1', turn: null })
    const second = await service.compile(agent, empty)

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

    const compiled = await service.compile(agent, { sections: [], contexts: [] })

    const placed = compiled.included.find(entry => entry.source.id === 'notes:n1')
    expect(placed?.source.content).toBe('far t')
  })
})
