import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { Capability, CapabilityDeclaration, RunId, TaskId } from '../src/types.ts'
import {
  callTool,
  currentTask,
  eventsOf,
  humanMessage,
  makeAgent,
  pluginMessage,
  preStep,
  registerTool,
  rig,
  stopTurn,
  transitions,
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

/** Declare one capability for the `probe` fixture tool. */
function declareProbe(
  kernel: Awaited<ReturnType<typeof rig>>['kernel'],
  capability: Capability = 'fs.read',
  resources = () => 'workspace/a.ts',
): void {
  const declaration: CapabilityDeclaration = { tool: 'probe', capabilities: [capability], resources }
  kernel.capabilities.register(declaration)
}

describe('task intake', () => {
  it('opens a contract from the first admitted step and records the workspace', async () => {
    const { ctx } = await mounted({ agentProfile: 'worker', policyProfile: 'strict', budgets: { maxSteps: 5 } })
    const agent = await makeAgent(ctx, 'C:\\ws')
    await preStep(ctx, agent, [humanMessage('fix the bug')], 1, 1)

    const created = eventsOf(agent, 'task/created')[0]
    expect(created).toMatchObject({
      objective: 'fix the bug',
      workspace: { root: 'C:\\ws' },
      agentProfile: 'worker',
      policyProfile: 'strict',
      budget: { maxSteps: 5 },
      status: 'intake',
      revision: 1,
    })
    expect(transitions(agent).map(item => [item.from, item.to])).toEqual([['intake', 'ready'], ['ready', 'executing']])
    expect(transitions(agent)[0]?.trigger).toEqual({ kind: 'task-intake' })
    expect(transitions(agent)[1]?.trigger).toEqual({ kind: 'step-admitted', detail: 'turn 1 step 1' })
    expect(transitions(agent)[1]?.actor).toBe('kernel')
    expect(currentTask(agent)).toMatchObject({ status: 'executing', revision: 3 })
  })

  it('opens an objective-less contract when no session cwd is recorded and no human message is claimed', async () => {
    const { ctx } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [pluginMessage('notice')])

    const created = eventsOf(agent, 'task/created')[0]
    expect(created?.objective).toBe('')
    expect(created?.workspace).toBeUndefined()
    expect(created).toMatchObject({ agentProfile: 'default', policyProfile: 'default', budget: {} })
  })

  it('advances an existing task without creating a second contract', async () => {
    const { ctx } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('one')])
    await preStep(ctx, agent, [humanMessage('two')], 1, 2)

    expect(eventsOf(agent, 'task/created')).toHaveLength(1)
    expect(currentTask(agent)).toMatchObject({ status: 'executing', objective: 'one' })
  })
})

