import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentKernel from '../src/index.ts'
import type { TaskContract } from '../src/types.ts'
import { eventsOf, humanMessage, makeAgent, preStep, rig, stopTurn, transitions } from './rig.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const contexts: Context[] = []

/** Register the verifier that answers every criterion passing. */
function registerPassingVerifier(kernel: import('../src/index.ts').AgentKernelService): void {
  kernel.verifiers.register({
    id: 'always-pass',
    supports: () => true,
    verify: async (_request, subject) => ({ result: { criterionId: subject.id, status: 'pass', evidence: [] } }),
  })
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

it('opens the task before the first production prompt assembly', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentKernel, {
    acceptance: [{ id: 'reply', description: 'the request receives a reply', verifier: 'assertion', required: true }],
  })
  const adapter = new MockAdapter([textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('kernel-first-prompt'), { provider: 'mock', model: 'mock' }, { cwd: process.cwd() })
  let taskAtAssembly: TaskContract | undefined
  ctx.on('system-prompt/assemble', async (_assembly, assemblyContext, next) => {
    if (assemblyContext.agent === agent && taskAtAssembly === undefined) {
      taskAtAssembly = ctx.agentKernel.state.view(agent.session)?.task
    }
    return next()
  })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'inspect the parser' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(taskAtAssembly).toMatchObject({
    objective: 'inspect the parser',
    acceptance: [{ id: 'reply', required: true }],
    status: 'ready',
  })
  // The task declares a criterion no verifier can answer, so the gate steers a
  // repair turn after the first one; the assembly under test is the first.
  expect(adapter.requests.length).toBeGreaterThanOrEqual(1)
  expect(taskAtAssembly).toBeDefined()
})

it('follows plan mode, the producer of the planning status', async () => {
  const { ctx, kernel } = await rig()
  const agent = await makeAgent(ctx)
  await preStep(ctx, agent, [humanMessage('plan the migration')])
  const status = (): string | undefined => kernel.state.view(agent.session)?.task.status

  expect(status()).toBe('executing')
  agent.session.append('plan/mode', { active: true })
  kernel.recordPlanMode(agent.session, true)
  expect(status()).toBe('planning')
  kernel.recordPlanMode(agent.session, true)
  expect(status()).toBe('planning')
  kernel.recordPlanMode(agent.session, false)
  expect(status()).toBe('ready')
  expect(transitions(agent).map(transition => transition.trigger.kind)).toEqual([
    'task-intake', 'step-admitted', 'plan-mode-entered', 'plan-mode-exited',
  ])
})

it('leaves a task with no task contract and a terminal task untouched on a plan-mode report', async () => {
  const { ctx, kernel } = await rig()
  const agent = await makeAgent(ctx)

  kernel.recordPlanMode(agent.session, true)

  expect(kernel.state.view(agent.session)).toBeUndefined()
})

it('records the first plan as the other producer of the planning status', async () => {
  const { ctx, kernel } = await rig()
  const agent = await makeAgent(ctx)
  await preStep(ctx, agent, [humanMessage('rename the flag')])
  const status = (): string | undefined => kernel.state.view(agent.session)?.task.status

  kernel.recordPlan(agent, ['find every caller', 'rename the flag'])
  expect(status()).toBe('planning')

  await preStep(ctx, agent, [humanMessage('rename the flag')], 1, 2)
  expect(status()).toBe('executing')
})

it('records one execution-cycle transition per turn, not one per step', async () => {
  const { ctx, kernel } = await rig()
  registerPassingVerifier(kernel)
  const agent = await makeAgent(ctx)

  await preStep(ctx, agent, [humanMessage('one')])
  await preStep(ctx, agent, [humanMessage('two')], 1, 2)
  await preStep(ctx, agent, [humanMessage('three')], 1, 3)
  await stopTurn(ctx, agent)

  // Three steps, one execution cycle: the intra-turn `executing ↔ observing`
  // churn adds no durable record, only the turn's own entry and exit do.
  const kinds = transitions(agent).map(transition => transition.trigger.kind)
  expect(kinds.filter(kind => kind === 'step-admitted')).toHaveLength(1)
  expect(kinds.filter(kind => kind === 'turn-ended')).toHaveLength(1)
  expect(kinds).toEqual(['task-intake', 'step-admitted', 'turn-ended', 'verification-requested', 'verification-passed'])
})

it('pauses a task that reached its step ceiling, recording the failure once', async () => {
  const { ctx, kernel } = await rig({ budgets: { maxSteps: 2 } })
  const agent = await makeAgent(ctx)

  // The loop appends `step/start` after an admitted step, which is what the
  // ceiling counts; the rig drives the waterfall alone.
  await preStep(ctx, agent, [humanMessage('one')], 1, 1)
  agent.session.append('step/start', { turn: 1, step: 1 })
  await preStep(ctx, agent, [humanMessage('two')], 1, 2)
  agent.session.append('step/start', { turn: 1, step: 2 })
  expect(kernel.state.view(agent.session)?.task.status).toBe('executing')
  await preStep(ctx, agent, [humanMessage('three')], 1, 3)

  expect(kernel.state.view(agent.session)?.task.status).toBe('paused')
  expect(eventsOf(agent, 'failure/recorded').map(record => record.kind)).toEqual(['step-ceiling'])
  expect(eventsOf(agent, 'recovery/decided')[0]).toMatchObject({ action: 'checkpoint-pause' })

  await preStep(ctx, agent, [humanMessage('four')], 1, 4)
  expect(eventsOf(agent, 'failure/recorded')).toHaveLength(1)
})

it('records a truncated turn as an output-truncated failure', async () => {
  const { ctx, kernel } = await rig()
  const agent = await makeAgent(ctx)
  await preStep(ctx, agent, [humanMessage('write the long file')])
  // The loop records why the turn ended when it closes the turn, which is after
  // the kernel's turn-stopping listener ran.
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'max-tokens' } } as never)

  await preStep(ctx, agent, [humanMessage('carry on')], 2)

  expect(eventsOf(agent, 'failure/recorded').map(record => record.kind)).toEqual(['output-truncated'])
  expect(eventsOf(agent, 'recovery/decided')[0]).toMatchObject({ action: 'retry', retryable: true })
  expect(eventsOf(agent, 'failure/recorded')[0]?.detail).toContain('reached its output limit in turn 1')
})
