import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { AgentContextService } from '../src/index.ts'
import { admitStep, eventsOf, makeAgent, rig } from './rig.ts'

describe('recording one placement per assembly', () => {
  it('records the placement of every assembled contribution', async () => {
    const { ctx } = await rig()
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file.' })

    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const records = eventsOf(agent, 'context/compiled')
    expect(records).toHaveLength(1)
    expect(records[0]?.included.map(entry => entry.id)).toEqual(['harness:identity', 'tool:read'])
    expect(records[0]?.included.map(entry => entry.retention)).toEqual(['required', 'compressible'])
    expect(records[0]?.maxTokens).toBeNull()
    expect(records[0]?.compilerVersion).toBe('agent-context/1')
    expect(records[0]?.digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records one placement while the digest stays the same, and a second once it changes', async () => {
    const { ctx } = await rig()
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file.' })

    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(eventsOf(agent, 'context/compiled')).toHaveLength(1)

    ctx.systemPrompt.section({ name: 'tool:write', order: 1101, text: 'Write a file.' })
    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const records = eventsOf(agent, 'context/compiled')
    expect(records).toHaveLength(2)
    expect(records[1]?.digest).not.toBe(records[0]?.digest)
  })

  it('records nothing for an assembly that belongs to no agent', async () => {
    const { ctx } = await rig()
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file.' })

    await ctx.systemPrompt.assemble()

    expect(eventsOf(agent, 'context/compiled')).toEqual([])
  })

  it('adds the durable task facts when a kernel is mounted', async () => {
    const { ctx } = await rig({}, true)
    const agent = makeAgent(ctx)
    await admitStep(ctx, agent, 'fix the failing build')

    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    const record = eventsOf(agent, 'context/compiled').at(-1)
    expect(record?.included.map(entry => entry.id)).toEqual(['harness:identity', 'task:objective'])
    expect(record?.included[1]?.kind).toBe('task')
  })

  it('records a placement with no durable facts when no kernel is mounted', async () => {
    const { ctx } = await rig()
    const agent = makeAgent(ctx)
    await admitStep(ctx, agent, 'fix the failing build')

    const compiled = await ctx.agentContext.compile(agent, await ctx.systemPrompt.assemble())

    expect(compiled.included.map(entry => entry.source.id)).toEqual(['harness:identity'])
    expect(eventsOf(agent, 'context/compiled')).toHaveLength(1)
  })

  it('reports whether the latest successful placement included a source', async () => {
    const { ctx } = await rig()
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file.' })

    const isIncluded = Reflect.get(ctx.agentContext, 'isIncluded')
    expect(isIncluded).toBeTypeOf('function')
    if (typeof isIncluded !== 'function') return
    expect(isIncluded.call(ctx.agentContext, agent.session, 'tool:read')).toBe(false)
    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(isIncluded.call(ctx.agentContext, agent.session, 'tool:read')).toBe(true)
    expect(isIncluded.call(ctx.agentContext, agent.session, 'tool:missing')).toBe(false)
  })

  it('stops recording once the plugin is unloaded', async () => {
    const { ctx, fiber } = await rig()
    const agent = makeAgent(ctx)
    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(eventsOf(agent, 'context/compiled')).toHaveLength(1)

    await fiber.dispose()
    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    expect(eventsOf(agent, 'context/compiled')).toHaveLength(1)
  })

  it('records the ceiling a placement was fitted to', async () => {
    const { ctx } = await rig({ maxContextTokens: 1000 })
    const agent = makeAgent(ctx)

    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    expect(eventsOf(agent, 'context/compiled')[0]?.maxTokens).toBe(1000)
  })

  it('defaults a directly constructed service to shadow rather than apply', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    // No Loader, so no schema defaulting: the service resolves its own mode.
    const service = new AgentContextService(ctx, { maxContextTokens: 20 })
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:big', order: 1100, text: 'x'.repeat(400) })

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))

    expect(service).toBeInstanceOf(AgentContextService)
    expect(assembly.sections.map(section => section.name)).toContain('tool:big')
    expect(eventsOf(agent, 'context/compiled')[0])
      .toMatchObject({ maxTokens: 20, omitted: [{ id: 'tool:big', reason: 'budget' }] })
  })
})

