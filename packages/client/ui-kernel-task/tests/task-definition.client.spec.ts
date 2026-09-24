/**
 * The kernel-task node: folding the kernel's own records into one Chat node,
 * including the interruption edge a durable log can leave behind.
 */

import { describe, expect, it } from 'vitest'
import type { ConversationLocation, ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { KernelTaskState } from '../src/client/task-definition.ts'
import { foldKernelTask, kernelTaskDefinition, projectKernelTask } from '../src/client/task-definition.ts'

const TASK_ID = 'task-1'
const RUN_ID = 'run-1'

/** Metadata the kernel writes on every record, so a node can claim its events. */
function metadata(taskId = TASK_ID): { version: 1, runId: string, taskId: string, actor: 'kernel', timestamp: number, provenance: { source: string, locator: string } } {
  return { version: 1, runId: RUN_ID, taskId, actor: 'kernel', timestamp: 1, provenance: { source: 'kernel', locator: taskId } }
}

/** The state a `task/created` event starts a node with. */
function created(overrides: Partial<KernelTaskState> = {}): KernelTaskState {
  return {
    objective: 'repair the reader',
    agentProfile: 'worker',
    policyProfile: 'default',
    budget: { maxSteps: 8 },
    status: 'executing',
    revision: 3,
    planSteps: [],
    openActions: [],
    failures: [],
    evidence: 0,
    claims: 0,
    hypotheses: 0,
    evidenceById: {},
    claimById: {},
    ...overrides,
  }
}

/** One open location: a turn and step that a live run would still be inside. */
const OPEN_LOCATION: ConversationLocation = {
  kind: 'step',
  turn: { turn: 1, status: 'open' },
  step: { turn: 1, step: 1, status: 'open' },
} as ConversationLocation

/** One closed location, which is what a log ends with when its run stopped. */
const CLOSED_LOCATION: ConversationLocation = {
  kind: 'step',
  turn: { turn: 1, status: 'closed' },
  step: { turn: 1, step: 1, status: 'closed' },
} as ConversationLocation

/** A node context over one state and location. */
function context(state: KernelTaskState, location: ConversationLocation = OPEN_LOCATION): ConversationNodeContext<KernelTaskState> {
  return {
    key: 'kernel-task:task-1',
    id: TASK_ID,
    state,
    start: { event: event(0, 'task/created'), location },
  } as unknown as ConversationNodeContext<KernelTaskState>
}

/** One session event of the given type. */
function event<T extends SessionEvent['type']>(seq: number, type: T, data: unknown = {}): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_000 + seq, data } as SessionEvent
}