describe('turn verification', () => {
  it('completes a task whose required criterion passes, then leaves a terminal task alone', async () => {
    const { ctx, kernel } = await mounted({
      acceptance: [{ id: 'build', description: 'build passes', verifier: 'build', required: true }],
    })
    const agent = await makeAgent(ctx)
    kernel.verifiers.register({
      id: 'always-pass',
      supports: () => true,
      verify: async (_request, criterion) => ({ result: { criterionId: criterion.id, status: 'pass', evidence: [] } }),
    })
    await preStep(ctx, agent, [humanMessage('one')])
    await stopTurn(ctx, agent)

    expect(eventsOf(agent, 'verification/result')[0]?.status).toBe('pass')
    expect(currentTask(agent).status).toBe('completed')

    const before = transitions(agent).length
    await preStep(ctx, agent, [humanMessage('more')], 2, 1)
    await stopTurn(ctx, agent, 2)
    expect(transitions(agent)).toHaveLength(before)
    expect(eventsOf(agent, 'verification/requested')).toHaveLength(1)
  })

  it('records a request and result and recovers when a required criterion is unknown', async () => {
    const { ctx, kernel } = await mounted({
      acceptance: [{ id: 'build', description: 'build passes', verifier: 'build', required: true }],
    })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('one')])
    kernel.verifiers.register({
      id: 'reports-unknown',
      supports: () => true,
      verify: async (_request, criterion) => ({ result: { criterionId: criterion.id, status: 'unknown', evidence: [] } }),
    })
    await stopTurn(ctx, agent)

    expect(eventsOf(agent, 'verification/requested')).toHaveLength(1)
    expect(eventsOf(agent, 'verification/requested')[0]).toMatchObject({ revision: 5, changedScopes: [] })
    expect(eventsOf(agent, 'verification/result')[0]?.status).toBe('unknown')
    expect(eventsOf(agent, 'failure/recorded')[0]).toMatchObject({ kind: 'verification-failed' })
    expect(eventsOf(agent, 'recovery/decided')[0]).toMatchObject({ action: 'diagnose' })
    expect(currentTask(agent).status).toBe('recovering')
    expect(transitions(agent).map(item => item.to)).toContain('verifying')
  })

  it('records no verification when the task declares no required criterion', async () => {
    const { ctx } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('one')])
    await stopTurn(ctx, agent)

    expect(eventsOf(agent, 'verification/requested')).toHaveLength(0)
    expect(currentTask(agent).status).toBe('observing')
  })

  it('observes an intake task without transitioning it, because that edge does not exist', async () => {
    const { ctx } = await mounted()
    const agent = await makeAgent(ctx)
    agent.session.append('task/created', {
      taskId: brandString<TaskId>('manual-task'),
      runId: brandString<RunId>('run-manual'),
      objective: 'manual',
      constraints: [],
      acceptance: [],
      agentProfile: 'default',
      policyProfile: 'default',
      budget: {},
      status: 'intake',
      revision: 1,
    })
    await stopTurn(ctx, agent)
    expect(transitions(agent)).toHaveLength(0)
  })

  it('records a failure without a recovery transition when the edge does not exist', async () => {
    const { ctx, kernel } = await mounted({
      acceptance: [{ id: 'build', description: 'build passes', verifier: 'build', required: true }],
    })
    const agent = await makeAgent(ctx)
    agent.session.append('task/created', {
      taskId: brandString<TaskId>('paused-task'),
      runId: brandString<RunId>('run-paused'),
      objective: 'paused',
      constraints: [],
      acceptance: [{ id: 'build', description: 'build passes', verifier: 'build', required: true }],
      agentProfile: 'default',
      policyProfile: 'default',
      budget: {},
      status: 'paused',
      revision: 4,
    })
    kernel.verifiers.register({
      id: 'reports-fail',
      supports: () => true,
      verify: async (_request, criterion) => ({ result: { criterionId: criterion.id, status: 'fail', evidence: [] } }),
    })
    await stopTurn(ctx, agent)

    expect(eventsOf(agent, 'verification/result')[0]?.status).toBe('fail')
    expect(eventsOf(agent, 'failure/recorded')).toHaveLength(1)
    expect(currentTask(agent).status).toBe('paused')
  })

  it('returns no decision and records nothing for an agent with no task', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    expect(await kernel.verify(agent)).toBeUndefined()
    expect(await kernel.verify(agent, ['src'])).toBeUndefined()
    expect(agent.session.snapshotEvents()).toHaveLength(0)
    expect(kernel.checkpoint(agent, 'before-pause')).toBeUndefined()
    await stopTurn(ctx, agent)
    expect(agent.session.snapshotEvents()).toHaveLength(0)
  })

  it('records an explicit verification request for a caller that asks for one', async () => {
    const { ctx, kernel } = await mounted({
      acceptance: [{ id: 'diff', description: 'no stray files', verifier: 'diff', required: true }],
    })
    const agent = await makeAgent(ctx)
    kernel.verifiers.register({
      id: 'diff-guard',
      supports: criterion => criterion.verifier === 'diff',
      verify: async (request, criterion) => ({
        result: { criterionId: criterion.id, status: 'pass', evidence: request.changedScopes },
        commands: ['git status --porcelain'],
      }),
    })
    await preStep(ctx, agent, [humanMessage('one')])
    const decision = await kernel.verify(agent, ['src'])

    expect(decision).toEqual({ allowed: true, reasons: [] })
    expect(eventsOf(agent, 'verification/requested')[0]?.changedScopes).toEqual(['src'])
    expect(eventsOf(agent, 'verification/result')[0]).toMatchObject({
      status: 'pass',
      commands: ['git status --porcelain'],
      criterionResults: [{ criterionId: 'diff', status: 'pass', evidence: ['src'] }],
    })
  })
})

