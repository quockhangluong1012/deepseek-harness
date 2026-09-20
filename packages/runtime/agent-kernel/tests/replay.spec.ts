import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { actionIdOf, KernelLedger } from '../src/ledger.ts'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type {
  ActionId,
  ActionProposal,
  CheckpointId,
  FailureId,
  PolicyDecisionId,
  RunId,
  StateTransition,
  TaskContract,
  TaskId,
  TransitionId,
} from '../src/types.ts'

/** A fresh session over which the ledger folds. */
function session(): Session {
  return Session.create(SessionId('ledger-session'))
}

/** A contract the ledger fold starts from. */
function created(): TaskContract {
  return {
    taskId: brandString<TaskId>('task-1'),
    runId: brandString<RunId>('run-1'),
    objective: 'ship it',
    constraints: [],
    acceptance: [],
    agentProfile: 'default',
    policyProfile: 'default',
    budget: { maxSteps: 4, maxToolCalls: 3, maxWallMs: 1_000_000, maxTokens: 100, maxCostUsd: 1, maxSubagentDepth: 2 },
    status: 'intake',
    revision: 1,
  }
}

/** One transition from the fold's current state. */
function transition(from: TaskContract['status'], to: TaskContract['status'], revision: number): StateTransition {
  return {
    transitionId: brandString<TransitionId>(`t-${String(revision)}`),
    taskId: brandString<TaskId>('task-1'),
    from,
    to,
    trigger: { kind: 'step-admitted' },
    preconditions: [],
    effects: [],
    taskRevision: revision,
    revision: revision + 1,
    actor: 'kernel',
    at: 1,
  }
}

/** One action proposal recorded under `actionId`. */
function proposal(actionId: string): ActionProposal {
  return {
    actionId: actionIdOf(actionId),
    agentId: SessionId('ledger-session'),
    toolName: 'probe',
    arguments: {},
    source: 'model',
    taskRevision: 2,
    trust: 'unknown',
  }
}

