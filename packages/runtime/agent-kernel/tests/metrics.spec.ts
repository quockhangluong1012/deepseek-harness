/**
 * Kernel metrics: the counters one session's own events imply, including the
 * ones a single log cannot average.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { readKernelMetrics } from '../src/metrics.ts'
import {
  callTool,
  humanMessage,
  makeAgent,
  preStep,
  registerTool,
  rig,
  stopTurn,
} from './rig.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount a rig and remember it for teardown. */
async function mounted(config: Parameters<typeof rig>[0] = {}): Promise<Awaited<ReturnType<typeof rig>>> {
  const result = await rig(config)
  contexts.push(result.ctx)
  return result
}

/** A permission document allowing every action. */
const ALLOW_ALL = { defaults: { effect: 'allow' as const }, rules: [] }

describe('readKernelMetrics', () => {
  it('reports zeroes for a log with no kernel activity', async () => {
    const { ctx } = await mounted()
    const agent = await makeAgent(ctx)

    const metrics = readKernelMetrics(agent.session.snapshotEvents())

    expect(metrics).toMatchObject({
      tasksCreated: 0,
      verifications: 0,
      steps: 0,
      toolCalls: 0,
      actionsProposed: 0,
    })
    // Rates with no denominator are absent, never zero.
    expect(metrics.taskSuccessRate).toBeUndefined()
    expect(metrics.verificationPassRate).toBeUndefined()
  })

  it('counts a task, its step, and its committed action', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    kernel.capabilities.register({ tool: 'probe', capabilities: ['fs.read'], resources: () => 'workspace/a.ts' })
    await preStep(ctx, agent, [humanMessage('go')])
    // The loop, not the kernel, writes the step boundary this metric counts.
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })
    await callTool(ctx, 'probe', agent, 'metrics-call')

    const metrics = readKernelMetrics(agent.session.snapshotEvents())

    expect(metrics).toMatchObject({
      tasksCreated: 1,
      steps: 1,
      toolCalls: 0,
      actionsProposed: 1,
      actionsSucceeded: 1,
      actionsFailed: 0,
      actionsDenied: 0,
      unfinishedActions: 0,
      retriedActions: 0,
    })
  })

  it('counts a denied action separately from a failed one', async () => {
    const { ctx } = await mounted({ mode: 'enforce', policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'undeclared')
    await preStep(ctx, agent, [humanMessage('go')])
    await callTool(ctx, 'undeclared', agent, 'denied-call')

    const metrics = readKernelMetrics(agent.session.snapshotEvents())

    expect(metrics.policyDenied).toBe(1)
    expect(metrics.actionsDenied).toBe(1)
    expect(metrics.actionsFailed).toBe(0)
  })

  it('rates a task only over tasks that reached a terminal status', async () => {
    const { ctx, kernel } = await mounted({
      acceptance: [{ id: 'crit', description: 'the criterion passes', verifier: 'assertion', required: true }],
    })
    const agent = await makeAgent(ctx)
    kernel.verifiers.register({
      id: 'reports-fail',
      supports: () => true,
      verify: async (_request, criterion) => ({ result: { criterionId: criterion.id, status: 'fail', evidence: [] } }),
    })
    await preStep(ctx, agent, [humanMessage('do the work')])
    await stopTurn(ctx, agent)

    const metrics = readKernelMetrics(agent.session.snapshotEvents())

    expect(metrics.verifications).toBe(1)
    expect(metrics.verificationsPassed).toBe(0)
    expect(metrics.verificationPassRate).toBe(0)
    // The task is paused, not terminal: it contributes no outcome and no rate.
    expect(metrics.taskOutcomes).toEqual({})
    expect(metrics.taskSuccessRate).toBeUndefined()
    expect(metrics.failuresByKind['verification-failed']).toBe(1)
    expect(metrics.recoveryByAction.diagnose).toBe(1)
    expect(metrics.failuresWithoutRecovery).toBe(0)
  })

  it('counts checkpoints and their resumes', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])
    kernel.checkpoint(agent, 'turn-boundary')

    const metrics = readKernelMetrics(agent.session.snapshotEvents())

    expect(metrics.checkpoints).toBe(1)
    expect(metrics.checkpointResumes).toBe(0)
  })

  it('counts a retried action once as retried, and its attempts as proposals', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    let attempts = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'flaky',
      description: 'fails once',
      parameters: {},
      async execute() {
        attempts += 1
        if (attempts === 1) throw new Error('transient')
        return [{ type: 'text' as const, text: 'ok' }]
      },
    }))
    kernel.capabilities.register({ tool: 'flaky', capabilities: ['fs.read'], resources: () => 'workspace/a.ts' })
    await preStep(ctx, agent, [humanMessage('go')])
    await callTool(ctx, 'flaky', agent, 'retry-call')
    await callTool(ctx, 'flaky', agent, 'retry-call')

    const metrics = readKernelMetrics(agent.session.snapshotEvents())

    // A retry keeps the failed attempt's action id, so the receipt is the
    // settled one: the attempts show up as proposals and as a retried action.
    expect(metrics.actionsProposed).toBe(2)
    expect(metrics.retriedActions).toBe(1)
    expect(metrics.actionsSucceeded).toBe(1)
    expect(metrics.actionsFailed).toBe(0)
  })
})
