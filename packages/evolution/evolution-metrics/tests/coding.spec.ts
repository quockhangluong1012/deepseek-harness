/**
 * The §13.2 coding metric set: the fold over one session's events, the nine
 * readings over a window of folds, and the service that reads the window's
 * logs from session storage.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { MessageId, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  ActionId,
  DelegationId,
  FailureId,
  PolicyDecisionId,
  RunId,
  TaskId,
  TransitionId,
} from '@deepseek-ai/dsh-agent-kernel'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { codingMetrics, readCodingSession } from '../src/coding.ts'
import EvolutionMetrics, { resolveConfig } from '../src/index.ts'
import type { CodingReport, MetricValue } from '../src/index.ts'

const seq = (n: number): SessionSeq => SessionSeq(n)
const at = (ms: number): string => new Date(ms).toISOString()
const sessionId = (id: string): SessionId => SessionId(id)

/** One task contract, at creation. */
function taskCreated(id: string, s: number, time: number): SessionEvent {
  return {
    type: 'task/created',
    seq: seq(s),
    time,
    data: {
      taskId: brandString<TaskId>(id),
      runId: brandString<RunId>(`run-${id}`),
      objective: 'ship the change',
      constraints: [],
      acceptance: [],
      dependencies: [],
      evidence: [],
      agentProfile: 'default',
      policyProfile: 'default',
      budget: {},
      status: 'intake',
      revision: 1,
    },
  }
}

/** One terminal transition of a task. */
function transitioned(id: string, to: 'completed' | 'failed', s: number, time: number): SessionEvent {
  return {
    type: 'task/transitioned',
    seq: seq(s),
    time,
    data: {
      transitionId: brandString<TransitionId>(`tr-${String(s)}`),
      taskId: brandString<TaskId>(id),
      from: 'verifying',
      to,
      trigger: { kind: to === 'completed' ? 'verification-passed' : 'verification-failed' },
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

/** One verification result carrying a single criterion. */
function verified(
  id: string,
  criterion: string,
  status: 'pass' | 'fail' | 'unknown',
  s: number,
  time: number,
): SessionEvent {
  return {
    type: 'verification/result',
    seq: seq(s),
    time,
    data: {
      taskId: brandString<TaskId>(id),
      revision: 1,
      status,
      criterionResults: [{ criterionId: criterion, status, evidence: [] }],
      commands: [],
      verifierVersion: 'test',
    },
  }
}

/** One recorded failure, optionally answered by a recovery decision. */
function failed(recovery: boolean, s: number, time: number): SessionEvent[] {
  const failureId = brandString<FailureId>(`f-${String(s)}`)
  const failure: SessionEvent = {
    type: 'failure/recorded',
    seq: seq(s),
    time,
    data: { failureId, kind: 'verification-failed', detail: 'the criterion failed', at: time },
  }
  if (!recovery) return [failure]
  return [failure, {
    type: 'recovery/decided',
    seq: seq(s + 1),
    time: time + 1,
    data: { failureId, action: 'diagnose', retryable: false, attemptsRemaining: 0, checkpointRequired: false, reason: 'diagnose it', at: time + 1 },
  }]
}

/** One model step's settled message, with the usage the adapter reported. */
function assistant(
  turn: number,
  step: number,
  s: number,
  time: number,
  usage?: TokenUsage,
): SessionEvent {
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
        id: brandString<MessageId>(`m-${String(s)}`),
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'model', provider: 'test', model: 'test' },
      },
    },
  }
}

/**
 * One settled tool call: the `tool/call` the failure rate's denominator counts
 * and the `action/committed` receipt its numerator reads.
 * @param name - registered tool name.
 * @param outcome - what the receipt reported.
 * @param s - first sequence number.
 * @param time - instant of the call.
 * @returns the call and its receipt.
 */
