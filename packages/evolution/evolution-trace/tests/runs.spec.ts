/**
 * The §5.1 run projection: one trace per run a log recorded, the fields each
 * run carries, how it ended, and the spend its own steps summed.
 *
 * @module @deepseek-ai/dsh-evolution-trace/tests/runs
 */

import { describe, expect, it } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContextCompilationRecord } from '@deepseek-ai/dsh-agent-context'
import type {
  DelegationId,
  FailureId,
  FailureKind,
  RunId,
  TaskId,
  TaskStatus,
  TransitionId,
} from '@deepseek-ai/dsh-agent-kernel'
import type { MessageId, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { projectRuns } from '../src/index.ts'

type EndReason = SessionEventMap['turn/end']['reason']

const seq = (n: number): SessionSeq => SessionSeq(n)
const mid = (n: number): MessageId => brandString<MessageId>(`m${n}`)
const cid = (n: string): ToolCallId => ToolCallId(`c${n}`)
const iso = (ms: number): string => new Date(ms).toISOString()

/** One task contract, as the kernel's `task/created` records it. */
function taskCreated(run: string, task: string, status: TaskStatus, s: number, time: number): SessionEvent {
  return {
    type: 'task/created',
    seq: seq(s),
    time,
    data: {
      taskId: brandString<TaskId>(task),
      runId: brandString<RunId>(run),
      objective: 'ship the change',
      constraints: [],
      acceptance: [],
      dependencies: [],
      evidence: [],
      agentProfile: 'coding',
      policyProfile: 'default',
      budget: { maxSteps: 5 },
      status,
      revision: 1,
    },
  }
}

function turnStart(turn: number, s: number, time: number): SessionEvent {
  return { type: 'turn/start', seq: seq(s), time, data: { turn } }
}

function stepStart(turn: number, step: number, s: number, time: number): SessionEvent {
  return { type: 'step/start', seq: seq(s), time, data: { turn, step } }
}

function stepEnd(turn: number, step: number, s: number, time: number): SessionEvent {
  return { type: 'step/end', seq: seq(s), time, data: { turn, step } }
}

function assistantMessage(turn: number, step: number, s: number, time: number, usage?: TokenUsage): SessionEvent {
  return {
    type: 'assistant/message',
    seq: seq(s),
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      stream: [],
      ...usage === undefined ? {} : { usage },
      message: {
        id: mid(s),
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${String(step)}` }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
    },
  }
}

function toolCall(turn: number, step: number, id: string, s: number, time: number, name: string): SessionEvent {
  return { type: 'tool/call', seq: seq(s), time, data: { turn, step, callId: cid(id), name, arguments: '{}' } }
}

function toolResult(turn: number, step: number, id: string, s: number, time: number): SessionEvent {
  const call = cid(id)
  return {
    type: 'tool/result',
    seq: seq(s),
    time,
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: mid(s),
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
        toolCallId: call,
        source: { kind: 'tool', callId: call },
      },
    },
  }
}

function turnEnd(turn: number, s: number, time: number, reason: EndReason = { kind: 'completed' }): SessionEvent {
  return { type: 'turn/end', seq: seq(s), time, data: { turn, reason } }
}

/** One terminal transition of a task. */
function transitioned(
  task: string,
  to: 'completed' | 'failed',
  trigger: 'verification-passed' | 'verification-failed',
  s: number,
  time: number,
): SessionEvent {
  return {
    type: 'task/transitioned',
    seq: seq(s),
    time,
    data: {
      transitionId: brandString<TransitionId>(`tr-${String(s)}`),
      taskId: brandString<TaskId>(task),
      from: 'verifying',
      to,
      trigger: { kind: trigger },
      preconditions: [],
      effects: [],
      evidence: [],
      taskRevision: 1,
      revision: 2,
      actor: 'kernel',
      at: time,
    },
  }
}

function verificationResult(task: string, status: 'pass' | 'fail', s: number, time: number): SessionEvent {
  return {
    type: 'verification/result',
    seq: seq(s),
    time,
    data: {
      taskId: brandString<TaskId>(task),
      revision: 1,
      status,
      criterionResults: [{ criterionId: 'build', status, evidence: [] }],
      commands: [],
      verifierVersion: 'test',
    },
  }
}

function failureRecorded(kind: FailureKind, s: number, time: number): SessionEvent {
  return {
    type: 'failure/recorded',
    seq: seq(s),
    time,
    data: { failureId: brandString<FailureId>(`f-${String(s)}`), kind, detail: 'the run stopped', at: time },
  }
}

/** One delegation the parent handed to a child run. */
function delegationIssued(childRun: string, s: number, time: number): SessionEvent {
  return {
    type: 'delegation/issued',
    seq: seq(s),
    time,
    data: {
      delegationId: brandString<DelegationId>(`d-${String(s)}`),
      childRunId: brandString<RunId>(childRun),
      parentSessionId: SessionId('s1'),
      allowedCapabilities: [],
      resourceLimits: { maxSteps: 3 },
      writableScopes: [],
      inheritedPolicyDigest: 'digest',
      depth: 1,
      at: time,
    },
  }
}

/** One context placement, carrying only the identity the trace reads. */
function contextCompiled(s: number, time: number, digest: string): SessionEvent {
  const record: ContextCompilationRecord = {
    digest,
    compilerVersion: 'c1',
    maxTokens: null,
    tokenEstimate: 10,
    included: [],
    omitted: [],
    conflicts: [],
  }
  return { type: 'context/compiled', seq: seq(s), time, data: record }
}

/**
 * A log that holds three runs: one completed with a delegated child and a
 * priced usage sample, one failed by its own transition, and one cancelled by
 * its turn end.
 */
function threeRuns(): readonly SessionEvent[] {
  return [
    // Run 1: one step, one settled tool call, one child, one passing verification.
    taskCreated('run-1', 'task-1', 'executing', 0, 1000),
    turnStart(1, 1, 1010),
    stepStart(1, 0, 2, 1020),
    assistantMessage(1, 0, 3, 1030, { inputTokens: 100, outputTokens: 20 }),
    toolCall(1, 0, 'one', 4, 1040, 'bash'),
    toolResult(1, 0, 'one', 5, 1050),
    contextCompiled(6, 1060, 'ctx-1'),
    delegationIssued('run-child', 7, 1070),
    stepEnd(1, 0, 8, 1080),
    verificationResult('task-1', 'pass', 9, 1090),
    turnEnd(1, 10, 1100),
    transitioned('task-1', 'completed', 'verification-passed', 11, 1110),
    // Run 2: one step, no usage, and the kernel's own failure decision.
    taskCreated('run-2', 'task-2', 'executing', 12, 1200),
    turnStart(2, 13, 1210),
    stepStart(2, 0, 14, 1220),
    toolCall(2, 0, 'two', 15, 1230, 'bash'),
    toolResult(2, 0, 'two', 16, 1240),
    stepEnd(2, 0, 17, 1250),
    failureRecorded('verification-failed', 18, 1260),
    transitioned('task-2', 'failed', 'verification-failed', 19, 1270),
    // Run 3: aborted before any decision.
    taskCreated('run-3', 'task-3', 'executing', 20, 1300),
    turnStart(3, 21, 1310),
    stepStart(3, 0, 22, 1320),
    stepEnd(3, 0, 23, 1330),
    turnEnd(3, 24, 1340, { kind: 'aborted', reason: { kind: 'legacy' } }),
  ]
}

describe('run projection', () => {
  it('projects one trace per run, in creation order, with the fields the run recorded', () => {
    const runs = projectRuns('s1', threeRuns(), 500)

    expect(runs.map(run => run.runId)).toEqual(['run-1', 'run-2', 'run-3'])
    expect(runs.map(run => run.finalStatus)).toEqual(['success', 'failure', 'cancelled'])

    const completed = runs[0]
    expect(completed).toMatchObject({
      sessionId: 's1',
      taskId: 'task-1',
      profile: 'coding',
      startedAt: iso(1000),
      endedAt: iso(1110),
    })
    expect(completed?.steps.map(step => [step.turn, step.step])).toEqual([[1, 0]])
    expect(completed?.toolCalls.map(call => call.name)).toEqual(['bash'])
    expect(completed?.subagents).toHaveLength(1)
    expect(completed?.subagents[0]).toMatchObject({
      runId: 'run-child',
      depth: 1,
      turn: 1,
      step: 0,
      issuedAt: iso(1070),
    })
    expect(completed?.verification.map(result => result.status)).toEqual(['pass'])
    expect(completed?.context).toEqual({ compilations: 1, digests: ['ctx-1'], peakTokens: 10 })
    expect(completed?.budget).toEqual({
      limits: { maxSteps: 5 },
      steps: 1,
      toolCalls: 1,
      tokens: 120,
      wallMs: 110,
      costUsd: null,
      childDepth: 1,
    })
  })

  it('reads a failed run and a cancelled run from the record that ended each', () => {
    const runs = projectRuns('s1', threeRuns(), 500)
    const failed = runs[1]
    const cancelled = runs[2]

    // The kernel's own terminal transition outranks the turn that preceded it.
    expect(failed).toMatchObject({ endedAt: iso(1270), finalStatus: 'failure' })
    expect(failed?.budget).toMatchObject({ steps: 1, toolCalls: 1, tokens: 0, costUsd: null })
    expect(failed?.verification).toEqual([])
    // An aborted turn is the newest standing record, so it ends the run.
    expect(cancelled).toMatchObject({ endedAt: iso(1340), finalStatus: 'cancelled' })
    expect(cancelled?.steps.map(step => [step.turn, step.step])).toEqual([[3, 0]])
    expect(cancelled?.budget.toolCalls).toBe(0)
  })

  it('holds no run for a log that recorded no task contract', () => {
    const events = [turnStart(1, 0, 1000), stepStart(1, 0, 1, 1010), stepEnd(1, 0, 2, 1020), turnEnd(1, 3, 1030)]

    expect(projectRuns('s1', events, 500)).toEqual([])
  })
})
