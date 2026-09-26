import { describe, expect, it } from 'vitest'
import type { TraceRecord } from '../src/index.ts'
import { summarize } from '../src/index.ts'

function record(overrides: Partial<TraceRecord> = {}): TraceRecord {
  return {
    sessionId: 's1',
    updatedAt: '2026-06-01T00:00:00.000Z',
    turnCount: 0,
    turns: [],
    usage: null,
    evaluations: [],
    feedback: [],
    ...overrides,
  }
}

const STEP = {
  turn: 0,
  step: 0,
  startedAt: '2026-06-01T00:00:00.000Z',
  finishedAt: '2026-06-01T00:00:01.000Z',
  interrupted: false,
  retries: 0,
  usage: null,
  estimatedCostUsd: null,
  context: null,
  calls: [],
  failures: 0,
  stateDelta: [],
  subagentUsage: { count: 0, runIds: [] },
}

describe('evolution trace summary', () => {
  it('contributes no row for an empty trace', () => {
    expect(summarize(record())).toBeUndefined()
  })

  it('compresses counts, tokens, latency, and distinct failure gists', () => {
    const timer = '2026-06-01T00:00:00.000Z'
    const trace = record({
      turnCount: 2,
      updatedAt: '2026-06-01T00:00:05.000Z',
      usage: { inputTokens: 7, outputTokens: 8 },
      turns: [
        {
          turn: 0,
          startedAt: timer,
          endedAt: '2026-06-01T00:00:01.000Z',
          endReason: 'completed',
          latencyMs: 1000,
          request: 'one',
          subgoals: null,
          retrievals: [],
          finalAnswer: null,
          steps: [
            {
              ...STEP,
              retries: 1,
              usage: { inputTokens: 1, outputTokens: 2 },
              calls: [
                { callId: 'c1', name: 'bash', ok: true, errorName: null, errorCode: null, message: null, snapshot: null, at: timer },
                { callId: 'c2', name: 'bash', ok: false, errorName: 'bash', errorCode: 'EXIT_1', message: 'boom one', snapshot: null, at: timer },
              ],
              failures: 1,
            },
            {
              ...STEP,
              step: 1,
              usage: { inputTokens: 6, outputTokens: 6 },
              calls: [
                { callId: 'c3', name: 'bash', ok: false, errorName: 'bash', errorCode: 'EXIT_1', message: 'boom one', snapshot: null, at: timer },
              ],
              failures: 1,
            },
          ],
          failures: [
            {
              callId: 'c2',
              tool: 'bash',
              message: 'boom one',
              at: timer,
              causes: [{ kind: 'tool', turn: 0, step: 0, tool: 'bash', reason: 'the call itself failed' }],
            },
          ],
        },
        {
          turn: 1,
          startedAt: timer,
          endedAt: '2026-06-01T00:00:02.000Z',
          endReason: 'error',
          latencyMs: 2000,
          request: null,
          subgoals: null,
          retrievals: [],
          finalAnswer: null,
          steps: [
            {
              ...STEP,
              turn: 1,
              calls: [
                { callId: 'c4', name: 'bash', ok: false, errorName: 'bash', errorCode: 'EXIT_2', message: 'boom two', snapshot: null, at: timer },
              ],
              failures: 1,
            },
          ],
          failures: [
            {
              callId: 'c4',
              tool: 'bash',
              message: 'boom two',
              at: timer,
              causes: [{ kind: 'tool', turn: 1, step: 0, tool: 'bash', reason: 'the call itself failed' }],
            },
          ],
        },
      ],
    })
    expect(summarize(trace)).toEqual({
      sessionId: 's1',
      turns: 2,
      calls: 4,
      failures: 3,
      retries: 1,
      tokens: 15,
      latencyMs: 3000,
      failureGists: ['boom one', 'boom two'],
      updatedAt: '2026-06-01T00:00:05.000Z',
    })
  })

  it('deduplicates repeated failure gists and ignores usage-less steps in the token sum', () => {
    const trace = record({
      turnCount: 1,
      turns: [{
        turn: 0,
        startedAt: 't0',
        endedAt: null,
        endReason: null,
        latencyMs: null,
        request: null,
        subgoals: null,
        retrievals: [],
        finalAnswer: null,
        steps: [
          { ...STEP, retries: 2, calls: [
            { callId: 'c1', name: 'bash', ok: false, errorName: null, errorCode: null, message: 'again', snapshot: null, at: 't0' },
            { callId: 'c2', name: 'bash', ok: false, errorName: null, errorCode: null, message: 'again', snapshot: null, at: 't0' },
          ], failures: 2 },
        ],
        failures: [
          { callId: 'c1', tool: 'bash', message: 'again', at: 't0', causes: [] },
          { callId: 'c2', tool: 'bash', message: 'again', at: 't0', causes: [] },
        ],
      }],
    })
    expect(summarize(trace)).toMatchObject({ retries: 2, tokens: 0, failureGists: ['again'] })
  })
})