function settledCall(name: string, outcome: 'succeeded' | 'failed', s: number, time: number): SessionEvent[] {
  const callId = ToolCallId(`${name}-${String(s)}`)
  return [
    { type: 'tool/call', seq: seq(s), time, data: { turn: 1, step: 1, callId, name, arguments: '{}' } },
    {
      type: 'action/committed',
      seq: seq(s + 1),
      time: time + 1,
      data: {
        actionId: brandString<ActionId>(`action-${name}-${String(s)}`),
        toolName: name,
        decisionId: brandString<PolicyDecisionId>(`decision-${String(s)}`),
        outcome,
        committedAt: time + 1,
        revoked: [],
      },
    },
  ]
}

/** One failure the trace projection reads as a detected loop. */
function loopFailure(s: number, time: number): SessionEvent {
  return {
    type: 'failure/recorded',
    seq: seq(s),
    time,
    data: {
      failureId: brandString<FailureId>(`loop-${String(s)}`),
      kind: 'no-progress',
      detail: 'the same call returned the same result twice',
      at: time,
    },
  }
}

/** One delegated child run the session received. */
function delegationReceived(s: number, time: number): SessionEvent {
  return {
    type: 'delegation/received',
    seq: seq(s),
    time,
    data: {
      delegationId: brandString<DelegationId>(`d-${String(s)}`),
      childRunId: brandString<RunId>(`child-${String(s)}`),
      parentSessionId: sessionId('parent'),
      allowedCapabilities: [],
      resourceLimits: {},
      writableScopes: [],
      inheritedPolicyDigest: 'digest',
      depth: 1,
      at: time,
    },
  }
}

