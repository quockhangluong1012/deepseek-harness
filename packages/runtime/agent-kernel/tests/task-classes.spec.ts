/**
 * Task boundaries and classes: a human message claimed while the current task
 * is terminal opens the next task, and the class decides which acceptance
 * criteria the task starts from and whether the completion gate demands one.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { eventsOf, humanMessage, makeAgent, preStep, registerTool, callTool, rig, stopTurn, transitions } from './rig.ts'
import type { AcceptanceCriterion } from '../src/types.ts'
import type { AgentKernelService } from '../src/index.ts'

/** A required criterion of the `assertion` family. */
function criterion(id: string): AcceptanceCriterion {
  return { id, description: `${id} holds`, verifier: 'assertion', required: true }
}

/** Register the verifier that reports the first criterion passing. */
function registerPassingVerifier(kernel: AgentKernelService): void {
  kernel.verifiers.register({
    id: 'always-pass',
    supports: () => true,
    verify: async (_request, subject) => ({ result: { criterionId: subject.id, status: 'pass', evidence: [] } }),
  })
}

/** Open one step and close its turn, so the task reaches a decision. */
async function runTurn(agent: Agent, ctx: Parameters<typeof preStep>[0], text: string, turn = 1): Promise<void> {
  await preStep(ctx, agent, [humanMessage(text)], turn)
  await stopTurn(ctx, agent, turn)
}

describe('task boundaries', () => {
  it('opens the next task when a human message arrives after a terminal one', async () => {
    const { ctx, kernel } = await rig({ acceptance: [criterion('reply')] })
    registerPassingVerifier(kernel)
    const agent = await makeAgent(ctx)
    await runTurn(agent, ctx, 'first request')
    const first = kernel.state.view(agent.session)?.task
    expect(first?.status).toBe('completed')

    await preStep(ctx, agent, [humanMessage('second request')], 2)

    const second = kernel.state.view(agent.session)?.task
    expect(second?.taskId).not.toBe(first?.taskId)
    expect(second).toMatchObject({ objective: 'second request', parentTaskId: first?.taskId, status: 'executing' })
    expect(eventsOf(agent, 'task/created')).toHaveLength(2)
  })

  it('keeps one task while the current one is still active', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('first request')])
    const first = kernel.state.view(agent.session)?.task

    await preStep(ctx, agent, [humanMessage('second request')], 1, 2)

    expect(kernel.state.view(agent.session)?.task.taskId).toBe(first?.taskId)
    expect(eventsOf(agent, 'task/created')).toHaveLength(1)
  })

  it('refuses a caller-supplied contract while the current task is active', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('first request')])

    expect(() => kernel.intake(agent, { objective: 'second', agentProfile: 'default' }))
      .toThrow('agent-kernel: task contract already exists for this session')
  })
})

