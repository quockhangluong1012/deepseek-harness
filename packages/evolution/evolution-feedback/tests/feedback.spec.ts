import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionFeedback, { resolveConfig } from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function harness(config: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(EvolutionFeedback, config)
  const session = ctx.sessions.create(SessionId('s1'), { meta: { cwd: dir } })
  return { ctx, fiber, feedback: ctx.evolutionFeedback, session, pool }
}

/** Append one turn holding a single tool call and its result. */
function appendCall(
  session: Session,
  turn: number,
  name: string,
  text: string,
  ok: boolean,
  code?: string,
  callId = `call-${turn}`,
): void {
  const id = ToolCallId(callId)
  session.append('turn/start', { turn })
  session.append('tool/call', { turn, step: 1, callId: id, name, arguments: '{}' })
  session.append(
    'tool/result',
    {
      turn,
      step: 1,
      message: createToolResultMessage({ callId: id, content: [{ type: 'text', text }], isError: !ok }),
      ...code === undefined ? {} : { error: { name: 'ToolError', code } },
    },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('evolution feedback', () => {
  it('resolves observation defaults', () => {
    expect(resolveConfig({})).toEqual({
      enabled: true,
      maxEntries: 100,
      maxMessageChars: 500,
      triggerReviewSessions: 2,
    })
    expect(resolveConfig({ enabled: false, maxEntries: 5, maxMessageChars: 20, triggerReviewSessions: 3 }))
      .toEqual({ enabled: false, maxEntries: 5, maxMessageChars: 20, triggerReviewSessions: 3 })
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const feedback = new EvolutionFeedback(ctx, {})
    expect(() => feedback.entries('s1')).toThrow('not started yet')
    expect(() => feedback.summary(['s1'], 5)).toThrow('not started yet')
    expect(() => feedback.signals(['s1'], 5)).toThrow('not started yet')
  })

  it('records a failing call and ignores a successful one', async () => {
    const h = await harness()
    try {
      appendCall(h.session, 1, 'bash', 'command not found', false)
      await vi.waitFor(() => {
        const entries = h.feedback.entries('s1')
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({ tool: 'bash', message: 'command not found', count: 1 })
        expect(Date.parse(entries[0]?.firstAt ?? '')).not.toBeNaN()
      })
      appendCall(h.session, 2, 'read', 'file contents', true)
      appendCall(h.session, 3, 'bash', 'permission denied', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1').map(entry => entry.message)).toEqual(['permission denied', 'command not found'])
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('counts a repeated failure instead of appending it twice', async () => {
    const h = await harness()
    try {
      appendCall(h.session, 1, 'bash', 'command not found', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1')).toHaveLength(1)
      })
      appendCall(h.session, 2, 'bash', 'command not found', false)
      await vi.waitFor(() => {
        const entries = h.feedback.entries('s1')
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({ tool: 'bash', count: 2 })
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('records a failure whose call was never observed', async () => {
    const h = await harness()
    try {
      const id = ToolCallId('unseen')
      h.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: 'orphan' }], isError: true }),
      }, { surfaceOp: 'append' })
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1')).toMatchObject([{ tool: null, message: 'orphan' }])
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('falls back to the failure code and clears its pending call at turn end', async () => {
    const h = await harness()
    try {
      const id = ToolCallId('late')
      h.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'bash', arguments: '{}' })
      h.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      h.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({ callId: id, content: [], isError: true }),
        error: { name: 'ToolError', code: 'TOOL_TIMEOUT' },
      }, { surfaceOp: 'append' })
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1')).toMatchObject([
          { tool: null, message: 'TOOL_TIMEOUT' },
        ])
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('records a failing result with no visible text and no failure code', async () => {
    const h = await harness()
    try {
      const id = ToolCallId('silent')
      h.session.append('tool/call', { turn: 1, step: 1, callId: id, name: 'screenshot', arguments: '{}' })
      h.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: id,
          content: [{ type: 'reasoning', text: 'not visible' }],
          isError: true,
        }),
      }, { surfaceOp: 'append' })
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1')).toMatchObject([{ tool: 'screenshot', message: '' }])
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('normalizes and clips a recorded message', async () => {
    const h = await harness({ maxMessageChars: 12 })
    try {
      appendCall(h.session, 1, 'bash', '  line one\n\n\tline two   ', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1')).toMatchObject([{ message: 'line one lin' }])
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps the newest observations within the entry cap', async () => {
    const h = await harness({ maxEntries: 2 })
    try {
      appendCall(h.session, 1, 'bash', 'first', false)
      appendCall(h.session, 2, 'bash', 'second', false)
      appendCall(h.session, 3, 'bash', 'third', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1').map(entry => entry.message)).toEqual(['third', 'second'])
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('aggregates failures across sessions by observation count', async () => {
    const h = await harness()
    try {
      const second = h.ctx.sessions.create(SessionId('s2'), { meta: { cwd: process.cwd() } })
      appendCall(h.session, 1, 'bash', 'denied', false)
      appendCall(h.session, 2, 'bash', 'denied', false)
      appendCall(second, 1, 'read', 'missing', false)
      await vi.waitFor(() => {
        expect(h.feedback.summary(['s1', 's2'], 5)).toMatchObject([
          { tool: 'bash', message: 'denied', count: 2, sessions: 1 },
          { tool: 'read', message: 'missing', count: 1, sessions: 1 },
        ])
      })
      expect(h.feedback.summary(['s1', 's2'], 1)).toHaveLength(1)
      expect(h.feedback.summary(['absent'], 5)).toEqual([])
      appendCall(second, 2, 'bash', 'denied', false)
      await vi.waitFor(() => {
        expect(h.feedback.summary(['s1', 's2'], 5)[0]).toMatchObject({ count: 3, sessions: 2 })
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('merges the earliest sighting and the newest repeat in either session order', async () => {
    const h = await harness()
    try {
      const second = h.ctx.sessions.create(SessionId('s2'), { meta: { cwd: process.cwd() } })
      appendCall(h.session, 1, 'bash', 'denied', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1')).toHaveLength(1)
      })
      await delay(5)
      appendCall(second, 1, 'bash', 'denied', false)
      const orphan = ToolCallId('orphan')
      second.append('tool/result', {
        turn: 2,
        step: 1,
        message: createToolResultMessage({ callId: orphan, content: [{ type: 'text', text: 'unattributed' }], isError: true }),
      }, { surfaceOp: 'append' })
      await vi.waitFor(() => {
        expect(h.feedback.entries('s2')).toHaveLength(2)
      })
      appendCall(second, 3, 'read', 'also unattributed', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s2')).toHaveLength(3)
      })
      const early = h.feedback.entries('s1')[0]
      const late = h.feedback.entries('s2').find(entry => entry.message === 'denied')
      const forward = h.feedback.summary(['s1', 's2'], 5)
      const reverse = h.feedback.summary(['s2', 's1'], 5)
      expect(forward[0]).toMatchObject({
        tool: 'bash',
        message: 'denied',
        count: 2,
        sessions: 2,
        firstAt: early?.firstAt,
        lastAt: late?.lastAt,
      })
      expect(reverse[0]).toEqual(forward[0])
      expect(forward[1]).toMatchObject({ tool: 'read', message: 'also unattributed', count: 1, sessions: 1 })
      expect(forward[2]).toMatchObject({ tool: null, message: 'unattributed', count: 1, sessions: 1 })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('warns when a failure cannot be recorded', async () => {
    const h = await harness()
    try {
      const warn = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => {})
      h.pool.failNextWrites = 1
      appendCall(h.session, 1, 'bash', 'denied', false)
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not record a failure'))
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('observes nothing while disabled', async () => {
    const h = await harness({ enabled: false })
    try {
      appendCall(h.session, 1, 'bash', 'denied', false)
      await delay(20)
      expect(h.feedback.entries('s1')).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('grades signals by attribution and session reach, decisive first', async () => {
    const h = await harness()
    try {
      const second = h.ctx.sessions.create(SessionId('s2'), { meta: { cwd: process.cwd() } })
      appendCall(h.session, 1, 'bash', 'denied', false)
      appendCall(h.session, 2, 'bash', 'denied', false)
      appendCall(second, 1, 'bash', 'denied', false)
      appendCall(second, 2, 'read', 'missing', false)
      const orphan = ToolCallId('orphan')
      second.append('tool/result', {
        turn: 3,
        step: 1,
        message: createToolResultMessage({
          callId: orphan,
          content: [{ type: 'text', text: 'unattributed' }],
          isError: true,
        }),
      }, { surfaceOp: 'append' })
      await vi.waitFor(() => {
        expect(h.feedback.entries('s2')).toHaveLength(3)
      })
      const signals = h.feedback.signals(['s1', 's2'], 5)
      expect(signals).toMatchObject([
        {
          tool: 'bash',
          message: 'denied',
          count: 3,
          sessions: 2,
          evidenceStatus: 'complete',
          actionability: 'trigger_review',
          mergeKey: 'bash\u0000denied',
        },
        {
          tool: 'read',
          message: 'missing',
          sessions: 1,
          evidenceStatus: 'complete',
          actionability: 'ranking_only',
        },
        {
          tool: null,
          message: 'unattributed',
          evidenceStatus: 'actionable_partial',
          actionability: 'observe_only',
          mergeKey: '\u0000unattributed',
        },
      ])
      expect(h.feedback.signals(['s1', 's2'], 1)).toHaveLength(1)
      expect(h.feedback.signals(['absent'], 5)).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('keeps a decisive signal when a merely counted one leads the summary', async () => {
    const h = await harness()
    try {
      const second = h.ctx.sessions.create(SessionId('s2'), { meta: { cwd: process.cwd() } })
      for (const turn of [1, 2, 3]) appendCall(h.session, turn, 'bash', 'denied', false)
      appendCall(h.session, 4, 'read', 'missing', false)
      appendCall(second, 1, 'read', 'missing', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1')).toHaveLength(2)
      })
      expect(h.feedback.summary(['s1', 's2'], 1)[0]).toMatchObject({ tool: 'bash', message: 'denied', count: 3 })
      expect(h.feedback.signals(['s1', 's2'], 1)[0]).toMatchObject({
        tool: 'read',
        message: 'missing',
        sessions: 2,
        actionability: 'trigger_review',
      })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('ranks a failure below the configured trigger threshold', async () => {
    const h = await harness({ triggerReviewSessions: 3 })
    try {
      const second = h.ctx.sessions.create(SessionId('s2'), { meta: { cwd: process.cwd() } })
      appendCall(h.session, 1, 'bash', 'denied', false)
      appendCall(second, 1, 'bash', 'denied', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s2')).toHaveLength(1)
      })
      expect(h.feedback.signals(['s1', 's2'], 5)[0]).toMatchObject({ sessions: 2, actionability: 'ranking_only' })
    } finally {
      await h.fiber.dispose()
    }
  })

  it('orders equally graded signals by reach, then count, then recency', async () => {
    const h = await harness()
    try {
      appendCall(h.session, 1, 'bash', 'alpha', false)
      await delay(5)
      appendCall(h.session, 2, 'bash', 'beta', false)
      await delay(5)
      appendCall(h.session, 3, 'bash', 'gamma', false)
      appendCall(h.session, 4, 'bash', 'alpha', false)
      await vi.waitFor(() => {
        expect(h.feedback.entries('s1')).toHaveLength(3)
      })
      expect(h.feedback.signals(['s1'], 5).map(signal => signal.message)).toEqual(['alpha', 'gamma', 'beta'])
    } finally {
      await h.fiber.dispose()
    }
  })
})