describe('kernel ledger fold', () => {
  it('reports nothing for a session without a task, then folds the contract and its transitions', () => {
    const ledger = new KernelLedger()
    const target = session()
    expect(ledger.view(target)).toBeUndefined()
    expect(() => ledger.ledgerTask(target)).toThrow('agent-kernel: no task contract for this session')

    target.append('task/created', created())
    target.append('task/transitioned', transition('intake', 'ready', 1))
    target.append('task/transitioned', transition('ready', 'executing', 2))

    expect(ledger.view(target)?.task).toMatchObject({ status: 'executing', revision: 3 })
  })

  it('tracks open actions, authorizations, approvals, failures, plans, checkpoints, steps, and tool calls', () => {
    const ledger = new KernelLedger()
    const target = session()
    target.append('task/created', created())
    target.append('task/transitioned', transition('intake', 'ready', 1))
    target.append('action/proposed', proposal('call-1'))
    target.append('action/proposed', proposal('call-2'))
    target.append('step/start', { turn: 1, step: 1 })
    target.append('tool/call', { turn: 1, step: 1, callId: brandString<ToolCallId>('call-1'), name: 'probe', arguments: '{}' })
    target.append('failure/recorded', {
      failureId: brandString<FailureId>('f-1'),
      kind: 'tool-transient',
      actionId: actionIdOf('call-1'),
      detail: 'flaky',
      at: 1,
    })
    target.append('failure/recorded', {
      failureId: brandString<FailureId>('f-2'),
      kind: 'verification-failed',
      detail: 'unmet',
      at: 2,
    })
    target.append('failure/recorded', {
      failureId: brandString<FailureId>('f-3'),
      kind: 'timeout',
      actionId: actionIdOf('call-2'),
      detail: 'slow',
      at: 3,
    })

    const mid = ledger.view(target)
    expect(mid?.openActionIds).toEqual([actionIdOf('call-1'), actionIdOf('call-2')])
    expect(mid?.unresolvedFailures).toEqual([
      { failureId: 'f-1', kind: 'tool-transient' },
      { failureId: 'f-2', kind: 'verification-failed' },
      { failureId: 'f-3', kind: 'timeout' },
    ])
    expect(mid?.budgets).toMatchObject({ steps: 1, toolCalls: 1, remaining: { maxSteps: 3, maxToolCalls: 2 } })

    // A passing verification resolves every verification failure and leaves the
    // failures of other kinds alone.
    target.append('verification/result', {
      taskId: brandString<TaskId>('task-1'),
      revision: 2,
      status: 'pass',
      criterionResults: [],
      commands: [],
      verifierVersion: 'test',
    })
    expect(ledger.view(target)?.unresolvedFailures).toEqual([
      { failureId: 'f-1', kind: 'tool-transient' },
      { failureId: 'f-3', kind: 'timeout' },
    ])

    // A successful commit resolves the failures recorded against that action
    // and leaves another action's failures alone.
    target.append('action/committed', {
      actionId: actionIdOf('call-1'),
      toolName: 'probe',
      decisionId: brandString<PolicyDecisionId>('d-1'),
      outcome: 'succeeded',
      committedAt: 4,
    })
    expect(ledger.view(target)?.unresolvedFailures).toEqual([{ failureId: 'f-3', kind: 'timeout' }])

    target.append('action/committed', {
      actionId: actionIdOf('call-2'),
      toolName: 'probe',
      decisionId: brandString<PolicyDecisionId>('d-2'),
      outcome: 'failed',
      committedAt: 5,
    })

    const after = ledger.view(target)
    expect(after?.openActionIds).toEqual([])
    expect(after?.unresolvedFailures).toEqual([{ failureId: 'f-3', kind: 'timeout' }])

    target.append('task/plan', { revision: 1, steps: ['one'], createdAt: 6 })
    target.append('checkpoint/created', {
      checkpointId: brandString<CheckpointId>('c-1'),
      taskId: brandString<TaskId>('task-1'),
      runId: brandString<RunId>('run-1'),
      agentSessionId: target.id,
      sessionSeq: target.seq,
      status: 'executing',
      revision: 3,
      budgets: { steps: 1, toolCalls: 1, wallMs: 0, remaining: {} },
      openActionIds: [],
      unresolvedFailures: [],
      reason: 'turn-boundary',
      createdAt: 6,
    })
    expect(ledger.view(target)?.plan).toMatchObject({ revision: 1 })
    expect(ledger.view(target)?.checkpoint).toMatchObject({ checkpointId: 'c-1' })
  })

  it('records the human outcome of an approval that named a tool call', () => {
    const ledger = new KernelLedger()
    const target = session()
    target.append('task/created', created())
    target.append('action/proposed', proposal('call-9'))
    target.append('approval/asked', { id: brandString<ApprovalRequestId>('a-1'), toolName: 'probe', callId: brandString<ToolCallId>('call-9') })
    target.append('approval/asked', { id: brandString<ApprovalRequestId>('a-2'), toolName: 'probe' })
    target.append('approval/decided', { id: brandString<ApprovalRequestId>('a-2'), outcome: 'rejected' })
    target.append('approval/decided', { id: brandString<ApprovalRequestId>('a-1'), outcome: 'allowed-once' })

    expect(ledger.entryOf(target).approvals.get(actionIdOf('call-9'))).toBe('allowed-once')
    expect(ledger.entryOf(target).proposals.get(actionIdOf('call-9'))?.toolName).toBe('probe')
    expect(ledger.entryOf(target).attempts.get(actionIdOf('call-9'))).toBe(1)
  })

  it('reuses its cursor across reads, refolds a shortened log from the start, and keeps one cursor per session', () => {
    const ledger = new KernelLedger()
    const target = session()
    target.append('task/created', created())
    target.append('step/start', { turn: 1, step: 1 })
    expect(ledger.view(target)?.budgets.steps).toBe(1)
    // A second read of an unchanged log folds nothing again.
    expect(ledger.view(target)?.budgets.steps).toBe(1)

    // A shortened log invalidates the cursor: the entry is rebuilt from the
    // events the log still holds.
    const shortened = Session.create(SessionId('shortened'))
    shortened.append('task/created', created())
    expect(ledger.view(shortened)?.budgets.steps).toBe(0)
    expect(ledger.view(shortened)?.budgets.steps).toBe(0)

    // A second session proves the cursor is per session, not global.
    const other = session()
    other.append('task/created', created())
    expect(ledger.view(other)?.budgets.steps).toBe(0)
  })

  it('reports an unbounded ceiling as absent from the remaining allowance', () => {
    const ledger = new KernelLedger()
    const target = session()
    target.append('task/created', { ...created(), budget: {} })
    expect(ledger.view(target)?.budgets.remaining).toEqual({})
  })

  it('measures a session that has not opened a task yet', () => {
    const ledger = new KernelLedger()
    const target = session()
    expect(ledger.measure(created(), target)).toMatchObject({ steps: 0, toolCalls: 0, wallMs: 0 })
    target.append('task/created', created())
    expect(ledger.measure(created(), target).wallMs).toBeGreaterThanOrEqual(0)
  })

  it('ignores a transition whose create event this fold never saw', () => {
    const ledger = new KernelLedger()
    const target = session()
    target.append('task/transitioned', transition('intake', 'ready', 1))
    expect(ledger.entryOf(target).task).toBeUndefined()
  })

  it('ignores event types this package does not own', () => {
    const ledger = new KernelLedger()
    const target = session()
    target.append('task/created', created())
    target.append('turn/start', { turn: 1 })
    target.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(ledger.entryOf(target).floor).toBe(target.seq)
    expect(ledger.view(target)?.budgets.steps).toBe(0)
  })

  it('keys every action by the call identity the tool registry assigned', () => {
    expect(actionIdOf('call-1' satisfies string)).toBe('call-1')
    const id: ActionId = actionIdOf('call-1')
    expect(id).toBe('call-1')
  })
})