describe('task classes', () => {
  it('takes the class the caller names, then the role, then the deployment default', async () => {
    const { ctx, kernel } = await rig({
      taskClass: 'operations',
      profiles: [{ id: 'worker', role: 'worker', capabilities: [], policyProfile: 'default', budget: {}, taskClass: 'research' }],
    })
    const explicit = await makeAgent(ctx)
    kernel.intake(explicit, { objective: 'explicit', agentProfile: 'default', taskClass: 'coding' })
    expect(kernel.state.view(explicit.session)?.task.taskClass).toBe('coding')

    const byRole = await makeAgent(ctx)
    kernel.intake(byRole, { objective: 'role', agentProfile: 'worker' })
    expect(kernel.state.view(byRole.session)?.task.taskClass).toBe('research')

    const byDefault = await makeAgent(ctx)
    kernel.intake(byDefault, { objective: 'default', agentProfile: 'default' })
    expect(kernel.state.view(byDefault.session)?.task.taskClass).toBe('operations')
  })

  it('reads a task that follows an authorized file mutation as coding work', async () => {
    const { ctx, kernel } = await rig({
      taskClass: 'conversational',
      acceptance: [criterion('reply')],
      policy: {
        defaults: { effect: 'allow' },
        rules: [{ action: 'write', resource: '**', effect: 'allow' }],
      },
    })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'write-file')
    kernel.capabilities.register({ tool: 'write-file', capabilities: ['fs.write'], resources: () => '**' })
    registerPassingVerifier(kernel)
    await runTurn(agent, ctx, 'edit the parser')
    await callTool(ctx, 'write-file', agent)

    await preStep(ctx, agent, [humanMessage('now fix the test')], 2)

    expect(kernel.state.view(agent.session)?.task.taskClass).toBe('coding')
  })

  it('starts a task from the criteria its class configures', async () => {
    const { ctx, kernel } = await rig({ acceptance: [criterion('reply')], acceptanceByClass: { coding: [criterion('tests-pass')] } })
    const coding = await makeAgent(ctx)
    kernel.intake(coding, { objective: 'code', agentProfile: 'default', taskClass: 'coding' })
    expect(kernel.state.view(coding.session)?.task.acceptance.map(item => item.id)).toEqual(['tests-pass'])

    const conversational = await makeAgent(ctx)
    kernel.intake(conversational, { objective: 'ask', agentProfile: 'default' })
    expect(kernel.state.view(conversational.session)?.task.acceptance.map(item => item.id)).toEqual(['reply'])
  })

  it('starts a task from the shipped criteria of its class when the deployment configures none', async () => {
    const { ctx, kernel } = await rig()
    const coding = await makeAgent(ctx)
    kernel.intake(coding, { objective: 'change the parser', agentProfile: 'default', taskClass: 'coding' })
    expect(kernel.state.view(coding.session)?.task.acceptance.map(item => [item.id, item.verifier, item.required]))
      .toEqual([
        ['typecheck', 'typecheck', true],
        ['lint', 'lint', true],
        ['test', 'test', true],
        ['diff', 'diff', true],
      ])

    const research = await makeAgent(ctx)
    kernel.intake(research, { objective: 'compare the options', agentProfile: 'default', taskClass: 'research' })
    expect(kernel.state.view(research.session)?.task.acceptance.map(item => item.id)).toEqual(['citations'])

    const conversational = await makeAgent(ctx)
    kernel.intake(conversational, { objective: 'what is the flag', agentProfile: 'default' })
    expect(kernel.state.view(conversational.session)?.task.acceptance).toEqual([])
  })

  it('gives a coding task its shipped criteria through the mutation heuristic', async () => {
    const { ctx, kernel } = await rig({
      policy: { defaults: { effect: 'allow' }, rules: [{ action: 'write', resource: '**', effect: 'allow' }] },
    })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'write-file')
    kernel.capabilities.register({ tool: 'write-file', capabilities: ['fs.write'], resources: () => '**' })
    await runTurn(agent, ctx, 'edit the parser')
    await callTool(ctx, 'write-file', agent)

    await preStep(ctx, agent, [humanMessage('now fix the test')], 2)

    // The conversation is about the repository now, so the next task is coding
    // work and starts from the shipped coding criteria.
    expect(kernel.state.view(agent.session)?.task.taskClass).toBe('coding')
    expect(kernel.state.view(agent.session)?.task.acceptance.map(item => item.id))
      .toEqual(['typecheck', 'lint', 'test', 'diff'])
  })

  it('refuses a configured class key that names no task class', async () => {
    await expect(rig({ acceptanceByClass: { codeing: [criterion('typo')] } } as never))
      .rejects.toThrow('acceptanceByClass names unknown task class "codeing"')
  })

  it('demands a criterion per class: a conversational task completes while a coding one keeps working', async () => {
    const { ctx, kernel } = await rig({
      acceptanceByClass: { conversational: [], coding: [] },
      requireAcceptanceCriteria: true,
      requireAcceptanceCriteriaByClass: { conversational: false },
    })
    const conversational = await makeAgent(ctx)
    kernel.intake(conversational, { objective: 'ask', agentProfile: 'default' })
    const coding = await makeAgent(ctx)
    kernel.intake(coding, { objective: 'code', agentProfile: 'default', taskClass: 'coding' })

    await runTurn(conversational, ctx, 'answer this')
    await runTurn(coding, ctx, 'change the code')

    expect(kernel.state.view(conversational.session)?.task.status).toBe('completed')
    expect(kernel.state.view(coding.session)?.task.status).toBe('recovering')
    expect(eventsOf(coding, 'failure/recorded')[0]?.kind).toBe('verification-failed')
    expect(eventsOf(coding, 'failure/recorded')[0]?.detail)
      .toContain('the coding task declares no acceptance criterion and this deployment requires one before completion')
    expect(transitions(coding).some(transition => transition.trigger.kind === 'verification-requested')).toBe(true)
  })
})

describe('no-progress detection', () => {
  it('refuses a third identical call whose result never changed, and records it once', async () => {
    const { ctx, kernel } = await rig({ mode: 'enforce', policy: { defaults: { effect: 'allow' }, rules: [] } })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'read-page')
    // Enforce mode grants nothing to a tool that declares nothing, so the
    // fixture declares the capability its call needs.
    kernel.capabilities.register({ tool: 'read-page', capabilities: ['fs.read'], resources: () => '**' })
    await preStep(ctx, agent, [humanMessage('read it')])

    const first = await callTool(ctx, 'read-page', agent)
    const second = await callTool(ctx, 'read-page', agent)
    const third = await callTool(ctx, 'read-page', agent)
    const fourth = await callTool(ctx, 'read-page', agent)

    expect([first.isError, second.isError]).toEqual([false, false])
    expect(third.isError).toBe(true)
    expect(JSON.stringify(third.content)).toContain('consolidate what you have')
    expect(fourth.isError).toBe(true)
    expect(eventsOf(agent, 'failure/recorded').map(record => record.kind)).toEqual(['no-progress'])
    expect(eventsOf(agent, 'failure/recorded')[0]?.detail).toContain('2 identical read-page calls')
  })

  it('records the failure without refusing the call where the deployment is shadow', async () => {
    const { ctx } = await rig()
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'read-page')
    await preStep(ctx, agent, [humanMessage('read it')])

    await callTool(ctx, 'read-page', agent)
    await callTool(ctx, 'read-page', agent)
    const third = await callTool(ctx, 'read-page', agent)

    expect(third.isError).toBe(false)
    expect(eventsOf(agent, 'failure/recorded').map(record => record.kind)).toEqual(['no-progress'])
  })

  it('does not count a run whose results differ', async () => {
    const { ctx, kernel } = await rig({ mode: 'enforce', policy: { defaults: { effect: 'allow' }, rules: [] } })
    const agent = await makeAgent(ctx)
    kernel.capabilities.register({ tool: 'read-page', capabilities: ['fs.read'], resources: () => '**' })
    let reads = 0
    registerTool(ctx, 'read-page', async () => [{ type: 'text', text: `page ${String(reads += 1)}` }])
    await preStep(ctx, agent, [humanMessage('read it')])

    const results = []
    for (let call = 0; call < 4; call += 1) results.push(await callTool(ctx, 'read-page', agent))

    expect(results.every(result => ! result.isError)).toBe(true)
    expect(eventsOf(agent, 'failure/recorded')).toEqual([])
  })
})
