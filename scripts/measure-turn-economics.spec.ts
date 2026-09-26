/**
 * The Track A0 baseline aggregation: per-session rows and corpus totals over
 * events the shipped readers produce. The fixture writes one session through
 * the real Session log, so every measured branch is exercised on the event
 * shapes the readers and the writers agree on.
 */
import { Context } from '@deepseek-ai/cordis'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import type {} from '@deepseek-ai/dsh-evolution-memory-context'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { buildSessionEventRecords } from '@deepseek-ai/dsh-session-query'
import { SessionTitleProviderId } from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-session-title-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatTurnEconomicsSummary,
  measureTurnEconomics,
  type RecordedSession,
  type TurnEconomicsReport,
} from './measure-turn-economics.ts'

/** Frozen wall clock so the appends' timestamps, and the report, are exact. */
const NOW = Date.parse('2026-09-26T00:00:00.000Z')
const CREATED_AT = NOW - 250

afterEach(() => {
  vi.useRealTimers()
})

/** One recorded session whose measured quantities are hand-checkable. */
async function fixtureSession(): Promise<RecordedSession> {
  vi.useFakeTimers({ now: NOW })
  const ctx = new Context()
  const fiber = ctx.plugin(SessionStore)
  await fiber
  try {
    const session = ctx.sessions.create(SessionId('fixture'))
    const titleRequest = {
      titleProvider: SessionTitleProviderId('fixture'),
      messageSeqs: [],
      route: { provider: 'fixture', model: 'fixture-model' },
      system: 'title',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'title me' }], source: { kind: 'user' } })],
      maxTokens: 32,
    }
    const brief = (digest: string) => createUserMessage({
      content: [{ type: 'text', text: `brief ${digest}` }],
      source: {
        kind: 'evolution-memory',
        form: 'snapshot',
        scopeId: EvolutionScopeId('fixture'),
        digest,
        sections: [],
        supersedes: true,
      },
    })
    const first = session.append('user/message', brief('v1'), { surfaceOp: 'append' })
    session.append('session/title-llm-request', titleRequest)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('session/title-llm-request', titleRequest)
    session.append('context/compiled', {
      digest: 'placement-1',
      compilerVersion: 'agent-context/1',
      maxTokens: null,
      tokenEstimate: 30,
      included: [
        { id: 'policy:sandbox', kind: 'policy', trust: 'trusted', retention: 'required', tokens: 10, relevance: 1 },
        { id: 'memory:brief', kind: 'memory', trust: 'untrusted', retention: 'compressible', tokens: 20, relevance: 0.5 },
      ],
      omitted: [],
      conflicts: [],
    })
    session.append('user/message', brief('v2'), {
      surfaceOp: { op: 'replace', startSeq: first.seq, endSeq: first.seq },
      sourceEventSeqs: [first.seq],
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'reading' }], source: { provider: 'fixture', model: 'fixture-model' } }),
      stream: [],
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 180 },
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c1'), name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId: ToolCallId('c1'), content: [{ type: 'text', text: 'file body' }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const events = session.snapshotEvents()
    return {
      key: 'fixture/session.v5.jsonl',
      createdAt: CREATED_AT,
      events,
      surfaces: buildSessionEventRecords(SessionId('fixture'), events).map(record => record.surface),
    }
  } finally {
    await fiber.dispose()
  }
}

