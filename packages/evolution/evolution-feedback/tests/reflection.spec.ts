import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionFeedback from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'feedback-reflection-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(EvolutionFeedback, {})
  const first = ctx.sessions.create(SessionId('s1'), { meta: { cwd: dir } })
  const second = ctx.sessions.create(SessionId('s2'), { meta: { cwd: dir } })
  return { ctx, fiber, feedback: ctx.evolutionFeedback, first, second }
}

/** Append one turn holding a single failing tool call and its result. */
function appendFailure(session: Session, turn: number, name: string, text: string, callId = `call-${turn}`): void {
  const id = ToolCallId(callId)
  session.append('turn/start', { turn })
  session.append('tool/call', { turn, step: 1, callId: id, name, arguments: '{}' })
  session.append(
    'tool/result',
    {
      turn,
      step: 1,
      message: createToolResultMessage({ callId: id, content: [{ type: 'text', text }], isError: true }),
    },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append a failing result whose call was never observed, so no tool is attributed. */
function appendUnattributed(session: Session, turn: number, text: string): void {
  const id = ToolCallId(`ghost-${turn}`)
  session.append('turn/start', { turn })
  session.append(
    'tool/result',
    {
      turn,
      step: 1,
      message: createToolResultMessage({ callId: id, content: [{ type: 'text', text }], isError: true }),
    },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('structured reflection', () => {
  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const feedback = new EvolutionFeedback(ctx, {})
    expect(() => feedback.reflect(['s1'], 5)).toThrow('not started yet')
    expect(() => feedback.reflection('key')).toThrow('not started yet')
  })

  it('derives the ledger half and grades confidence by evidence and sessions', async () => {
    const h = await harness()
    try {
      appendFailure(h.first, 1, 'bash', 'command not found')
      appendFailure(h.second, 1, 'bash', 'command not found')
      appendFailure(h.first, 2, 'read', 'missing file')
      appendUnattributed(h.first, 3, 'mystery blowup')
      let reflections: ReturnType<typeof h.feedback.reflect> = []
      await vi.waitFor(() => {
        // An absent session and a repeated id change nothing: one session is
        // one observed context, and unknown sessions report nothing.
        reflections = h.feedback.reflect(['s1', 's2', 'ghost', 's1'], 5)
        expect(reflections).toHaveLength(3)
      })
      expect(reflections[0]).toMatchObject({
        symptom: 'command not found',
        violatedExpectation: 'the bash call succeeds',
        contributingFactors: ['s1', 's2'],
        whatWorked: null,
        rootCause: null,
        correctedStrategy: null,
        confidence: 1,
        whatFailed: { count: 2, sessions: 2 },
      })
      expect(reflections[0]?.failureId).toBe(`bash\0command not found`)
      expect(reflections[1]).toMatchObject({
        symptom: 'missing file',
        violatedExpectation: 'the read call succeeds',
        contributingFactors: ['s1'],
        confidence: 0.75,
      })
      expect(reflections[2]).toMatchObject({
        symptom: 'mystery blowup',
        violatedExpectation: 'a tool result arrives without an error',
        confidence: 0.25,
      })
      expect(Date.parse(reflections[0]?.whatFailed.firstAt ?? '')).not.toBeNaN()
    } finally {
      await h.fiber.dispose()
    }
  })

  it('merges recorded analysis over the derived half without blanking earlier fields', async () => {
    const h = await harness()
    try {
      appendFailure(h.first, 1, 'bash', 'command not found')
      await vi.waitFor(() => {
        expect(h.feedback.reflect(['s1'], 5)).toHaveLength(1)
      })
      const key = h.feedback.reflect(['s1'], 5)[0]!.failureId
      expect(h.feedback.reflection(key)).toBeUndefined()
      const first = await h.feedback.recordReflection(key, {
        rootCause: 'the skill suggests a flag this shell lacks',
        correctedStrategy: 'probe the flag before using it',
        reusableWhen: 'whenever the skill names a shell flag',
      })
      expect(first).toMatchObject({
        rootCause: 'the skill suggests a flag this shell lacks',
        reusableWhen: 'whenever the skill names a shell flag',
        antiPattern: null,
        candidateTest: null,
      })
      expect(Date.parse(first.updatedAt)).not.toBeNaN()
      const second = await h.feedback.recordReflection(key, {
        antiPattern: 'flag-first scripting',
        candidateTest: 'run the probe command first',
      })
      expect(second).toMatchObject({
        rootCause: 'the skill suggests a flag this shell lacks',
        antiPattern: 'flag-first scripting',
        candidateTest: 'run the probe command first',
      })
      const third = await h.feedback.recordReflection(key, {})
      expect(third).toMatchObject({
        rootCause: 'the skill suggests a flag this shell lacks',
        correctedStrategy: 'probe the flag before using it',
        reusableWhen: 'whenever the skill names a shell flag',
        antiPattern: 'flag-first scripting',
        candidateTest: 'run the probe command first',
      })
      expect(Date.parse(third.updatedAt)).not.toBeNaN()
      // A first reading that states only one field leaves the rest null.
      const partial = await h.feedback.recordReflection('other\0key', { candidateTest: 'probe first' })
      expect(partial).toMatchObject({
        rootCause: null,
        correctedStrategy: null,
        reusableWhen: null,
        antiPattern: null,
        candidateTest: 'probe first',
      })
      expect(h.feedback.reflection(key)).toMatchObject({
        rootCause: 'the skill suggests a flag this shell lacks',
        candidateTest: 'run the probe command first',
      })
      expect(h.feedback.reflect(['s1'], 5)[0]).toMatchObject({
        rootCause: 'the skill suggests a flag this shell lacks',
        correctedStrategy: 'probe the flag before using it',
        reusableWhen: 'whenever the skill names a shell flag',
        antiPattern: 'flag-first scripting',
        candidateTest: 'run the probe command first',
      })
    } finally {
      await h.fiber.dispose()
    }
  })
})