/** The session of a coding run that ended in a contradicted completion. */
function codingRun(): readonly SessionEvent[] {
  return [
    taskCreated('t1', 0, 1000),
    { type: 'turn/start', seq: seq(1), time: 1010, data: { turn: 1 } },
    assistant(1, 1, 2, 1100, { inputTokens: 100, outputTokens: 20 }),
    { type: 'turn/end', seq: seq(3), time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
    verified('t1', 'build', 'pass', 4, 1300),
    transitioned('t1', 'completed', 5, 1310),
    // The completion is contradicted: a later verification fails the same
    // criterion, and a human files the result back.
    verified('t1', 'build', 'fail', 6, 1400),
    { type: 'feedback/record', seq: seq(7), time: 1410, data: { category: 'task-result', text: 'that broke it' } },
    // A second criterion that held across both of its runs.
    verified('t1', 'lint', 'pass', 8, 1420),
    verified('t1', 'lint', 'pass', 9, 1430),
    {
      type: 'todo/write',
      seq: seq(10),
      time: 1440,
      data: { todos: [
        { content: 'map the change', status: 'completed' },
        { content: 'write it', status: 'in_progress' },
        { content: 'verify it', status: 'pending' },
      ] },
    },
    { type: 'approval/asked', seq: seq(11), time: 1450, data: { id: ApprovalRequestId('a-1'), toolName: 'bash' } },
    { type: 'approval/asked', seq: seq(12), time: 1460, data: { id: ApprovalRequestId('a-2'), toolName: 'edit' } },
    ...failed(true, 13, 1470),
    ...failed(false, 15, 1480),
    transitioned('t1', 'failed', 16, 1500),
  ]
}

/** The metric with this id from a coding report. */
function value(report: CodingReport, id: string): MetricValue {
  const found = report.metrics.find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no metric '${id}' in the report`)
  return found
}

describe('the coding fold', () => {
  it('folds the counters the kernel owns and the ordered evidence it cannot', () => {
    const fold = readCodingSession('s1', codingRun())

    expect(fold.updatedAt).toBe(at(1500))
    // Every counter here is the kernel's own fold over the same events.
    expect(fold.kernel).toMatchObject({
      tasksCreated: 1,
      taskOutcomes: { completed: 1, failed: 1 },
      verifications: 4,
      verificationsPassed: 3,
      failuresByKind: { 'verification-failed': 2 },
      recoveryByAction: { diagnose: 1 },
      failuresWithoutRecovery: 1,
    })
    // One completion the passing verification certified, one a later failure
    // and remark contradicted, over the four records that followed it.
    expect(fold.certifiedCompletions).toBe(1)
    expect(fold.contradictedCompletions).toBe(1)
    expect(fold.laterObservations).toBe(4)
    // `build` passed then failed; `lint` held twice.
    expect(fold.regressedCriteria).toBe(1)
    expect(fold.checkedCriteria).toBe(2)
    expect(fold.plannedItems).toBe(3)
    expect(fold.plannedDone).toBe(1)
    expect(fold.interventions).toBe(2)
    expect(fold.tokens).toBe(120)
    expect(fold.latencyMs).toBe(190)
  })

  it('reads an empty log as no instant and no evidence', () => {
    const fold = readCodingSession('s1', [])

    expect(fold.updatedAt).toBeNull()
    expect(fold.kernel.tasksCreated).toBe(0)
    expect(fold.tokens).toBe(0)
    expect(fold.latencyMs).toBe(0)
  })

  it('ignores a turn that never opened and a criterion observed once', () => {
    const fold = readCodingSession('s1', [
      { type: 'turn/end', seq: seq(0), time: 500, data: { turn: 9, reason: { kind: 'completed' } } },
      taskCreated('t1', 1, 1000),
      verified('t1', 'probe', 'unknown', 2, 1100),
      { type: 'verification/result', seq: seq(3), time: 1200, data: {
        taskId: brandString<TaskId>('t1'),
        revision: 1,
        status: 'fail',
        criterionResults: [],
        commands: [],
        verifierVersion: 'test',
      } },
    ])

    // A `turn/end` with no `turn/start` spans nothing, and a criterion the
    // verifier never answered twice is not a population a regression appears in.
    expect(fold.latencyMs).toBe(0)
    expect(fold.checkedCriteria).toBe(0)
    expect(fold.regressedCriteria).toBe(0)
    expect(fold.kernel.verifications).toBe(2)
    expect(fold.kernel.verificationsPassed).toBe(0)
  })

  it('does not count a criterion that failed before it passed', () => {
    const fold = readCodingSession('s1', [
      verified('t1', 'build', 'fail', 0, 1000),
      verified('t1', 'build', 'pass', 1, 1100),
    ])

    expect(fold.checkedCriteria).toBe(1)
    expect(fold.regressedCriteria).toBe(0)
  })

  it('counts only the remarks whose category reports the work back', () => {
    const fold = readCodingSession('s1', [
      taskCreated('t1', 0, 1000),
      transitioned('t1', 'completed', 1, 1010),
      { type: 'feedback/record', seq: seq(2), time: 1020, data: { text: 'no category' } },
      { type: 'feedback/record', seq: seq(3), time: 1030, data: { category: 'resource-cost' } },
      { type: 'feedback/record', seq: seq(4), time: 1040, data: { category: 'instruction-following', text: 'wrong file' } },
    ])

    // Three remarks followed the completion; one of them contradicts it.
    expect(fold.laterObservations).toBe(3)
    expect(fold.contradictedCompletions).toBe(1)
  })

  it('counts no plan item done when the snapshot marks none', () => {
    const fold = readCodingSession('s1', [{
      type: 'todo/write',
      seq: seq(0),
      time: 1000,
      data: { todos: [{ content: 'write it', status: 'pending' }] },
    }])

    expect(fold.plannedItems).toBe(1)
    expect(fold.plannedDone).toBe(0)
  })

  it('reads a message that reported no usage and a turn it never closed', () => {
    const fold = readCodingSession('s1', [
      assistant(1, 1, 0, 1000),
      { type: 'turn/start', seq: seq(1), time: 1010, data: { turn: 1 } },
    ])

    expect(fold.tokens).toBe(0)
    expect(fold.latencyMs).toBe(0)
  })

  it('keeps the newest recorded instant when a log is out of order', () => {
    const fold = readCodingSession('s1', [
      assistant(1, 1, 0, 1000, { inputTokens: 1, outputTokens: 1 }),
      { type: 'turn/end', seq: seq(1), time: 900, data: { turn: 1, reason: { kind: 'completed' } } },
    ])

    expect(fold.updatedAt).toBe(at(1000))
  })
})

describe('the coding metrics', () => {
  it('reports the readings of a session that ended in a contradicted completion', () => {
    const metrics = codingMetrics([readCodingSession('s1', codingRun())], 'unused')

    expect(metrics.map(entry => entry.id)).toEqual([
      'verified-success',
      'false-completion',
      'regression-rate',
      'recovery-efficiency',
      'planning-fidelity',
      'verification-coverage',
      'human-intervention',
      'cost',
      'average-tokens',
      'latency',
      'loop-rate',
      'tool-failure-rate',
      'subagent-waste',
      'context-utilization',
      'verified-success-per-usd',
      'verified-success-per-million-tokens',
      'verified-success-per-10-minutes',
      'task-success-rate',
      'verification-pass-rate',
      'steps',
      'tool-calls',
      'policy-denials',
      'approval-rejections',
      'checkpoint-resume-rate',
    ])
    // One of the two terminal tasks completed and was verified.
    expect(metrics[0]?.value).toBe(0.5)
    // The one completion was contradicted by a later failing verification.
    expect(metrics[1]?.value).toBe(1)
    // One of the two observed criteria regressed.
    expect(metrics[2]?.value).toBe(0.5)
    // One of the two failures was answered by a recovery decision.
    expect(metrics[3]?.value).toBe(0.5)
    expect(metrics[4]?.value).toBeCloseTo(1 / 3, 12)
    expect(metrics[5]?.value).toBe(1)
    // Two approval questions per task opened.
    expect(metrics[6]?.value).toBe(2)
    expect(metrics[8]?.value).toBe(120)
    expect(metrics[8]?.unit).toBe('tokens')
    expect(metrics[9]?.value).toBe(190)
    expect(metrics[9]?.unit).toBe('milliseconds')
    // The deployment states no price, so both dollar readings name it.
    expect(metrics[7]?.value).toBeNull()
    expect(metrics[7]?.unavailableReason).toContain('`usdPerMillionTokens`')
    expect(metrics[14]?.value).toBeNull()
    expect(metrics[14]?.unavailableReason).toContain('`usdPerMillionTokens`')
    // The one task session recorded no loop failure, so the rate is a real zero.
    expect(metrics[10]?.value).toBe(0)
    // Nothing observed a tool call, a delegation, or a request window.
    expect(metrics[11]?.unavailableReason).toContain('no tool call is recorded')
    expect(metrics[12]?.unavailableReason).toContain('no delegated child run is recorded')
    expect(metrics[13]?.unavailableReason).toContain('no request reported both a prompt size and a context window')
    // One certified completion over 120 billed tokens and 190ms of closed turns.
    expect(metrics[15]?.value).toBeCloseTo(1e6 / 120, 6)
    expect(metrics[16]?.value).toBeCloseTo(600_000 / 190, 6)
    // The §18.3 kernel counters: one of two terminal tasks completed, three of
    // four verifications passed, and the window recorded no step, tool call,
    // policy denial, or approval rejection at all.
    expect(metrics[17]?.value).toBe(0.5)
    expect(metrics[18]?.value).toBe(0.75)
    expect(metrics[19]?.value).toBe(0)
    expect(metrics[19]?.unit).toBe('count')
    expect(metrics[20]?.value).toBe(0)
    expect(metrics[21]?.value).toBe(0)
    expect(metrics[22]?.value).toBe(0)
    expect(metrics[23]?.unavailableReason).toContain('no checkpoint is recorded')
  })

  it('aggregates the window rather than one session', () => {
    const metrics = codingMetrics([
      readCodingSession('s1', codingRun()),
      readCodingSession('s2', [
        taskCreated('t2', 0, 2000),
        verified('t2', 'build', 'pass', 1, 2010),
        transitioned('t2', 'completed', 2, 2020),
        assistant(1, 1, 3, 2030, { inputTokens: 40, outputTokens: 20 }),
        { type: 'turn/start', seq: seq(4), time: 2040, data: { turn: 1 } },
        { type: 'turn/end', seq: seq(5), time: 2060, data: { turn: 1, reason: { kind: 'completed' } } },
      ]),
    ], 'unused')

    // Two certified completions of the three terminal tasks.
    expect(metrics[0]?.value).toBeCloseTo(2 / 3, 12)
    // Only one of the two completions was contradicted.
    expect(metrics[1]?.value).toBe(0.5)
    // Both task-opening sessions ran a verification.
    expect(metrics[5]?.value).toBe(1)
    // The same two approval questions now stand over two tasks.
    expect(metrics[6]?.value).toBe(1)
    expect(metrics[8]?.value).toBe(90)
    expect(metrics[9]?.value).toBe(105)
  })

  it('reports every reading as unmeasurable when the window is empty', () => {
    const metrics = codingMetrics([], 'the session persistence store is not mounted')

    expect(metrics).toHaveLength(24)
    for (const entry of metrics) {
      expect(entry.value, entry.id).toBeNull()
      expect(entry.unavailableReason, entry.id).toBe('the session persistence store is not mounted')
    }
  })

  it('names the record each metric is missing in a window that holds no work', () => {
    const metrics = codingMetrics([readCodingSession('s1', [taskCreated('t1', 0, 1000)])], 'unused')
    const reason = (id: string): string | null => metrics.find(entry => entry.id === id)?.unavailableReason ?? null

    // A task opened but nothing measured it, so only the rates with a
    // denominator report a zero.
    expect(metrics.find(entry => entry.id === 'verification-coverage')?.value).toBe(0)
    expect(metrics.find(entry => entry.id === 'human-intervention')?.value).toBe(0)
    expect(reason('verified-success')).toContain('no task in the window reached a terminal status')
    expect(reason('false-completion')).toContain('no completion is recorded')
    expect(reason('regression-rate')).toContain('no criterion is observed twice')
    expect(reason('recovery-efficiency')).toContain('no failure is recorded')
    expect(reason('planning-fidelity')).toContain('no plan with tracked statuses is recorded')
    expect(reason('average-tokens')).toContain('assistant/message.usage')
    expect(reason('latency')).toContain('turn/start` and `turn/end')
    // The §5.4 readings name their own missing records too.
    expect(metrics.find(entry => entry.id === 'loop-rate')?.value).toBe(0)
    expect(reason('tool-failure-rate')).toContain('no tool call is recorded')
    expect(reason('subagent-waste')).toContain('no delegated child run is recorded')
    expect(reason('context-utilization')).toContain('no request reported both a prompt size and a context window')
    expect(reason('cost')).toContain('no settled assistant message reported usage')
    expect(reason('verified-success-per-usd')).toContain('no task in the window reached a terminal status')
    expect(reason('verified-success-per-million-tokens')).toContain('no task in the window reached a terminal status')
    expect(reason('verified-success-per-10-minutes')).toContain('no task in the window reached a terminal status')
    // The §18.3 counters read the kernel's own fold: a rate names the record
    // its denominator is missing, and a counter over no events is a real zero.
    expect(metrics.find(entry => entry.id === 'steps')?.value).toBe(0)
    expect(metrics.find(entry => entry.id === 'tool-calls')?.value).toBe(0)
    expect(metrics.find(entry => entry.id === 'policy-denials')?.value).toBe(0)
    expect(metrics.find(entry => entry.id === 'approval-rejections')?.value).toBe(0)
    expect(reason('task-success-rate')).toContain('no task in the window reached a terminal status')
    expect(reason('verification-pass-rate')).toContain('no verification result is recorded')
    expect(reason('checkpoint-resume-rate')).toContain('no checkpoint is recorded')
  })

  it('names the producers a false completion would need when nothing re-checked the work', () => {
    const metrics = codingMetrics([
      readCodingSession('s1', [
        taskCreated('t1', 0, 1000),
        verified('t1', 'build', 'pass', 1, 1010),
        transitioned('t1', 'completed', 2, 1020),
      ]),
    ], 'unused')
    const falseCompletion = metrics.find(entry => entry.id === 'false-completion')

    expect(falseCompletion?.value).toBeNull()
    expect(falseCompletion?.unavailableReason).toContain('nothing could contradict one')
    expect(falseCompletion?.unavailableReason).toContain('`verification/result` only when its completion gate runs again')
    // The completion itself is certified, so the verified-success rate is real.
    expect(metrics.find(entry => entry.id === 'verified-success')?.value).toBe(1)
  })

  it('counts the tokens of a turn that reported usage even before it closes', () => {
    const metrics = codingMetrics([readCodingSession('s1', [assistant(1, 1, 0, 1000, { inputTokens: 5, outputTokens: 5 })])], 'unused')

    expect(metrics.find(entry => entry.id === 'average-tokens')?.value).toBe(10)
    expect(metrics.find(entry => entry.id === 'latency')?.unavailableReason).toContain('no closed turn is recorded')
  })

  it('measures the latency of a closed turn that reported no usage', () => {
    const metrics = codingMetrics([readCodingSession('s1', [
      { type: 'turn/start', seq: seq(0), time: 1000, data: { turn: 1 } },
      { type: 'turn/end', seq: seq(1), time: 1250, data: { turn: 1, reason: { kind: 'completed' } } },
    ])], 'unused')

    expect(metrics.find(entry => entry.id === 'latency')?.value).toBe(250)
    expect(metrics.find(entry => entry.id === 'average-tokens')?.unavailableReason)
      .toContain('no settled assistant message reported usage')
  })

  it('prices the window\'s billed tokens at the deployment\'s flat price', () => {
    const metrics = codingMetrics([
      readCodingSession('s1', [
        taskCreated('t1', 0, 1000),
        { type: 'turn/start', seq: seq(1), time: 1010, data: { turn: 1 } },
        assistant(1, 1, 2, 1100, { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 0 }),
        { type: 'turn/end', seq: seq(3), time: 1200, data: { turn: 1, reason: { kind: 'completed' } } },
        verified('t1', 'build', 'pass', 4, 1300),
        transitioned('t1', 'completed', 5, 1310),
      ], 3),
    ], 'unused')
    const reading = (id: string): number | null | undefined => metrics.find(entry => entry.id === id)?.value

    // The billed side is the uncached prompt plus both cache buckets plus the
    // completion: 1000 + 8000 + 0 + 200 tokens.
    expect(reading('average-tokens')).toBe(9200)
    expect(reading('cost')).toBeCloseTo(9200 * 3 / 1_000_000, 12)
    expect(metrics.find(entry => entry.id === 'cost')?.unit).toBe('usd')
    expect(reading('verified-success-per-usd')).toBeCloseTo(1_000_000 / (9200 * 3), 6)
    expect(reading('verified-success-per-million-tokens')).toBeCloseTo(1_000_000 / 9200, 6)
    expect(reading('verified-success-per-10-minutes')).toBeCloseTo(600_000 / 190, 6)
  })

  it('reports a dollar denominator of zero as unmeasurable, never as an infinite ratio', () => {
    const metrics = codingMetrics([readCodingSession('s1', [
      taskCreated('t1', 0, 1000),
      verified('t1', 'build', 'pass', 1, 1010),
      transitioned('t1', 'completed', 2, 1020),
    ], 3)], 'unused')

    // Nothing was billed, so there is no spend to divide by.
    expect(metrics.find(entry => entry.id === 'cost')?.value).toBeNull()
    expect(metrics.find(entry => entry.id === 'cost')?.unavailableReason)
      .toContain('no settled assistant message reported usage')
    const perUsd = metrics.find(entry => entry.id === 'verified-success-per-usd')
    expect(perUsd?.value).toBeNull()
    expect(perUsd?.unavailableReason).toBe('the window recorded no priced spend')
    expect(metrics.find(entry => entry.id === 'verified-success-per-million-tokens')?.unavailableReason)
      .toBe('the window spent no billed tokens')
  })

  it('reads the loop, tool-failure, delegation, and occupancy readings from their own records', () => {
    const metrics = codingMetrics([readCodingSession('s1', [
      taskCreated('t1', 0, 1000),
      { type: 'turn/start', seq: seq(1), time: 1010, data: { turn: 1 } },
      ...settledCall('bash', 'failed', 2, 1020),
      ...settledCall('edit', 'succeeded', 4, 1040),
      assistant(1, 1, 6, 1060, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 400, cacheWriteTokens: 0 }),
      { type: 'turn/end', seq: seq(7), time: 1070, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'request/context', seq: seq(8), time: 1080, data: { provider: 'test', model: 'test', contextWindow: 1000 } },
      loopFailure(9, 1090),
      delegationReceived(10, 1100),
    ])], 'unused')
    const reading = (id: string): number | null | undefined => metrics.find(entry => entry.id === id)?.value

    // One of the two settled tool calls failed.
    expect(reading('tool-failure-rate')).toBe(0.5)
    // The one task session recorded the `no-progress` failure.
    expect(reading('loop-rate')).toBe(1)
    // The session received one delegation and completed no task in it.
    expect(reading('subagent-waste')).toBe(1)
    // The largest prompt side was 100 uncached plus 400 cached of a 1000-token window.
    expect(reading('context-utilization')).toBe(0.5)
  })

  it('counts a child session that completed its own task as productive, not waste', () => {
    const metrics = codingMetrics([readCodingSession('s1', [
      delegationReceived(0, 1000),
      taskCreated('t-child', 1, 1010),
      transitioned('t-child', 'completed', 2, 1020),
    ])], 'unused')

    expect(metrics.find(entry => entry.id === 'subagent-waste')?.value).toBe(0)
  })
})

describe('the coding report service', () => {
  /** A stored session: its header and its committed log. */
  interface Stored {
    readonly header: SessionHeader
    readonly events: readonly SessionEvent[]
  }

  /** Mount the metric layer over a stub of the session storage seam. */
  async function boot(options: {
    stored?: readonly Stored[]
    config?: Record<string, unknown>
    persistence?: boolean
  } = {}): Promise<{ ctx: Context; metrics: EvolutionMetrics; opened: string[] }> {
    const ctx = new Context()
    const opened: string[] = []
    const stored = options.stored ?? []
    if (options.persistence !== false) {
      ctx.provide('sessionPersistence', {
        list: async () => stored.map(row => ({ header: row.header, revision: 'r' })),
        open: async (id: SessionId) => {
          opened.push(String(id))
          const row = stored.find(candidate => String(candidate.header.id) === String(id))
          return {
            read: async () => ({ eventState: 'detached', events: row?.events ?? [] }),
            close: async () => {},
          }
        },
      } as never)
    }
    const metrics = await ctx.plugin(EvolutionMetrics, options.config ?? {}).then(() => ctx.evolutionMetrics)
    return { ctx, metrics, opened }
  }

  /** One stored session header. */
  function header(id: string, createdAt: number): SessionHeader {
    return { version: SESSION_FORMAT_VERSION, id: sessionId(id), createdAt, isSeeded: false }
  }

  it('resolves the coding window default without changing the run window', () => {
    expect(resolveConfig({})).toEqual({
      windowRuns: 200,
      minimumRunsPerHalf: 2,
      maxSignals: 50,
      maxSessions: 200,
      maxOutcomes: 200,
      usdPerMillionTokens: undefined,
    })
    expect(resolveConfig({ maxSessions: 3 }).maxSessions).toBe(3)
  })

  it('keeps the deployment\'s price and rejects one no dollar reading could use', () => {
    expect(resolveConfig({ usdPerMillionTokens: 2.5 }).usdPerMillionTokens).toBe(2.5)
    expect(() => resolveConfig({ usdPerMillionTokens: 0 }))
      .toThrow('usdPerMillionTokens must be a positive finite number')
    expect(() => resolveConfig({ usdPerMillionTokens: Number.POSITIVE_INFINITY }))
      .toThrow('usdPerMillionTokens must be a positive finite number')
  })

  it('folds every listed session into the window, newest first, and skips an empty log', async () => {
    const { metrics } = await boot({ stored: [
      { header: header('s1', 1000), events: codingRun() },
      { header: header('s2', 5000), events: [] },
    ] })

    const report = await metrics.coding()

    expect(report.window).toEqual({ sessions: 1, from: at(1500), to: at(1500) })
    expect(value(report, 'verified-success').value).toBe(0.5)
    expect(value(report, 'average-tokens').value).toBe(120)
  })

  it('prices every folded session at the configured price', async () => {
    const { metrics } = await boot({
      config: { usdPerMillionTokens: 2 },
      stored: [{ header: header('s1', 1000), events: codingRun() }],
    })

    const report = await metrics.coding()

    expect(value(report, 'cost').value).toBeCloseTo((120 * 2) / 1_000_000, 12)
    expect(value(report, 'cost').unavailableReason).toBeNull()
  })

  it('bounds the sessions it reads by createdAt and the window by the query', async () => {
    const { metrics, opened } = await boot({
      config: { maxSessions: 2 },
      stored: [
        { header: header('old', 1000), events: [taskCreated('t-old', 0, 1000)] },
        { header: header('middle', 2000), events: [taskCreated('t-middle', 0, 2000)] },
        { header: header('new', 3000), events: [taskCreated('t-new', 0, 3000)] },
      ],
    })

    const all = await metrics.coding()

    // The newest two are read; the oldest is never opened.
    expect(opened.sort()).toEqual(['middle', 'new'])
    expect(all.window).toEqual({ sessions: 2, from: at(2000), to: at(3000) })
    expect(value(all, 'human-intervention').value).toBe(0)

    // The bounds and the limit narrow the folded window further.
    expect((await metrics.coding({ since: at(3000) })).window).toEqual({ sessions: 1, from: at(3000), to: at(3000) })
    expect((await metrics.coding({ until: at(2000) })).window).toEqual({ sessions: 1, from: at(2000), to: at(2000) })
    expect((await metrics.coding({ limit: 1 })).window).toEqual({ sessions: 1, from: at(3000), to: at(3000) })
    expect(value(await metrics.coding({ limit: 1 }), 'verification-coverage').value).toBe(0)
  })

  it('breaks a createdAt tie by session id so the read order is stable', async () => {
    const { metrics, opened } = await boot({ stored: [
      { header: header('b', 1000), events: [taskCreated('t-b', 0, 1000)] },
      { header: header('a', 1000), events: [taskCreated('t-a', 0, 1000)] },
    ] })

    await metrics.coding()

    expect(opened).toEqual(['a', 'b'])
  })

  it('reports the whole coding set as unmeasurable when session storage is not mounted', async () => {
    const { metrics } = await boot({ persistence: false })

    const report = await metrics.coding()

    expect(report.window).toEqual({ sessions: 0, from: null, to: null })
    for (const entry of report.metrics) {
      expect(entry.value, entry.id).toBeNull()
      expect(entry.unavailableReason, entry.id)
        .toBe('the session persistence store is not mounted, so no recorded session is read')
    }
  })

  it('reports an empty window when storage lists no session with an event', async () => {
    const { metrics } = await boot({ stored: [{ header: header('s1', 1000), events: [] }] })

    const report = await metrics.coding()

    expect(report.window).toEqual({ sessions: 0, from: null, to: null })
    expect(value(report, 'average-tokens').unavailableReason)
      .toBe('the session store lists no session with a recorded event')
  })
})
