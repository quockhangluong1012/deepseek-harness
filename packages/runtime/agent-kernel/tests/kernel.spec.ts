import { afterEach, describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Capability, CapabilityDeclaration, PolicyProfileSelection, RunId, TaskId, TaskInput } from '../src/types.ts'
import {
  authorizations,
  callTool,
  currentTask,
  decisions,
  denials,
  eventsOf,
  humanMessage,
  makeAgent,
  pluginMessage,
  policies,
  preStep,
  proposals,
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

  it('opens a task as soon as the first user inbox message is claimed', async () => {
    const { ctx, kernel } = await mounted({
      acceptance: [{ id: 'build', description: 'build passes', verifier: 'build', required: true }],
    })
    const agent = await makeAgent(ctx, 'C:\\ws')
    emitAgentEvent(ctx, agent, 'agent/inbox/claimed', { message: humanMessage('fix the bug'), turn: 1 })

    expect(kernel.state.view(agent.session)?.task).toMatchObject({
      objective: 'fix the bug',
      workspace: { root: 'C:\\ws' },
      acceptance: [{ id: 'build', required: true }],
      status: 'ready',
    })
    expect(eventsOf(agent, 'task/created')).toHaveLength(1)
  })

  it('creates the durable task from an explicit intake contract', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx, process.cwd())
    const input: TaskInput = {
      objective: 'repair parser',
      constraints: [{ kind: 'scope', statement: 'change runtime only' }],
      acceptance: [{ id: 'build', description: 'build succeeds', verifier: 'build', required: true }],
      workspace: { root: process.cwd() },
      agentProfile: 'worker',
      policyProfile: 'strict',
      budget: { maxSteps: 4 },
    }

    const task = kernel.intake(agent, input)

    expect(task).toMatchObject({
      objective: 'repair parser',
      constraints: [{ kind: 'scope', statement: 'change runtime only' }],
      acceptance: [{ id: 'build', required: true }],
      workspace: { root: process.cwd() },
      agentProfile: 'worker',
      policyProfile: 'strict',
      budget: { maxSteps: 4 },
      status: 'intake',
      revision: 1,
    })
    expect(eventsOf(agent, 'task/created')[0]).toMatchObject(task)
  })

  it('intersects requested budgets with deployment ceilings', async () => {
    const { ctx, kernel } = await mounted({ budgets: { maxSteps: 4, maxToolCalls: 6, maxConcurrentActions: 3 } })
    const agent = await makeAgent(ctx, process.cwd())

    const task = kernel.intake(agent, {
      objective: 'limit scope',
      agentProfile: 'worker',
      policyProfile: 'strict',
      budget: { maxSteps: 10, maxToolCalls: 2, maxConcurrentActions: 8 },
    })

    expect(task.budget).toEqual({ maxSteps: 4, maxToolCalls: 2, maxConcurrentActions: 3 })
  })

  it('rejects a task workspace outside the session boundary before recording it', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx, process.cwd())
    const outside = resolve(process.cwd(), '..', 'outside-workspace')

    expect(() => kernel.intake(agent, {
      objective: 'write outside the workspace',
      agentProfile: 'worker',
      policyProfile: 'strict',
      workspace: { root: outside },
    })).toThrow(/workspace.*outside/)
    expect(eventsOf(agent, 'task/created')).toHaveLength(0)
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

describe('kernel audit envelopes', () => {
  it('correlates durable task and action records to versioned provenance', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx, process.cwd())
    emitAgentEvent(ctx, agent, 'agent/inbox/claimed', { message: humanMessage('inspect this file'), turn: 1 })
    registerTool(ctx, 'probe')
    declareProbe(kernel)
    await callTool(ctx, 'probe', agent, 'metadata-call')

    const task = eventsOf(agent, 'task/created')[0]!
    expect(task.metadata).toMatchObject({
      version: 1,
      runId: task.runId,
      taskId: task.taskId,
      actor: 'user',
      timestamp: expect.any(Number),
      provenance: { source: 'user' },
    })
    expect(kernel.state.view(agent.session)?.task).not.toHaveProperty('metadata')
    expect(eventsOf(agent, 'task/transitioned')[0]?.metadata).toMatchObject({
      version: 1, runId: task.runId, taskId: task.taskId, actor: 'kernel', provenance: { source: 'kernel' },
    })
    // One record carries the action's whole authorization, so its provenance is
    // the policy layer that decided; the call identity survives in the proposal.
    expect(decisions(agent)[0]?.metadata).toMatchObject({
      version: 1, runId: task.runId, taskId: task.taskId, actor: 'kernel', provenance: { source: 'policy' },
    })
    expect(proposals(agent)[0]).toMatchObject({ actionId: 'metadata-call' })
    expect(decisions(agent)[0]?.metadata).toMatchObject({
      version: 1, runId: task.runId, taskId: task.taskId, actor: 'kernel', provenance: { source: 'policy' },
    })
    expect(eventsOf(agent, 'action/committed')[0]?.metadata).toMatchObject({
      version: 1, runId: task.runId, taskId: task.taskId, actor: 'tool', provenance: { source: 'tool' },
    })
  })
})