describe('measureTurnEconomics', () => {
  it('reports an empty corpus as zeros rather than failing', () => {
    const measurement = measureTurnEconomics([])
    expect(measurement.sessions).toEqual([])
    expect(measurement.totals).toEqual({
      sessions: 0,
      events: 0,
      turns: 0,
      steps: 0,
      toolCalls: 0,
      modelCalls: { foreground: 0, background: 0, backgroundOutsideTurn: 0, total: 0 },
      perTurn: { min: 0, max: 0, mean: 0 },
      backgroundPerTurn: { max: 0, turnsAboveOne: 0 },
      tokens: {
        inputTokensBySource: { policy: 0, task: 0, plan: 0, memory: 0, evidence: 0, artifact: 0, history: 0, tool: 0 },
        compiledRecords: 0,
        billedInputTokens: 0,
        cacheReadTokens: 0,
        usageSamples: 0,
        cacheHitRatio: 0,
      },
      sessionsWithCompiledContext: 0,
      sessionsWithUsage: 0,
      snapshotMessages: 0,
      supersedeDeclarations: 0,
      supersedes: 0,
      maxSupersedesPerSession: 0,
      logOnlyEvents: 0,
      shadowedEvents: 0,
      logOnlyPerToolCall: 0,
      startup: {
        sessionsWithClock: 0,
        medianMs: null,
        maxMs: null,
        preTurnEvents: { min: 0, max: 0, mean: 0 },
      },
    })
  })

  it('measures calls, sources, cache, supersedes, log volume, and startup of one session', async () => {
    const session = await fixtureSession()
    const measurement = measureTurnEconomics([session, { key: 'aaa/session.v5.jsonl', createdAt: 0, events: [], surfaces: [] }])

    // Rows sort by key, so the empty session leads and contributes only a row.
    expect(measurement.sessions.map(row => row.key)).toEqual(['aaa/session.v5.jsonl', 'fixture/session.v5.jsonl'])
    expect(measurement.sessions[0]).toMatchObject({
      key: 'aaa/session.v5.jsonl',
      turns: 0,
      events: 0,
      startupMs: null,
    })
    expect(measurement.sessions[1]).toMatchObject({
      key: 'fixture/session.v5.jsonl',
      createdAt: CREATED_AT,
      events: 12,
      turns: 1,
      steps: 1,
      toolCalls: 1,
      modelCalls: { foreground: 1, background: 2, backgroundOutsideTurn: 1, total: 3 },
      perTurn: [{ turn: 1, modelCalls: 2, backgroundCalls: 1 }],
      snapshotMessages: 2,
      supersedeDeclarations: 2,
      supersedes: 1,
      logOnlyEvents: 8,
      shadowedEvents: 1,
      logOnlyPerToolCall: 8,
      startupMs: 250,
      preTurnEvents: 2,
    })
    expect(measurement.sessions[1]?.tokens).toEqual({
      inputTokensBySource: { policy: 10, task: 0, plan: 0, memory: 20, evidence: 0, artifact: 0, history: 0, tool: 0 },
      compiledRecords: 1,
      billedInputTokens: 130,
      cacheReadTokens: 20,
      usageSamples: 1,
      cacheHitRatio: 0.1538,
    })
    expect(measurement.totals).toMatchObject({
      sessions: 2,
      events: 12,
      turns: 1,
      steps: 1,
      toolCalls: 1,
      modelCalls: { foreground: 1, background: 2, backgroundOutsideTurn: 1, total: 3 },
      perTurn: { min: 2, max: 2, mean: 2 },
      backgroundPerTurn: { max: 1, turnsAboveOne: 0 },
      sessionsWithCompiledContext: 1,
      sessionsWithUsage: 1,
      snapshotMessages: 2,
      supersedeDeclarations: 2,
      supersedes: 1,
      maxSupersedesPerSession: 1,
      logOnlyEvents: 8,
      shadowedEvents: 1,
      logOnlyPerToolCall: 8,
      startup: { sessionsWithClock: 1, medianMs: 250, maxMs: 250, preTurnEvents: { min: 0, max: 2, mean: 1 } },
    })
  })

  it('describes a report without hiding refusals or the clock gap', () => {
    const report: TurnEconomicsReport = {
      schemaVersion: 1,
      sessionsRoot: 'snapshots',
      ...measureTurnEconomics([]),
      unreadable: [{ key: 'web/legacy/session.v3.jsonl', message: 'refused' }],
    }
    const summary = formatTurnEconomicsSummary(report)
    expect(summary).toContain('snapshots: 0 sessions, 0 turns, 0 steps, 0 tool calls, 0 events')
    expect(summary).toContain('supersedes: 0 replacements (0 declarations) over 0 snapshot messages')
    expect(summary).toContain('startup latency unmeasurable (0 of 0 sessions carry a clock)')
    expect(summary).toContain('unreadable fixtures: 1\n  web/legacy/session.v3.jsonl: refused')
  })
})
