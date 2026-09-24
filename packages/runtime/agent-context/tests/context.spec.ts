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