describe('turn verification', () => {
  it('completes a task whose required criterion passes, then opens the next task', async () => {
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

    // The next claimed message is the next request in the conversation, and it
    // opens its own contract naming the one it follows.
    const finished = currentTask(agent).taskId
    await preStep(ctx, agent, [humanMessage('more')], 2, 1)
    await stopTurn(ctx, agent, 2)
    expect(eventsOf(agent, 'task/created')).toHaveLength(2)
    expect(currentTask(agent).parentTaskId).toBe(finished)
    expect(eventsOf(agent, 'verification/requested')).toHaveLength(2)
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
    expect(eventsOf(agent, 'recovery/started')[0]).toMatchObject({
      failureId: eventsOf(agent, 'failure/recorded')[0]?.failureId,
      kind: 'verification-failed',
      metadata: { actor: 'kernel', runId: currentTask(agent).runId, taskId: currentTask(agent).taskId },
    })
    expect(currentTask(agent).status).toBe('recovering')
    expect(transitions(agent).map(item => item.to)).toContain('verifying')
  })

  it('completes a task whose class requires no criterion, recording no verification', async () => {
    const { ctx } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('one')])
    await stopTurn(ctx, agent)

    expect(eventsOf(agent, 'verification/requested')).toHaveLength(0)
    expect(currentTask(agent).status).toBe('completed')
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

describe('task plan revisions', () => {
  it('requires a recorded failure before amending the plan', async () => {
    const { ctx, kernel } = await mounted({
      acceptance: [{ id: 'build', description: 'build succeeds', verifier: 'build', required: true }],
    })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('repair the parser')])

    const initial = kernel.recordPlan(agent, ['inspect the parser', 'run the build'])
    expect(initial).toMatchObject({ revision: 1, steps: ['inspect the parser', 'run the build'] })
    expect(kernel.state.view(agent.session)?.plan).toEqual(initial)
    expect(() => kernel.recordPlan(agent, ['unlinked amendment'])).toThrow(/failure/)

    await stopTurn(ctx, agent)
    const failure = eventsOf(agent, 'failure/recorded')[0]!
    const amended = kernel.recordPlan(agent, ['fix the parser', 'run the build'], failure.failureId)

    expect(amended).toMatchObject({ revision: 2, failureId: failure.failureId })
    expect(eventsOf(agent, 'task/plan')).toHaveLength(2)
    expect(eventsOf(agent, 'task/plan')[1]?.metadata).toMatchObject({
      version: 1,
      runId: currentTask(agent).runId,
      taskId: currentTask(agent).taskId,
      actor: 'model',
      provenance: { source: 'model' },
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
    expect(proposals(agent)[0]).toMatchObject({
      actionId: 'call-1',
      toolName: 'probe',
      source: 'model',
      trust: 'unknown',
      taskRevision: 3,
    })
    expect(policies(agent)[0]).toMatchObject({ effect: 'allow', matchedRuleIndex: null })
    expect(authorizations(agent)[0]).toMatchObject({ effect: 'allow', enforced: false })
    // The grant rides the authorization: no separate grant event is recorded.
    expect(authorizations(agent)[0]!.capabilityGrants).toEqual(['fs.read'])
    expect(eventsOf(agent, 'action/committed')[0]).toMatchObject({
      actionId: 'call-1',
      toolName: 'probe',
      outcome: 'succeeded',
      governance: { sandboxMode: 'read-only', approver: 'policy' },
    })
    expect(denials(agent)).toHaveLength(0)
  })

  it('stores a digest instead of sensitive action arguments', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx, process.cwd())
    const secret = 'sentinel-secret-value'
    ctx.tools.register(defineContentToolFixture({
      name: 'secret_probe',
      description: 'reads a file using a credential',
      parameters: { api_token: { type: 'string', required: true } },
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    }))
    kernel.capabilities.register({ tool: 'secret_probe', capabilities: ['fs.read'], resources: () => 'workspace/a.ts' })
    await preStep(ctx, agent, [humanMessage('read a file')])

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('secret-call'),
      name: 'secret_probe',
      arguments: { api_token: secret },
      agent,
    })

    expect(result.isError).toBe(false)
    const proposal = proposals(agent)[0]!
    expect(proposal.arguments).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(JSON.stringify([
      proposal,
      policies(agent)[0],
      authorizations(agent)[0],
    ])).not.toContain(secret)
  })

  it('records the enforced grants that end when the tool settles', async () => {
    const { ctx, kernel } = await mounted({ mode: 'enforce', policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    declareProbe(kernel)
    await preStep(ctx, agent, [humanMessage('read a file')])

    const result = await callTool(ctx, 'probe', agent, 'revoked-call')

    expect(result.isError).toBe(false)
    // The grant is recorded on the authorization; the settle is the commit, so
    // a reader derives the one-action grant's end without a third event.
    expect(authorizations(agent)[0]).toMatchObject({
      effect: 'allow',
      enforced: true,
      capabilityGrants: ['fs.read'],
    })
    expect(eventsOf(agent, 'action/committed')[0]).toMatchObject({
      actionId: 'revoked-call',
      outcome: 'succeeded',
      metadata: { actor: 'tool', runId: currentTask(agent).runId, taskId: currentTask(agent).taskId },
    })
  })

  it('quarantines an untrusted tool proposal behind a human answer', async () => {
    const { ctx, kernel } = await mounted({ mode: 'enforce', policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    // The declaring package knows the content is external, so the permission
    // document alone may not authorize the call.
    kernel.capabilities.register({ tool: 'probe', capabilities: ['fs.read'], resources: () => 'workspace/a.ts', trust: 'untrusted' })
    await preStep(ctx, agent, [humanMessage('fetch a page')])

    await callTool(ctx, 'probe', agent, 'quarantined-call')

    expect(proposals(agent)[0]?.trust).toBe('untrusted')
    expect(policies(agent)[0]?.effect).toBe('allow')
    const authorization = authorizations(agent).at(-1)
    expect(authorization).toMatchObject({ effect: 'ask', enforced: true })
    expect(authorization?.reasons.join(' ')).toContain('untrusted-content quarantine')
  })

  it('leaves untrusted proposals to the permission document when quarantine is off', async () => {
    const { ctx, kernel } = await mounted({ policy: ALLOW_ALL, untrustedContent: 'allow' })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    kernel.capabilities.register({ tool: 'probe', capabilities: ['fs.read'], resources: () => 'workspace/a.ts', trust: 'untrusted' })
    await preStep(ctx, agent, [humanMessage('fetch a page')])

    const result = await callTool(ctx, 'probe', agent, 'allowed-call')

    expect(result.isError).toBe(false)
    expect(authorizations(agent).at(-1)?.effect).toBe('allow')
  })

  it('refuses a plan revision beyond the configured cap', async () => {
    const { ctx, kernel } = await mounted({ maxPlanRevisions: 1 })
    const agent = await makeAgent(ctx)
    agent.session.append('task/created', {
      taskId: brandString<TaskId>('capped-task'),
      runId: brandString<RunId>('run-capped'),
      objective: 'replan forever',
      constraints: [],
      acceptance: [{ id: 'crit', description: 'the criterion passes', verifier: 'assertion', required: true }],
      agentProfile: 'default',
      policyProfile: 'default',
      budget: {},
      status: 'executing',
      revision: 1,
    })
    kernel.verifiers.register({
      id: 'always-fails',
      supports: () => true,
      verify: async (_request, criterion) => ({ result: { criterionId: criterion.id, status: 'fail', evidence: [] } }),
    })
    await stopTurn(ctx, agent)
    const failure = eventsOf(agent, 'failure/recorded')[0]!

    expect(kernel.recordPlan(agent, ['first'], failure.failureId).revision).toBe(1)
    expect(() => kernel.recordPlan(agent, ['second'], failure.failureId))
      .toThrow('1-revision plan cap')
  })

  it('creates a task from the registered profile of its role', async () => {
    const { ctx } = await mounted({
      agentProfile: 'reviewer',
      policyProfile: 'deployment',
      budgets: { maxSteps: 100 },
      profiles: [{
        id: 'reviewer',
        role: 'code reviewer',
        capabilities: ['fs.read'],
        policyProfile: 'review-only',
        budget: { maxSteps: 8, maxToolCalls: 4 },
      }],
    })
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('review the change')])

    expect(eventsOf(agent, 'task/created')[0]).toMatchObject({
      agentProfile: 'reviewer',
      // The role's policy profile wins over the deployment default, and the
      // task budget is the intersection of both ceilings.
      policyProfile: 'review-only',
      budget: { maxSteps: 8, maxToolCalls: 4 },
    })
  })

  it('refuses an action outside the role grant even when a rule would allow it', async () => {
    const { ctx, kernel } = await mounted({
      mode: 'enforce',
      agentProfile: 'reader',
      policy: ALLOW_ALL,
      profiles: [{ id: 'reader', role: 'reader', capabilities: ['fs.read'], policyProfile: 'default', budget: {} }],
    })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    declareProbe(kernel, 'network.read', () => 'https://example.com')
    await preStep(ctx, agent, [humanMessage('write a file')])

    const result = await callTool(ctx, 'probe', agent, 'outside-role')

    expect(result.isError).toBe(true)
    expect(policies(agent)[0]?.effect).toBe('allow')
    expect(denials(agent).at(-1)?.reasons.join(' '))
      .toContain('the agent profile withholds capability "network.read"')
  })

  it('records a shadow denial for an undeclared tool but still runs it', async () => {
    const { ctx } = await mounted({ policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'undeclared')
    await preStep(ctx, agent, [humanMessage('go')])

    const result = await callTool(ctx, 'undeclared', agent, 'call-2')
    expect(result.isError).toBe(false)
    expect(denials(agent)[0] ?? {}).toMatchObject({ effect: 'deny', enforced: false })
    expect(policies(agent)[0]?.reasons).toContain(
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
    expect(denials(agent)[0]?.enforced).toBe(true)
  })

  it('fails closed for agentless and taskless tool execution in enforce mode', async () => {
    const { ctx, kernel } = await mounted({ mode: 'enforce', policy: ALLOW_ALL })
    let executions = 0
    registerTool(ctx, 'probe', async () => {
      executions += 1
      return [{ type: 'text', text: 'ran' }]
    })
    declareProbe(kernel)

    const result = await callTool(ctx, 'probe', undefined, 'agentless-call')

    expect(result.isError).toBe(true)
    expect(executions).toBe(0)
    const tasklessAgent = await makeAgent(ctx)
    const taskless = await callTool(ctx, 'probe', tasklessAgent, 'taskless-call')
    expect(taskless.isError).toBe(true)
    expect(executions).toBe(0)
  })

  it('intersects each session policy profile with deployment policy', async () => {
    const { ctx, kernel } = await mounted({ mode: 'enforce', policy: ALLOW_ALL })
    let selected: PolicyProfileSelection = {
      profile: 'restricted',
      document: { defaults: { effect: 'deny' as const }, rules: [] },
    }
    const dispose = kernel.registerPolicyProfileProvider({ resolve: () => selected })
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'probe')
    declareProbe(kernel)
    await preStep(ctx, agent, [humanMessage('read a file')])

    expect(currentTask(agent).policyProfile).toBe('restricted')
    const denied = await callTool(ctx, 'probe', agent, 'restricted-call')
    expect(denied.isError).toBe(true)
    expect(decisions(agent)[0]?.metadata?.provenance.locator).toBe('restricted')

    selected = { profile: 'permissive', document: ALLOW_ALL }
    const allowed = await callTool(ctx, 'probe', agent, 'permissive-call')
    expect(allowed.isError).toBe(false)
    expect(decisions(agent)[1]?.metadata?.provenance.locator).toBe('permissive')
    dispose()
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
    expect(authorizations(agent)[0]).toMatchObject({ effect: 'ask', capabilityGrants: [] })
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

    expect(authorizations(agent)[0]!.sandbox).toMatchObject({
      mode: 'workspace-write',
      workspaceRoot: 'C:\\ws',
    })
    expect(authorizations(agent)[0]!.enforced).toBe(true)
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
    expect(denials(agent)[0]?.reasons)
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
    expect(attachment.snapshot().task.status).toBe('completed')

    await attachment.dispose()
    await attachment.dispose()
    expect(kernel.attach(agent).taskId).toBe(attachment.taskId)
  })

  it('records a checkpoint of the current kernel state', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('go')])

    const checkpoint = kernel.checkpoint(agent, 'turn-boundary')!
    expect(checkpoint).toMatchObject({
      status: 'executing',
      revision: 3,
      reason: 'turn-boundary',
      openActionIds: [],
      unresolvedFailures: [],
    })
    const recorded = eventsOf(agent, 'checkpoint/created')[0]
    expect(recorded).toMatchObject(checkpoint)
    expect(recorded?.metadata).toMatchObject({
      version: 1,
      runId: checkpoint?.runId,
      taskId: checkpoint?.taskId,
      actor: 'kernel',
      provenance: { source: 'kernel' },
    })
  })

  it('records checkpoint resumption only for a session the registry resumes', async () => {
    const { ctx, kernel } = await mounted()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('continue')])
    const checkpoint = kernel.checkpoint(agent, 'before-pause')!

    await ctx.serial('agent/created', { agent, source: 'resume' })

    expect(eventsOf(agent, 'checkpoint/resumed')).toMatchObject([{
      checkpointId: checkpoint.checkpointId,
      sessionSeq: checkpoint.sessionSeq,
      metadata: {
        version: 1,
        runId: checkpoint.runId,
        taskId: checkpoint.taskId,
        actor: 'system',
      },
    }])
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
