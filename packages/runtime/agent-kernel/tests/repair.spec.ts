/**
 * The verification repair loop and its cost controls: the gate steers the agent
 * back into work while repairs remain, hands the decision to the user past the
 * cap, and skips re-verification when nothing changed since a pass.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { AgentKernelService } from '../src/index.ts'
import type { AcceptanceCriterion, CriterionResult } from '../src/types.ts'
import { eventsOf, humanMessage, makeAgent, preStep, rig, stopTurn } from './rig.ts'

/** One required criterion of the `assertion` family. */
function criterion(id: string): AcceptanceCriterion {
  return { id, description: `${id} holds`, verifier: 'assertion', required: true }
}

/** Register a verifier that answers each attempt from `statuses`, last one sticky. */
function registerScriptedVerifier(kernel: AgentKernelService, statuses: readonly CriterionResult['status'][]): void {
  let attempts = 0
  kernel.verifiers.register({
    id: 'scripted',
    supports: () => true,
    verify: async (_request, subject) => {
      const status = statuses[Math.min(attempts, statuses.length - 1)] ?? 'fail'
      attempts += 1
      return { result: { criterionId: subject.id, status, evidence: [] } }
    },
  })
}

/** Capture every steering message the kernel sends. */
function captureSteers(agent: Agent): string[] {
  const steered: string[] = []
  agent.steer = (message) => {
    steered.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  }
  return steered
}

describe('verification repair loop', () => {
  it('steers back into work while repairs remain, then asks the user', async () => {
    const { ctx, kernel } = await rig({ acceptance: [criterion('build')], maxRepairAttempts: 2 })
    registerScriptedVerifier(kernel, ['fail'])
    const agent = await makeAgent(ctx)
    const steered = captureSteers(agent)

    await preStep(ctx, agent, [humanMessage('one')])
    await stopTurn(ctx, agent)
    expect(kernel.state.view(agent.session)?.task.status).toBe('recovering')
    expect(steered).toHaveLength(1)
    expect(steered[0]).toContain('Verification of this task failed. Repair the cause')
    expect(steered[0]).toContain('- verification reported fail')

    await preStep(ctx, agent, [humanMessage('two')], 2)
    await stopTurn(ctx, agent, 2)
    expect(kernel.state.view(agent.session)?.task.status).toBe('awaiting-user')
    expect(steered).toHaveLength(1)
  })

  it('completes the task when a repair makes the criterion pass', async () => {
    const { ctx, kernel } = await rig({ acceptance: [criterion('build')], maxRepairAttempts: 3 })
    registerScriptedVerifier(kernel, ['fail', 'pass'])
    const agent = await makeAgent(ctx)
    const steered = captureSteers(agent)

    await preStep(ctx, agent, [humanMessage('one')])
    await stopTurn(ctx, agent)
    expect(kernel.state.view(agent.session)?.task.status).toBe('recovering')

    await preStep(ctx, agent, [humanMessage('repaired')], 2)
    await stopTurn(ctx, agent, 2)

    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
    expect(steered).toHaveLength(1)
    expect(eventsOf(agent, 'verification/result').map(result => result.status)).toEqual(['fail', 'pass'])
  })

  it('skips verification when nothing changed since the last passing result', async () => {
    const { ctx, kernel } = await rig({ acceptance: [criterion('build')] })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('one')])
    const task = kernel.state.view(agent.session)?.task
    expect(task).toBeDefined()
    agent.session.append('verification/result', {
      taskId: task?.taskId,
      revision: task?.revision,
      status: 'pass',
      criterionResults: [],
      commands: [],
      verifierVersion: 'spec',
    } as SessionEventMap['verification/result'])

    await stopTurn(ctx, agent)

    expect(eventsOf(agent, 'verification/requested')).toHaveLength(0)
    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
  })
})