describe('modes', () => {
  it('returns the assembly untouched in shadow mode', async () => {
    const { ctx } = await rig({ mode: 'shadow', maxContextTokens: 20 })
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:big', order: 1100, text: 'x'.repeat(400) })

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))

    expect(assembly.sections.map(section => section.name))
      .toEqual(['harness:identity', 'deployment:persona-prefix', 'tool:big', 'deployment:persona-suffix'])
    expect(eventsOf(agent, 'context/compiled')[0]?.omitted).toEqual([{ id: 'tool:big', reason: 'budget' }])
  })

  it('drops the cut sources in apply mode and keeps the required ones', async () => {
    const { ctx } = await rig({ mode: 'apply', maxContextTokens: 20 })
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:big', order: 1100, text: 'x'.repeat(400) })

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))

    expect(assembly.sections.map(section => section.name)).toEqual(['harness:identity'])
    expect(eventsOf(agent, 'context/compiled')[0]?.omitted).toEqual([{ id: 'tool:big', reason: 'budget' }])
  })

  it('drops the cut runtime contexts in apply mode', async () => {
    const { ctx } = await rig({ mode: 'apply', maxContextTokens: 20 })
    const agent = makeAgent(ctx)
    ctx.systemPrompt.context({ name: 'context:repo-notes', order: 200, text: 'y'.repeat(400) })

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(agent))

    expect(assembly.contexts).toEqual([])
    expect(eventsOf(agent, 'context/compiled')[0]?.omitted).toEqual([{ id: 'context:repo-notes', reason: 'budget' }])
  })
})

describe('budget hysteresis (S1 point 5)', () => {
  it('keeps a previously included source past the ceiling until a compaction boundary', async () => {
    const { ctx, service } = await rig({ maxContextTokens: 6 })
    const agent = makeAgent(ctx)
    let text = 'short'
    service.register(
      { producer: 'notes', kind: 'artifact', trust: 'trusted', placement: 'tail-reminder', maxBytes: 1000 },
      async () => [{ id: 'n1', text, relevance: 1 }],
    )

    const first = await service.compile(agent, { sections: [], contexts: [] })
    expect(first.included.map(entry => entry.source.id)).toEqual(['notes:n1'])

    // Grows well past the 6-token ceiling; a fresh cut would drop it.
    text = 'this is a much longer note that no longer fits the same ceiling'
    const second = await service.compile(agent, { sections: [], contexts: [] })
    expect(second.included.map(entry => entry.source.id)).toEqual(['notes:n1'])

    agent.session.append('compaction/end', { compactionId: 'c1', turn: null })
    const third = await service.compile(agent, { sections: [], contexts: [] })
    expect(third.omitted).toContainEqual({ id: 'notes:n1', reason: 'budget' })
  })
})

describe('source-token totals and supersede count', () => {
  it('sums placed source tokens by kind, including a registered producer alongside the assembly', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file.' })
    service.register(
      { producer: 'goal', kind: 'task', trust: 'trusted', placement: 'stable-core', maxBytes: 1000 },
      async () => [{ id: 'objective', text: 'ship the release', relevance: 1 }],
    )

    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    const totals = service.tokenTotals(agent.session)

    // The registered producer's source is priced alongside the assembly's own
    // sections — its tokens are not silently missing from the model-visible
    // accounting just because it reached the model through its own injection
    // path rather than through `PromptAssembly`.
    expect(totals.byKind.tool).toBeGreaterThan(0)
    expect(totals.byKind.task).toBeGreaterThan(0)
    const record = eventsOf(agent, 'context/compiled')[0]
    expect(totals.byKind.task! + totals.byKind.tool!).toBeLessThanOrEqual(record!.tokenEstimate)
  })

  it('counts placements that superseded an earlier one, and reads zero before any compile', async () => {
    const { ctx, service } = await rig()
    const agent = makeAgent(ctx)
    expect(service.tokenTotals(agent.session)).toEqual({ byKind: {}, placementCount: 0 })

    ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file.' })
    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    // A repeated assemble with nothing changed keeps the same digest: it does
    // not supersede the placement already recorded.
    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(service.tokenTotals(agent.session).placementCount).toBe(1)

    ctx.systemPrompt.section({ name: 'tool:write', order: 1101, text: 'Write a file.' })
    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    expect(service.tokenTotals(agent.session).placementCount).toBe(2)
  })
})