describe('kernel-task fold', () => {
  it('claims only the kernel records that name its task', () => {
    expect(kernelTaskDefinition.match(event(0, 'task/created', { taskId: TASK_ID })))
      .toEqual({ id: TASK_ID, role: 'start' })
    expect(kernelTaskDefinition.match(event(1, 'task/plan', { metadata: metadata() })))
      .toEqual({ id: TASK_ID, role: 'update' })
    // A record without task metadata belongs to a prefix this node cannot claim.
    expect(kernelTaskDefinition.match(event(2, 'task/plan', {}))).toBeNull()
    expect(kernelTaskDefinition.match(event(3, 'assistant/message', {}))).toBeNull()
  })

  it('folds transitions, plans, failures, verification, checkpoints, and the research record', () => {
    let state = created()
    state = foldKernelTask(state, event(1, 'task/transitioned', { to: 'verifying', metadata: metadata() }))
    state = foldKernelTask(state, event(2, 'task/plan', { revision: 1, steps: ['reproduce', 'repair'], metadata: metadata() }))
    state = foldKernelTask(state, event(3, 'action/decided', { proposal: { actionId: 'call-1' }, metadata: metadata() }))
    state = foldKernelTask(state, event(4, 'action/decided', { proposal: { actionId: 'call-2' }, metadata: metadata() }))
    state = foldKernelTask(state, event(5, 'action/committed', { actionId: 'call-2', outcome: 'succeeded', metadata: metadata() }))
    state = foldKernelTask(state, event(6, 'failure/recorded', { failureId: 'f-1', kind: 'verification-failed', detail: 'x', at: 1, metadata: metadata() }))
    state = foldKernelTask(state, event(7, 'verification/result', {
      taskId: TASK_ID,
      revision: 1,
      status: 'fail',
      criterionResults: [{ criterionId: 'crit-1', status: 'fail', evidence: [] }],
      commands: [],
      verifierVersion: 'kernel-1',
      metadata: metadata(),
    }))
    state = foldKernelTask(state, event(8, 'checkpoint/created', {
      checkpointId: 'checkpoint-1',
      taskId: TASK_ID,
      runId: RUN_ID,
      agentSessionId: 'session-1',
      sessionSeq: 0,
      status: 'executing',
      revision: 1,
      budgets: { steps: 1, toolCalls: 1, wallMs: 1, remaining: {} },
      openActionIds: [],
      unresolvedFailures: [],
      reason: 'turn-boundary',
      createdAt: 1,
      metadata: metadata(),
    }))
    state = foldKernelTask(state, event(9, 'evidence/recorded', {
      evidenceId: 'e-1',
      kind: 'test',
      contentRef: 'tests/reader.spec.ts',
      trust: 'trusted',
      provenance: { source: 'tool', locator: 'call-2' },
      observedAt: 1,
      metadata: metadata(),
    }))
    state = foldKernelTask(state, event(10, 'claim/updated', {
      claimId: 'c-1',
      statement: 'the reader parses malformed input without throwing',
      evidence: ['e-1'],
      confidence: 0.8,
      status: 'supported',
      metadata: metadata(),
    }))
    state = foldKernelTask(state, event(11, 'hypothesis/updated', { hypothesisId: 'h-1', metadata: metadata() }))

    expect(state).toMatchObject({
      status: 'verifying',
      planRevision: 1,
      planSteps: ['reproduce', 'repair'],
      openActions: ['call-1'],
      failures: ['verification-failed'],
      evidence: 1,
      claims: 1,
      hypotheses: 1,
    })
    expect(state.verification).toEqual({
      status: 'fail',
      criteria: [{ criterionId: 'crit-1', status: 'fail', evidence: [] }],
      verifierVersion: 'kernel-1',
    })
    expect(state.checkpoint).toEqual({
      checkpointId: 'checkpoint-1',
      reason: 'turn-boundary',
      revision: 1,
      sessionSeq: 0,
    })
    // Evidence lineage: the claim resolves the evidence it cited by id, not
    // just a bare count.
    const projected = projectKernelTask(context(state))
    expect(projected.claimRecords).toEqual([{
      claimId: 'c-1',
      statement: 'the reader parses malformed input without throwing',
      status: 'supported',
      confidence: 0.8,
      evidence: [{
        evidenceId: 'e-1',
        kind: 'test',
        contentRef: 'tests/reader.spec.ts',
        trust: 'trusted',
        source: 'tool',
      }],
    }])
  })

  it('reports a live run inside an open location as running', () => {
    expect(projectKernelTask(context(created())).interrupted).toBe(false)
  })

  it('reports a non-terminal task inside a closed location as interrupted', () => {
    const data = projectKernelTask(context(created(), CLOSED_LOCATION))

    expect(data.interrupted).toBe(true)
    expect(data.status).toBe('executing')
  })

  it('leaves terminal statuses alone even when the location closed', () => {
    expect(projectKernelTask(context(created({ status: 'completed' }), CLOSED_LOCATION)).interrupted).toBe(false)
  })

  it('builds no node before the task was created', () => {
    const bare = { key: 'k', id: TASK_ID, state: created(), start: undefined } as unknown as ConversationNodeContext<KernelTaskState>
    expect(kernelTaskDefinition.buildViewNode!(bare)).toBeNull()
  })
})
