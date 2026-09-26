/**
 * Plan-drift specs (§7.4): the tolerance the kernel compares the trailing run
 * of unmatched actions against, the escalation it records when the tolerance is
 * reached, and the load-time rejection of a tolerance no comparison could use.
 *
 * @module @deepseek-ai/dsh-agent-kernel/tests/plan-drift.spec
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/index.ts'
import type { Rig } from './rig.ts'
import { callTool, eventsOf, humanMessage, makeAgent, preStep, registerTool, rig } from './rig.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount a rig and remember it for teardown. */
async function mounted(config: Config = {}): Promise<Rig> {
  const result = await rig(config)
  contexts.push(result.ctx)
  return result
}

/** A permission document allowing every action. */
const ALLOW_ALL = { defaults: { effect: 'allow' as const }, rules: [] }

/** Open a task and record the plan every drift fixture compares observed actions against. */
async function taskWithPlan(ctx: Context, kernel: Rig['kernel']): Promise<Agent> {
  const agent = await makeAgent(ctx)
  await preStep(ctx, agent, [humanMessage('follow the plan')])
  kernel.recordPlan(agent, ['run the build'])
  registerTool(ctx, 'ls')
  registerTool(ctx, 'build')
  return agent
}

/**
 * Record one call to a fixture tool and settle it through the kernel's real
 * tool pipeline, which is where the drift check runs.
 * @param ctx - the owning context.
 * @param agent - the calling agent.
 * @param name - registered fixture tool; `ls` shares no meaningful token with the plan step, `build` does.
 * @param ordinal - distinguishes this call's identity from the earlier fixtures'.
 */
async function observe(ctx: Context, agent: Agent, name: 'ls' | 'build', ordinal: number): Promise<void> {
  const callId = `${name}-${String(ordinal)}`
  agent.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: ToolCallId(callId),
    name,
    arguments: '{}',
  })
  await callTool(ctx, name, agent, callId)
}

/** The plan-drift escalations one agent's log recorded, in log order. */
function drifts(agent: Agent) {
  return eventsOf(agent, 'failure/recorded').filter(failure => failure.kind === 'plan-drift')
}

describe('plan drift', () => {
  it('counts the trailing run only, so a matching action repairs the drift below the tolerance', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await taskWithPlan(ctx, kernel)

    await observe(ctx, agent, 'ls', 1)
    await observe(ctx, agent, 'ls', 2)
    // Two unmatched actions are still below the default tolerance of three.
    expect(drifts(agent)).toEqual([])

    // The trailing run is what counts: one action the plan names repairs it, so
    // the next unmatched actions start the run over.
    await observe(ctx, agent, 'build', 1)
    await observe(ctx, agent, 'ls', 3)
    await observe(ctx, agent, 'ls', 4)
    expect(drifts(agent)).toEqual([])

    await observe(ctx, agent, 'ls', 5)
    expect(drifts(agent)).toHaveLength(1)
    expect(drifts(agent)[0]?.detail).toContain('3 consecutive actions match no step of plan revision')
  })

  it('escalates once per episode, however many more actions keep drifting', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await taskWithPlan(ctx, kernel)

    for (let call = 1; call <= 3; call += 1) await observe(ctx, agent, 'ls', call)
    expect(drifts(agent)).toHaveLength(1)

    await observe(ctx, agent, 'ls', 4)
    await observe(ctx, agent, 'ls', 5)
    expect(drifts(agent)).toHaveLength(1)
  })

  it('moves the crossing point to the configured tolerance', async () => {
    const two = await mounted({ policy: ALLOW_ALL, planDriftTolerance: 2 })
    const agent = await taskWithPlan(two.ctx, two.kernel)

    await observe(two.ctx, agent, 'ls', 1)
    expect(drifts(agent)).toEqual([])

    await observe(two.ctx, agent, 'ls', 2)
    expect(drifts(agent)).toHaveLength(1)
    expect(drifts(agent)[0]?.detail).toContain('2 consecutive actions match no step of plan revision')
  })

  it('fails plugin load on a tolerance no trailing run could compare against', async () => {
    await expect(mounted({ planDriftTolerance: -1 })).rejects.toThrow('planDriftTolerance must be a non-negative integer')
    await expect(mounted({ planDriftTolerance: 1.5 })).rejects.toThrow('planDriftTolerance must be a non-negative integer')
  })
})
