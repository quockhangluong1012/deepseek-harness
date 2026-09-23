import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import EvolutionTrace, { resolveConfig } from '../src/index.ts'
import type { ReplayArtifact } from '../src/index.ts'

const seq = (n: number): SessionSeq => SessionSeq(n)
const mid = (n: number): MessageId => brandString<MessageId>(`m${n}`)

function failingTurn(session: string, at: number, message: string): SessionEvent[] {
  const call = ToolCallId(`c${session}-${at}`)
  return [
    { type: 'turn/start', seq: seq(at * 10), time: at, data: { turn: 0 } },
    {
      type: 'user/message',
      seq: seq(at * 10 + 1),
      time: at + 1,
      data: { id: mid(at * 10 + 1), role: 'user', content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    { type: 'step/start', seq: seq(at * 10 + 2), time: at + 2, data: { turn: 0, step: 0 } },
    { type: 'tool/call', seq: seq(at * 10 + 3), time: at + 3, data: { turn: 0, step: 0, callId: call, name: 'bash', arguments: '{}' } },
    {
      type: 'tool/result',
      seq: seq(at * 10 + 4),
      time: at + 4,
      data: {
        turn: 0,
        step: 0,
        message: {
          id: mid(at * 10 + 4),
          role: 'tool',
          content: [{ type: 'text', text: message }],
          toolCallId: call,
          isError: true,
          source: { kind: 'tool', callId: call },
        },
        error: { name: 'HarnessError', code: 'UNKNOWN', reason: message },
      },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: seq(at * 10 + 5), time: at + 5, data: { turn: 0, reason: { kind: 'error', error: { message, code: 'UNKNOWN' } } } },
  ]
}

interface Harness {
  readonly trace: (sessionId: string) => ReturnType<EvolutionTrace['trace']>
  readonly summary: (sessionIds: readonly string[], limit: number) => ReturnType<EvolutionTrace['summary']>
  readonly replay: (
    sessionId: string,
    baseline: ReplayArtifact,
    candidate: ReplayArtifact,
  ) => ReturnType<EvolutionTrace['replay']>
}

async function boot(options: {
  logs?: Map<string, readonly SessionEvent[]>
  sessions?: { get(SessionId: SessionId): object | undefined; flush(session: object): Promise<boolean> } | null
  persistence?: 'broken'
} = {}): Promise<Harness> {
  const ctx = new Context()
  const logs = options.logs ?? new Map<string, readonly SessionEvent[]>()
  if (options.persistence === 'broken') {
    ctx.provide('sessionPersistence', {
      open: async (id: SessionId) => {
        void id
        throw new Error('corrupt log')
      },
    } as never)
  } else {
    ctx.provide('sessionPersistence', {
      open: async (id: SessionId) => {
        const stored = logs.get(String(id))
        if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
        return {
          read: async () => ({ eventState: 'detached', events: stored }),
          close: async () => {},
        }
      },
    } as never)
  }
  if (options.sessions !== null) {
    const store = options.sessions ?? { get: () => undefined, flush: async () => true }
    ctx.provide('sessions', store as never)
  }
  await ctx.plugin(EvolutionTrace)
  const service = ctx.evolutionTrace
  return {
    trace: (sessionId: string) => service.trace(sessionId),
    summary: (sessionIds: readonly string[], limit: number) => service.summary(sessionIds, limit),
    replay: (sessionId: string, baseline: ReplayArtifact, candidate: ReplayArtifact) =>
      service.replay(sessionId, baseline, candidate),
  }
}

describe('evolution trace service', () => {
  it('resolves clip defaults', () => {
    expect(resolveConfig({})).toEqual({ maxChars: 500 })
    expect(resolveConfig({ maxChars: 120 })).toEqual({ maxChars: 120 })
  })

  it('projects a stored log into its structured trace', async () => {
    const h = await boot({ logs: new Map([['s1', failingTurn('s1', 1000, 'boom')]]) })
    const trace = await h.trace('s1')
    expect(trace?.sessionId).toBe('s1')
    expect(trace?.turns[0]?.failures[0]?.message).toBe('boom')
  })

  it('returns undefined when storage holds no session and no live store is mounted', async () => {
    const h = await boot({ logs: new Map(), sessions: null })
    expect(await h.trace('absent')).toBeUndefined()
  })

  it('rethrows persistence failures that are not absence', async () => {
    const h = await boot({ persistence: 'broken' })
    await expect(h.trace('s1')).rejects.toThrow('corrupt log')
  })

  it('flushes a live session before projecting', async () => {
    const flushed: string[] = []
    const live = {
      get: (id: SessionId) => (String(id) === 's1' ? { id } : undefined),
      flush: async (session: object) => {
        flushed.push(String((session as { id: SessionId }).id))
        return true
      },
    }
    const h = await boot({
      logs: new Map([['s1', failingTurn('s1', 1000, 'boom')]]),
      sessions: live,
    })
    await h.trace('s1')
    expect(flushed).toEqual(['s1'])
  })

  it('summarizes decisive sessions first, skips absent and empty logs, and applies the limit', async () => {
    const h = await boot({
      logs: new Map([
        ['two', failingTurn('two', 2000, 'boom two')],
        ['one', failingTurn('one', 1000, 'boom one')],
        ['empty', []],
      ]),
    })
    const rows = await h.summary(['absent', 'two', 'empty', 'one'], 10)
    expect(rows.map(row => row.sessionId)).toEqual(['two', 'one'])
    const limited = await h.summary(['two', 'one'], 1)
    expect(limited.map(row => row.sessionId)).toEqual(['two'])
  })

  it('breaks summary ties by recency then session id', async () => {
    const h = await boot({
      logs: new Map([
        ['older', failingTurn('older', 1000, 'boom')],
        ['newer', failingTurn('newer', 2000, 'boom')],
      ]),
    })
    const rows = await h.summary(['newer', 'older'], 10)
    expect(rows.map(row => row.sessionId)).toEqual(['newer', 'older'])
    const equal = await boot({
      logs: new Map([
        ['b', failingTurn('b', 1000, 'boom')],
        ['a', failingTurn('a', 1000, 'boom')],
      ]),
    })
    const tied = await equal.summary(['b', 'a'], 10)
    expect(tied.map(row => row.sessionId)).toEqual(['a', 'b'])
  })

  it('replays a stored trace against two artifact revisions without re-invoking anything', async () => {
    const h = await boot({ logs: new Map([['s1', failingTurn('s1', 1000, 'boom')]]) })
    const baseline: ReplayArtifact = { id: 'release-notes', version: 'r1', body: 'body r1' }
    const candidate: ReplayArtifact = { id: 'release-notes', version: 'r2', body: 'body r2' }
    const report = await h.replay('s1', baseline, candidate)
    expect(report).toMatchObject({ sessionId: 's1', artifact: 'release-notes', baseline: 'r1', candidate: 'r2' })
    expect(report?.steps.map(step => [step.turn, step.step])).toEqual([[0, 0]])
    // The recorded bash failure is the substrate; neither revision reaches it,
    // so the step replays unchanged from its snapshot.
    expect(report?.snapshotSteps).toEqual(['0.0'])
    expect(report?.changedSteps).toEqual([])
  })

  it('reports no replay for a session storage holds nothing for', async () => {
    const h = await boot({ logs: new Map(), sessions: null })
    const artifact: ReplayArtifact = { id: 'a', version: 'r1', body: 'b' }
    expect(await h.replay('absent', artifact, artifact)).toBeUndefined()
  })
})
