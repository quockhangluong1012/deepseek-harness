import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContextCompilationRecord } from '@deepseek-ai/dsh-agent-context'
import type { TaskId } from '@deepseek-ai/dsh-agent-kernel'
import type { MessageId, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { project, sumUsage } from '../src/index.ts'

type EndReason = SessionEventMap['turn/end']['reason']

const seq = (n: number): SessionSeq => SessionSeq(n)
const mid = (n: number): MessageId => brandString<MessageId>(`m${n}`)
const cid = (n: string): ToolCallId => ToolCallId(`c${n}`)

function turnStart(turn: number, s: number, time: number): SessionEvent {
  return { type: 'turn/start', seq: seq(s), time, data: { turn } }
}

function userMessage(s: number, time: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: seq(s),
    time,
    data: {
      id: mid(s),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    },
    surfaceOp: 'append',
  }
}

function stepStart(turn: number, step: number, s: number, time: number): SessionEvent {
  return { type: 'step/start', seq: seq(s), time, data: { turn, step } }
}

function stepEnd(turn: number, step: number, s: number, time: number): SessionEvent {
  return { type: 'step/end', seq: seq(s), time, data: { turn, step } }
}

function assistantMessage(turn: number, step: number, s: number, time: number, options: {
  usage?: TokenUsage
  interrupted?: boolean
} = {}): SessionEvent {
  return {
    type: 'assistant/message',
    seq: seq(s),
    time,
    data: {
      turn,
      step,
      message: {
        id: mid(s),
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${step}` }],
        source: { kind: 'model', provider: 'test', model: 'test-model' },
      },
      stream: [],
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.interrupted === true ? { interrupted: true } : {}),
    },
    surfaceOp: 'append',
  }
}

function assistantAttempt(turn: number, step: number, s: number, time: number): SessionEvent {
  return { type: 'assistant/attempt', seq: seq(s), time, data: { turn, step, stream: [] } }
}

function toolCall(turn: number, step: number, id: string, s: number, time: number, name: string, args = '{}'): SessionEvent {
  return { type: 'tool/call', seq: seq(s), time, data: { turn, step, callId: cid(id), name, arguments: args } }
}

function toolResult(turn: number, step: number, id: string, s: number, time: number, options: {
  isError?: boolean
  text?: string
  error?: { name: string; code: string }
} = {}): SessionEvent {
  const call = cid(id)
  return {
    type: 'tool/result',
    seq: seq(s),
    time,
    data: {
      turn,
      step,
      message: {
        id: mid(s),
        role: 'tool',
        content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
        toolCallId: call,
        ...(options.isError === true ? { isError: true } : {}),
        source: { kind: 'tool', callId: call },
      },
      ...(options.error === undefined ? {} : { error: options.error }),
    },
    surfaceOp: 'append',
  }
}

function turnEnd(turn: number, s: number, time: number, reason: EndReason = { kind: 'completed' }): SessionEvent {
  return {
    type: 'turn/end',
    seq: seq(s),
    time,
    data: { turn, reason },
  }
}

/** A compile record carrying only the identity the trace reads: its digest. */
function compilation(digest: string): ContextCompilationRecord {
  return {
    digest,
    compilerVersion: 'c1',
    maxTokens: null,
    tokenEstimate: 10,
    included: [],
    omitted: [],
    conflicts: [],
  }
}

function contextCompiled(s: number, time: number, digest: string): SessionEvent {
  return { type: 'context/compiled', seq: seq(s), time, data: compilation(digest) }
}

function todoWrite(s: number, time: number, todos: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[]): SessionEvent {
  return { type: 'todo/write', seq: seq(s), time, data: { todos: todos.map(todo => ({ ...todo })) } }
}

function taskPlan(s: number, time: number, steps: readonly string[]): SessionEvent {
  return { type: 'task/plan', seq: seq(s), time, data: { revision: 1, steps: [...steps], createdAt: time } }
}

function feedbackRecord(s: number, time: number, data: { text?: string; category?: 'task-result' }): SessionEvent {
  return { type: 'feedback/record', seq: seq(s), time, data }
}

function verificationResult(s: number, time: number, status: 'pass' | 'fail' | 'unknown'): SessionEvent {
  return {
    type: 'verification/result',
    seq: seq(s),
    time,
    data: {
      taskId: brandString<TaskId>('t1'),
      revision: 1,
      status,
      criterionResults: [{ criterionId: 'c1', status, evidence: [] }],
      commands: ['pnpm test'],
      verifierVersion: 'v1',
    },
  }
}

const record = (events: readonly SessionEvent[], maxChars = 500) => project('s1', events, maxChars)

/** The element at `index`, narrowed: a missing one fails the test loudly instead of typing as possibly absent. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index]
  if (value === undefined) throw new Error(`no element at index ${index}`)
  return value
}

describe('evolution trace projection', () => {
  it('projects an empty log into an empty trace', () => {
    const trace = record([])
    expect(trace).toEqual({
      sessionId: 's1',
      updatedAt: null,
      turnCount: 0,
      turns: [],
      usage: null,
      evaluations: [],
      feedback: [],
    })
  })

  it('records a complete turn: request gist, ok call, usage, latency, and reason', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      userMessage(1, 1001, '  deploy\n\n  the app  '),
      stepStart(0, 0, 2, 1002),
      assistantMessage(0, 0, 3, 1010, { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      toolCall(0, 0, 'a', 4, 1011, 'bash'),
      toolResult(0, 0, 'a', 5, 1020, { text: 'ok' }),
      turnEnd(0, 6, 1030, { kind: 'completed' }),
    ])
    expect(trace.turnCount).toBe(1)
    const turn = at(trace.turns, 0)
    expect(turn.request).toBe('deploy the app')
    expect(turn.endReason).toBe('completed')
    expect(turn.latencyMs).toBe(30)
    expect(turn.steps).toHaveLength(1)
    const step = at(turn.steps, 0)
    expect(step.finishedAt).toBe('1970-01-01T00:00:01.020Z')
    expect(step.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(step.calls[0]).toMatchObject({ callId: 'ca', name: 'bash', ok: true, message: null, errorName: null })
    expect(turn.failures).toEqual([])
    expect(trace.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
    expect(trace.updatedAt).toBe('1970-01-01T00:00:01.030Z')
  })

  it('skips non-text blocks when extracting the request gist', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      {
        type: 'user/message',
        seq: seq(1),
        time: 1001,
        data: {
          id: mid(1),
          role: 'user',
          content: [{ type: 'reasoning', text: 'think' }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      },
      turnEnd(0, 2, 1010),
    ])
    expect(trace.turns[0]?.request).toBeNull()
  })

  it('ranks a failing call with same-step, previous-step, retrieval, and request causes', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      userMessage(1, 1001, 'deploy the app'),
      stepStart(0, 0, 2, 1002),
      assistantMessage(0, 0, 3, 1003),
      toolCall(0, 0, 'skill1', 4, 1004, 'skill'),
      toolResult(0, 0, 'skill1', 5, 1005, { text: 'loaded' }),
      stepStart(0, 1, 6, 1006),
      assistantMessage(0, 1, 7, 1007),
      toolCall(0, 1, 'a', 8, 1008, 'bash'),
      toolResult(0, 1, 'a', 9, 1009, { text: 'prepared' }),
      toolCall(0, 1, 'b', 10, 1010, 'bash'),
      toolResult(0, 1, 'b', 11, 1020, {
        isError: true,
        text: 'command failed',
        error: { name: 'bash', code: 'EXIT_1' },
      }),
      turnEnd(0, 12, 1030),
    ])
    const failures = at(trace.turns, 0).failures
    expect(failures).toHaveLength(1)
    const failure = at(failures, 0)
    expect(failure).toMatchObject({ callId: 'cb', tool: 'bash', message: 'command failed' })
    expect(failure.causes.map(cause => cause.reason)).toEqual([
      'the call itself failed',
      'an earlier call in the same step may have produced the failing input',
      'the previous step produced the context this call consumed',
      'retrieval may have missed the knowledge this call needed',
      'the request may have been under-specified',
    ])
    expect(at(failure.causes, 1)).toMatchObject({ kind: 'tool', turn: 0, step: 1, tool: 'bash' })
    expect(at(failure.causes, 2)).toMatchObject({ kind: 'tool', turn: 0, step: 0, tool: 'skill' })
    expect(at(failure.causes, 3)).toMatchObject({ kind: 'retrieval', turn: 0, step: 0, tool: 'skill' })
    expect(at(failure.causes, 4)).toMatchObject({ kind: 'request', turn: 0, step: null, tool: null })
  })

  it('keeps the failing call as the only cause when no context exists', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'bash'),
      toolResult(0, 0, 'a', 3, 1003, { isError: true, text: 'boom' }),
      turnEnd(0, 4, 1004),
    ])
    const failure = at(at(trace.turns, 0).failures, 0)
    expect(failure.causes).toEqual([{
      kind: 'tool',
      turn: 0,
      step: 0,
      tool: 'bash',
      reason: 'the call itself failed',
    }])
  })

  it('counts retries and marks interruption', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      assistantAttempt(0, 0, 2, 1002),
      assistantAttempt(0, 0, 3, 1003),
      assistantMessage(0, 0, 4, 1004, { interrupted: true }),
      turnEnd(0, 5, 1010),
    ])
    const step = trace.turns[0]?.steps[0]
    expect(step?.retries).toBe(2)
    expect(step?.interrupted).toBe(true)
    expect(step?.finishedAt).toBe('1970-01-01T00:00:01.004Z')
  })

  it('drops unpaired calls and results, and messages before a turn opens', () => {
    const trace = record([
      userMessage(0, 1000, 'orphan'),
      turnStart(0, 1, 1001),
      stepStart(0, 0, 2, 1002),
      toolCall(0, 0, 'a', 3, 1003, 'bash'),
      toolResult(0, 0, 'missing', 4, 1004, { text: 'orphan result' }),
      turnEnd(0, 5, 1005),
    ])
    const turn = trace.turns[0]
    expect(turn?.request).toBeNull()
    expect(turn?.steps[0]?.calls).toEqual([])
    expect(turn?.failures).toEqual([])
  })

  it('leaves a step open with a null finish when it never settles', () => {
    const trace = record([turnStart(0, 0, 1000), stepStart(0, 0, 1, 1001), turnEnd(0, 2, 1002)])
    const step = trace.turns[0]?.steps[0]
    expect(step?.startedAt).toBe('1970-01-01T00:00:01.001Z')
    expect(step?.finishedAt).toBeNull()
  })

  it('clips and collapses failure text and falls back to the error code then the tool name', () => {
    const clipped = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'bash'),
      toolResult(0, 0, 'a', 3, 1003, { isError: true, text: 'x'.repeat(600) }),
      turnEnd(0, 4, 1004),
    ], 20)
    expect(clipped.turns[0]?.failures[0]?.message).toHaveLength(20)

    const coded = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'bash'),
      toolResult(0, 0, 'a', 3, 1003, { isError: true, text: '   \n  ', error: { name: 'bash', code: 'EXIT_1' } }),
      turnEnd(0, 4, 1004),
    ])
    expect(coded.turns[0]?.failures[0]?.message).toBe('EXIT_1')

    const textless = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'bash'),
      toolResult(0, 0, 'a', 3, 1003, { isError: true }),
      turnEnd(0, 4, 1004),
    ])
    expect(textless.turns[0]?.failures[0]?.message).toBe('bash')
  })

  it('keeps only the first user message as the turn request', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      userMessage(1, 1001, 'first'),
      userMessage(2, 1002, 'second'),
      turnEnd(0, 3, 1003),
    ])
    expect(trace.turns[0]?.request).toBe('first')
  })

  it('projects multiple turns in order and keeps an open turn open', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      userMessage(1, 1001, 'one'),
      turnEnd(0, 2, 1010, { kind: 'completed' }),
      turnStart(1, 3, 1011),
      userMessage(4, 1012, 'two'),
    ])
    expect(trace.turnCount).toBe(2)
    expect(trace.turns.map(turn => turn.turn)).toEqual([0, 1])
    expect(trace.turns[1]).toMatchObject({
      endedAt: null,
      endReason: null,
      latencyMs: null,
      request: 'two',
    })
  })

  it('sums usage across steps, carrying optional counters only when reported', () => {
    expect(sumUsage([null, null])).toBeNull()
    expect(sumUsage([
      { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 4, cacheWriteTokens: 5, reasoningTokens: 6 },
    ])).toEqual({
      inputTokens: 11,
      outputTokens: 22,
      totalTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 5,
      reasoningTokens: 6,
    })
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      assistantMessage(0, 0, 2, 1002, { usage: { inputTokens: 7, outputTokens: 8 } }),
      stepStart(0, 1, 3, 1003),
      turnEnd(0, 4, 1004),
    ])
    expect(trace.usage).toEqual({ inputTokens: 7, outputTokens: 8 })
  })

  it('sets updatedAt to the newest event time', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      userMessage(1, 3000, 'x'),
      turnEnd(0, 2, 2000),
    ])
    expect(trace.updatedAt).toBe('1970-01-01T00:00:03.000Z')
  })

  it('tolerates duplicated or foreign log structure and drops unmatched events', () => {
    const trace = record([
      { type: 'step/end', seq: seq(0), time: 1000, data: { turn: 0, step: 0 } },
      { type: 'request/context', seq: seq(1), time: 1000, data: { provider: 'p', model: 'm' } },
      turnStart(0, 2, 1000),
      turnStart(0, 3, 1000),
      stepStart(0, 0, 4, 1001),
      stepStart(0, 0, 5, 1001),
      stepStart(9, 0, 6, 1002),
      stepStart(0, 1, 7, 1003),
      stepEnd(0, 0, 8, 1003),
      assistantMessage(0, 7, 9, 1003),
      assistantAttempt(0, 7, 10, 1003),
      turnEnd(8, 11, 1004, { kind: 'completed' }),
      turnEnd(0, 12, 1005, { kind: 'completed' }),
      turnEnd(0, 13, 1006, { kind: 'max-steps' }),
    ])
    expect(trace.turnCount).toBe(1)
    expect(trace.turns[0]?.steps).toHaveLength(2)
    expect(trace.turns[0]?.steps[0]?.retries).toBe(0)
    expect(trace.turns[0]?.endReason).toBe('max-steps')
  })

  it('drops a failure whose result settles in a different turn than its call cited', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(5, 0, 'p', 2, 1002, 'bash'),
      toolResult(0, 0, 'p', 3, 1003, { isError: true, text: 'boom' }),
      turnEnd(0, 4, 1004, { kind: 'completed' }),
    ])
    const turn = trace.turns[0]
    expect(turn?.steps[0]?.calls).toHaveLength(1)
    expect(turn?.failures).toEqual([])
  })

  it('ranks a failure whose own step is untracked with only the failing call', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      stepStart(0, 9, 2, 1001),
      toolCall(0, 7, 'p', 3, 1002, 'bash'),
      toolResult(0, 0, 'p', 4, 1003, { isError: true, text: 'boom' }),
      turnEnd(0, 5, 1004, { kind: 'completed' }),
    ])
    const failures = trace.turns[0]?.failures ?? []
    expect(failures).toHaveLength(1)
    expect(failures[0]?.causes).toEqual([{
      kind: 'tool',
      turn: 0,
      step: 7,
      tool: 'bash',
      reason: 'the call itself failed',
    }])
  })
})

describe('evolution trace trajectory projection', () => {
  it('carries the compiled-context digest of the step in force, forward to the steps that follow', () => {
    const trace = record([
      contextCompiled(0, 1000, 'd0'),
      turnStart(0, 1, 1001),
      stepStart(0, 0, 2, 1002),
      stepEnd(0, 0, 3, 1003),
      contextCompiled(4, 1004, 'd1'),
      stepStart(0, 1, 5, 1005),
      contextCompiled(6, 1006, 'd2'),
      stepEnd(0, 1, 7, 1007),
      stepStart(0, 2, 8, 1008),
      stepEnd(0, 2, 9, 1009),
      turnEnd(0, 10, 1010),
    ])
    const steps = at(trace.turns, 0).steps
    expect(steps.map(step => step.context?.digest ?? null)).toEqual(['d0', 'd2', 'd2'])
  })

  it('binds a compilation to the step open at that instant, never to a step already closed', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      contextCompiled(2, 1002, 'late'),
      stepEnd(0, 0, 3, 1003),
      contextCompiled(4, 1004, 'between'),
      stepStart(0, 1, 5, 1005),
      stepEnd(0, 1, 6, 1006),
      turnEnd(0, 7, 1007),
    ])
    const steps = at(trace.turns, 0).steps
    expect(steps.map(step => step.context?.digest ?? null)).toEqual(['late', 'between'])
  })

  it('leaves the step context null when the log recorded no compilation', () => {
    const trace = record([turnStart(0, 0, 1000), stepStart(0, 0, 1, 1001), turnEnd(0, 2, 1002)])
    expect(at(at(trace.turns, 0).steps, 0).context).toBeNull()
  })

  it('projects a todo snapshot as the turn plan with each subgoal status', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      todoWrite(1, 1001, [
        { content: 'read the spec', status: 'completed' },
        { content: 'write the replay', status: 'in_progress' },
      ]),
      turnEnd(0, 2, 1002),
    ])
    expect(at(trace.turns, 0).subgoals).toEqual([
      { content: 'read the spec', status: 'completed' },
      { content: 'write the replay', status: 'in_progress' },
    ])
  })

  it('projects a kernel plan revision as subgoals without status, and carries the newest plan into later turns', () => {
    const trace = record([
      taskPlan(0, 1000, ['ship the trace']),
      turnStart(0, 1, 1001),
      turnEnd(0, 2, 1002),
      todoWrite(3, 1003, [{ content: 'and the replay', status: 'pending' }]),
      turnStart(1, 4, 1004),
      turnEnd(1, 5, 1005),
    ])
    expect(at(trace.turns, 0).subgoals).toEqual([{ content: 'ship the trace', status: null }])
    expect(at(trace.turns, 1).subgoals).toEqual([{ content: 'and the replay', status: 'pending' }])
  })

  it('updates the plan of the turn still open, and leaves a closed turn on the plan it ran under', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      todoWrite(1, 1001, [{ content: 'first attempt', status: 'in_progress' }]),
      todoWrite(2, 1002, [{ content: 'first attempt', status: 'completed' }]),
      turnEnd(0, 3, 1003),
      todoWrite(4, 1004, [{ content: 'next turn', status: 'pending' }]),
      turnStart(1, 5, 1005),
      turnEnd(1, 6, 1006),
    ])
    expect(at(trace.turns, 0).subgoals).toEqual([{ content: 'first attempt', status: 'completed' }])
    expect(at(trace.turns, 1).subgoals).toEqual([{ content: 'next turn', status: 'pending' }])
  })

  it('takes a kernel plan revision into the turn open when it arrives', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      taskPlan(1, 1001, ['amend the plan']),
      turnEnd(0, 2, 1002),
    ])
    expect(at(trace.turns, 0).subgoals).toEqual([{ content: 'amend the plan', status: null }])
  })

  it('leaves subgoals null for a turn recorded before any plan', () => {
    const trace = record([turnStart(0, 0, 1000), turnEnd(0, 1, 1001)])
    expect(at(trace.turns, 0).subgoals).toBeNull()
  })

  it('records retrieved skills and memories with the target each named, and keeps a failed retrieval', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 's1', 2, 1002, 'skill', '{"name":"release-notes","extra":1}'),
      toolResult(0, 0, 's1', 3, 1003, { text: 'loaded' }),
      toolCall(0, 0, 'm1', 4, 1004, 'memory_search', '{"query":"rollback policy"}'),
      toolResult(0, 0, 'm1', 5, 1005, { text: 'no match' }),
      toolCall(0, 0, 'm2', 6, 1006, 'memory_search', '{"query":"deploy gate"}'),
      toolResult(0, 0, 'm2', 7, 1007, { isError: true, text: 'index unavailable' }),
      toolCall(0, 0, 'r1', 8, 1008, 'grep', '{"pattern":"foo"}'),
      toolResult(0, 0, 'r1', 9, 1009, { text: 'foo' }),
      turnEnd(0, 10, 1010),
    ])
    expect(at(trace.turns, 0).retrievals).toEqual([
      { callId: 'cs1', tool: 'skill', target: 'release-notes', ok: true },
      { callId: 'cm1', tool: 'memory_search', target: 'rollback policy', ok: true },
      { callId: 'cm2', tool: 'memory_search', target: 'deploy gate', ok: false },
    ])
  })

  it('leaves a retrieval target null when the recorded arguments name none', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'skill', 'not json'),
      toolResult(0, 0, 'a', 3, 1003, { text: 'loaded' }),
      toolCall(0, 0, 'b', 4, 1004, 'skill', '["name"]'),
      toolResult(0, 0, 'b', 5, 1005, { text: 'loaded' }),
      toolCall(0, 0, 'c', 6, 1006, 'skill', '{"name":4,"query":""}'),
      toolResult(0, 0, 'c', 7, 1007, { text: 'loaded' }),
      toolCall(0, 0, 'd', 8, 1008, 'skill', 'null'),
      toolResult(0, 0, 'd', 9, 1009, { text: 'loaded' }),
      toolCall(0, 0, 'e', 10, 1010, 'skill', '"release-notes"'),
      toolResult(0, 0, 'e', 11, 1011, { text: 'loaded' }),
      turnEnd(0, 12, 1012),
    ])
    expect(at(trace.turns, 0).retrievals.map(retrieval => retrieval.target)).toEqual([null, null, null, null, null])
  })

  it('keeps the last assistant text of a turn as its final answer', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      assistantMessage(0, 0, 2, 1002),
      stepStart(0, 1, 3, 1003),
      assistantMessage(0, 1, 4, 1004),
      turnEnd(0, 5, 1005),
    ])
    expect(at(trace.turns, 0).finalAnswer).toBe('answer 1')
  })

  it('leaves the final answer null when no assistant message carried text', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      {
        type: 'assistant/message',
        seq: seq(2),
        time: 1002,
        data: {
          turn: 0,
          step: 0,
          message: {
            id: mid(2),
            role: 'assistant',
            content: [{ type: 'reasoning', text: 'thinking' }],
            source: { kind: 'model', provider: 'test', model: 'test-model' },
          },
          stream: [],
        },
        surfaceOp: 'append',
      },
      turnEnd(0, 3, 1003),
    ])
    expect(at(trace.turns, 0).finalAnswer).toBeNull()
  })

  it('records the session evaluations and human remarks in log order, stamped', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      feedbackRecord(1, 1001, {}),
      verificationResult(2, 1002, 'fail'),
      feedbackRecord(3, 1003, { text: 'the gate was right', category: 'task-result' }),
      verificationResult(4, 1004, 'pass'),
      turnEnd(0, 5, 1005),
    ])
    expect(trace.evaluations.map(result => result.status)).toEqual(['fail', 'pass'])
    expect(trace.feedback).toEqual([
      { at: '1970-01-01T00:00:01.001Z' },
      { text: 'the gate was right', category: 'task-result', at: '1970-01-01T00:00:01.003Z' },
    ])
  })

  it('snapshots the recorded result text of every call, clipped, and leaves it null when the log recorded none', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'read', '{}'),
      toolResult(0, 0, 'a', 3, 1003, { text: '  the file\ncontent  ' }),
      toolCall(0, 0, 'b', 4, 1004, 'read', '{}'),
      toolResult(0, 0, 'b', 5, 1005, {}),
      turnEnd(0, 6, 1006),
    ])
    expect(at(trace.turns, 0).steps[0]?.calls.map(call => call.snapshot)).toEqual(['the file content', null])

    const clipped = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'read', '{}'),
      toolResult(0, 0, 'a', 3, 1003, { text: 'y'.repeat(40) }),
      turnEnd(0, 4, 1004),
    ], 8)
    expect(at(clipped.turns, 0).steps[0]?.calls[0]?.snapshot).toBe('yyyyyyyy')
  })

  it('keeps a successful call message null while its snapshot carries the recorded text', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'bash'),
      toolResult(0, 0, 'a', 3, 1003, { text: 'ok' }),
      turnEnd(0, 4, 1004),
    ])
    expect(at(at(trace.turns, 0).steps, 0).calls[0]).toMatchObject({ ok: true, message: null, snapshot: 'ok' })
  })

  it('falls back to the tool name for a failed call whose result recorded no text and no error code', () => {
    const trace = record([
      turnStart(0, 0, 1000),
      stepStart(0, 0, 1, 1001),
      toolCall(0, 0, 'a', 2, 1002, 'bash'),
      toolResult(0, 0, 'a', 3, 1003, { isError: true }),
      turnEnd(0, 4, 1004),
    ])
    const call = at(at(at(trace.turns, 0).steps, 0).calls, 0)
    expect(call).toMatchObject({ message: 'bash', snapshot: null })
    expect(at(trace.turns, 0).failures[0]?.message).toBe('bash')
  })
})