describe('action ledger over the tool pipeline', () => {
  it('records a proposal, decision, authorization, grant, and commit in shadow mode without changing the outcome', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    declareProbe(kernel)
    await preStep(ctx, agent, [humanMessage('go')])

    const result = await callTool(ctx, 'probe', agent, 'call-1')
    expect(result.isError).toBe(false)
    expect(eventsOf(agent, 'action/proposed')[0]).toMatchObject({
      actionId: 'call-1',
      toolName: 'probe',
      source: 'model',
      trust: 'unknown',
      taskRevision: 3,
    })
    expect(eventsOf(agent, 'policy/decision')[0]?.decision).toMatchObject({ effect: 'allow', matchedRuleIndex: null })
    expect(eventsOf(agent, 'action/authorized')[0]?.decision).toMatchObject({ effect: 'allow', enforced: false })
    expect(eventsOf(agent, 'capability/grant')[0]).toMatchObject({ actionId: 'call-1', capabilities: ['fs.read'] })
    expect(eventsOf(agent, 'action/committed')[0]).toMatchObject({
      actionId: 'call-1',
      toolName: 'probe',
      outcome: 'succeeded',
      governance: { sandboxMode: 'read-only', approver: 'policy' },
    })
    expect(eventsOf(agent, 'action/denied')).toHaveLength(0)
  })

  it('records a shadow denial for an undeclared tool but still runs it', async () => {
    const { ctx } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'undeclared')
    await preStep(ctx, agent, [humanMessage('go')])

    const result = await callTool(ctx, 'undeclared', agent, 'call-2')
    expect(result.isError).toBe(false)
    expect(eventsOf(agent, 'action/denied')[0]?.decision).toMatchObject({ effect: 'deny', enforced: false })
    expect(eventsOf(agent, 'policy/decision')[0]?.decision.reasons).toContain(
      'tool "undeclared" declared no capability; failing closed',
    )
    expect(eventsOf(agent, 'action/committed')[0]?.outcome).toBe('succeeded')
  })

  it('refuses an undeclared tool in enforce mode and records the refusal as a denial, not a failure', async () => {
    const { ctx } = await mounted({ mode: 'enforce', policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'undeclared')
    await preStep(ctx, agent, [humanMessage('go')])

    const result = await callTool(ctx, 'undeclared', agent, 'call-3')
    expect(result.isError).toBe(true)
    expect(eventsOf(agent, 'action/committed')[0]).toMatchObject({ outcome: 'denied' })
    expect(eventsOf(agent, 'action/denied')[0]?.decision.enforced).toBe(true)
  })

  it('routes an ask through the composed approval answerer in enforce mode and links the human outcome', async () => {
    const { ctx, kernel } = await mounted({
      mode: 'enforce',
      policy: { defaults: { effect: 'allow' }, rules: [{ action: 'read', resource: '**', effect: 'ask' }] },
    })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    declareProbe(kernel)
    await preStep(ctx, agent, [humanMessage('go')])
    agent.session.append('turn/start', { turn: 1 })
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve('allowed-once' as const))

    const result = await callTool(ctx, 'probe', agent, 'call-4')
    expect(result.isError).toBe(false)
    expect(eventsOf(agent, 'action/authorized')[0]?.decision).toMatchObject({ effect: 'ask', capabilityGrants: [] })
    expect(eventsOf(agent, 'action/committed')[0]).toMatchObject({
      outcome: 'succeeded',
      governance: { approver: 'user', approvalOutcome: 'allowed-once' },
    })
  })

  it('records a rejected approval as a denial', async () => {
    const { ctx, kernel } = await mounted({
      mode: 'enforce',
      policy: { defaults: { effect: 'allow' }, rules: [{ action: 'read', resource: '**', effect: 'ask' }] },
    })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    declareProbe(kernel)
    await preStep(ctx, agent, [humanMessage('go')])
    agent.session.append('turn/start', { turn: 1 })
    await ctx.plugin(ApprovalService, { policy: 'ask' })
    ctx.on('approval/request', () => Promise.resolve('rejected' as const))

    const result = await callTool(ctx, 'probe', agent, 'call-10')
    expect(result.isError).toBe(true)
    expect(eventsOf(agent, 'action/committed')[0]).toMatchObject({
      outcome: 'denied',
      governance: { approver: 'user', approvalOutcome: 'rejected' },
    })
  })

  it('records an unanswered ask as no approver when the shadow kernel resumes execution itself', async () => {
    const { ctx, kernel } = await mounted({
      policy: { defaults: { effect: 'allow' }, rules: [{ action: 'read', resource: '**', effect: 'ask' }] },
    })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    declareProbe(kernel)
    await preStep(ctx, agent, [humanMessage('go')])

    await callTool(ctx, 'probe', agent, 'call-5')
    expect(eventsOf(agent, 'action/committed')[0]).toMatchObject({
      outcome: 'succeeded',
      governance: { approver: 'none' },
    })
  })

  it('skips the ledger for an agentless call and for an agent with no task', async () => {
    const { ctx } = await mounted({ policy: ALLOW_ALL })
    registerTool(ctx, 'probe')
    expect(ctx.tools.schemas().length).toBeGreaterThan(0)

    const agentless = await callTool(ctx, 'probe', undefined, 'call-6')
    expect(agentless.isError).toBe(false)

    const agent = await makeAgent(ctx)
    const taskless = await callTool(ctx, 'probe', agent, 'call-7')
    expect(taskless.isError).toBe(false)
    expect(agent.session.snapshotEvents()).toHaveLength(0)
  })

  it('resolves the technical boundary from the mounted sandbox policy and lets an allowed call run enforced', async () => {
    const { ctx, kernel } = await mounted({ mode: 'enforce', policy: ALLOW_ALL })
    await ctx.plugin(SandboxPolicy, { mode: 'workspace-write' })
    const agent = await makeAgent(ctx, 'C:\\ws')
    registerTool(ctx, 'probe')
    declareProbe(kernel, 'fs.write', () => 'C:\\ws\\a.ts')
    await preStep(ctx, agent, [humanMessage('go')])
    await callTool(ctx, 'probe', agent, 'call-8')

    expect(eventsOf(agent, 'action/authorized')[0]?.decision.sandbox).toMatchObject({
      mode: 'workspace-write',
      workspaceRoot: 'C:\\ws',
    })
    expect(eventsOf(agent, 'action/authorized')[0]?.decision.enforced).toBe(true)
    expect(eventsOf(agent, 'action/committed')[0]?.governance).toMatchObject({ sandboxMode: 'workspace-write' })
    expect(eventsOf(agent, 'action/committed')[0]?.outcome).toBe('succeeded')
  })

  it('refuses a mutating capability the mounted sandbox does not admit', async () => {
    const { ctx, kernel } = await mounted({ mode: 'enforce', policy: ALLOW_ALL })
    await ctx.plugin(SandboxPolicy, { mode: 'read-only' })
    const agent = await makeAgent(ctx, 'C:\\ws')
    registerTool(ctx, 'probe')
    declareProbe(kernel, 'fs.write')
    await preStep(ctx, agent, [humanMessage('go')])

    const result = await callTool(ctx, 'probe', agent, 'call-11')
    expect(result.isError).toBe(true)
    expect(eventsOf(agent, 'action/denied')[0]?.decision.reasons)
      .toContain('the read-only file policy refuses every mutating capability')
  })

  it('records the failed outcome of a throwing tool', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe', () => Promise.reject(new Error('boom')))
    declareProbe(kernel)
    await preStep(ctx, agent, [humanMessage('go')])

    const result = await callTool(ctx, 'probe', agent, 'call-9')
    expect(result.isError).toBe(true)
    expect(eventsOf(agent, 'action/committed')[0]?.outcome).toBe('failed')
  })
})

