import { describe, expect, it } from 'vitest'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { ContextCompilationRecord } from '../src/types.ts'
import { admitStep, eventsOf, makeAgent, rig } from './rig.ts'

/**
 * Compile one deterministic fixture: a fresh composition with one kernel task
 * and one tool section, assembled once.
 * @param objective - the human message that opens the task.
 * @returns the durable placement record.
 */
async function compileFixture(objective: string): Promise<ContextCompilationRecord> {
  const { ctx } = await rig({}, true)
  const agent = makeAgent(ctx)
  ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file from the workspace.' })
  await admitStep(ctx, agent, objective)
  await ctx.systemPrompt.assemble(assembleContextFor(agent))
  const record = eventsOf(agent, 'context/compiled').at(-1)
  if (record === undefined) throw new Error('spec: no placement recorded')
  return record
}

describe('replay', () => {
  it('reproduces the digest for the same fixture in a fresh composition', async () => {
    const first = await compileFixture('fix the failing build')
    const second = await compileFixture('fix the failing build')
    expect(second.digest).toBe(first.digest)
  })

  it('reproduces the digest when the same agent assembles again', async () => {
    const { ctx } = await rig({}, true)
    const agent = makeAgent(ctx)
    ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file from the workspace.' })
    await admitStep(ctx, agent, 'fix the failing build')

    await ctx.systemPrompt.assemble(assembleContextFor(agent))
    await ctx.systemPrompt.assemble(assembleContextFor(agent))

    // The second assembly compiles to the same digest, so the log keeps one
    // record: a repeat says nothing a reader could not already read.
    const records = eventsOf(agent, 'context/compiled')
    expect(records).toHaveLength(1)
    expect((await ctx.agentContext.compile(agent, await ctx.systemPrompt.assemble())).digest)
      .toBe(records[0]?.digest)
  })

  it('changes the digest when the task objective changes', async () => {
    const build = await compileFixture('fix the failing build')
    const docs = await compileFixture('write the release notes')
    expect(docs.included.map(entry => entry.id)).toEqual(build.included.map(entry => entry.id))
    expect(docs.digest).not.toBe(build.digest)
  })

  it('survives a durable JSON round trip unchanged', async () => {
    const record = await compileFixture('fix the failing build')
    expect(JSON.parse(JSON.stringify(record))).toEqual(record)
  })
})
