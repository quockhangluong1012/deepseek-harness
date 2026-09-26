/**
 * The change contract at intake: the resolution that refuses a declared
 * boundary which could never decide anything, and the durable record a later
 * reader reconstructs the boundary the change was held to from.
 *
 * @module @deepseek-ai/dsh-agent-kernel/tests/change-contract
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { resolveChangeContract } from '../src/change-contract.ts'
import type { ChangeContract } from '../src/types.ts'
import { eventsOf, makeAgent, rig } from './rig.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** One declared contract stating its goal, with no bound beyond the overrides. */
function contract(overrides: Partial<ChangeContract> = {}): ChangeContract {
  return {
    goal: 'extract the boundary check',
    expectedFiles: [],
    allowedFiles: [],
    mustPreserve: [],
    forbiddenChanges: [],
    expectedTests: [],
    ...overrides,
  }
}

describe('change contract resolution', () => {
  it('reads the absence of a declaration as no contract', () => {
    expect(resolveChangeContract(undefined)).toBeUndefined()
  })

  it('accepts a contract that states its goal and its bounds', () => {
    const declared = contract({ allowedFiles: ['src/**'] })
    expect(resolveChangeContract(declared)).toBe(declared)
  })

  it('refuses a contract that does not state its goal', () => {
    expect(() => resolveChangeContract(contract({ goal: '   ' }))).toThrow(/a change contract states its goal/)
  })

  it('refuses a blank glob, naming the field that declares it', () => {
    expect(() => resolveChangeContract(contract({ mustPreserve: ['  '] }))).toThrow(/blank mustPreserve glob/)
    expect(() => resolveChangeContract(contract({ expectedTests: [''] }))).toThrow(/blank expectedTests glob/)
  })
})

describe('the recorded contract', () => {
  it('records the declared contract on the task and in the session log', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx, process.cwd())
    const declared = contract({ expectedFiles: ['src/a.ts'], allowedFiles: ['src/**'] })

    const task = kernel.intake(agent, {
      objective: 'extract the boundary check',
      agentProfile: 'default',
      changeContract: declared,
    })

    expect(task.changeContract).toEqual(declared)
    expect(eventsOf(agent, 'task/created')[0]?.changeContract).toEqual(declared)
  })

  it('records no contract for a task that declares none', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx, process.cwd())

    const task = kernel.intake(agent, { objective: 'answer a question', agentProfile: 'default' })

    expect(task.changeContract).toBeUndefined()
    expect(eventsOf(agent, 'task/created')[0]).not.toHaveProperty('changeContract')
  })

  it('refuses an unusable contract before recording the task', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx, process.cwd())

    expect(() => kernel.intake(agent, {
      objective: 'bound nothing',
      agentProfile: 'default',
      changeContract: contract({ allowedFiles: [''] }),
    })).toThrow(/blank allowedFiles glob/)
    expect(eventsOf(agent, 'task/created')).toEqual([])
  })
})