describe('attachments and checkpoints', () => {
  it('attaches only after the first admitted step, reads the live view, and releases on dispose', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    expect(() => kernel.attach(agent)).toThrow(
      `agent-kernel: agent "${agent.id}" has no task contract; one is created at its first admitted step`,
    )

    await preStep(ctx, agent, [humanMessage('go')])
    const attachment = kernel.attach(agent)
    expect(attachment.taskId).toBe(currentTask(agent).taskId)
    expect(attachment.runId).toBe(currentTask(agent).runId)
    expect(attachment.snapshot().task.status).toBe('executing')

    await stopTurn(ctx, agent)
    expect(attachment.snapshot().task.status).toBe('observing')

    await attachment.dispose()
    await attachment.dispose()
    expect(kernel.attach(agent).taskId).toBe(attachment.taskId)
  })

  it('records a checkpoint of the current kernel state', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])

    const checkpoint = kernel.checkpoint(agent, 'turn-boundary')
    expect(checkpoint).toMatchObject({
      status: 'executing',
      revision: 3,
      reason: 'turn-boundary',
      openActionIds: [],
      unresolvedFailures: [],
    })
    expect(eventsOf(agent, 'checkpoint/created')[0]).toEqual(checkpoint)
  })

  it('drains open attachments when the plugin unloads', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])
    const attachment = kernel.attach(agent)
    await ctx.fiber.dispose()
    expect(attachment.taskId).toBe(currentTask(agent).taskId)
    await attachment.dispose()
  })
})
