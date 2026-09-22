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
  it('reads throw before the store starts', async () => {
    const ctx = new Context()
    const feedback = new EvolutionFeedback(ctx, {})
    expect(() => feedback.reflect(['s1'], 5)).toThrow('not started yet')
    expect(() => feedback.reflection('key')).toThrow('not started yet')
    await expect(feedback.reflectSignals(5, '2026-09-22T00:00:00.000Z')).rejects.toThrow('not started yet')
    await expect(feedback.reflections(['s1'], 5)).rejects.toThrow('not started yet')
  })

  it('derives the ledger half and grades confidence by evidence, sessions, and recurrence', async () => {
    const h = await harness()
    try {
      appendFailure(h.first, 1, 'bash', 'command not found')
      appendFailure(h.second, 1, 'bash', 'command not found')
      appendFailure(h.first, 2, 'read', 'missing file')
      // The same failure twice in one session is recurrence without a second
      // independent context, so it raises confidence less than a session does.
      appendFailure(h.first, 4, 'read', 'missing file', 'call-4')
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
        confidence: 0.875,
        whatFailed: { count: 2, sessions: 2 },
      })
      expect(reflections[0]?.failureId).toBe('bash\0command not found')
      expect(reflections[1]).toMatchObject({
        symptom: 'missing file',
        violatedExpectation: 'the read call succeeds',
        contributingFactors: ['s1'],
        confidence: 0.625,
        whatFailed: { count: 2, sessions: 1 },
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

describe('failure memory authoring and retrieval', () => {
  it('authors one reflection per decisive signal, once, and reads it back', async () => {
    const h = await harness()
    try {
      appendFailure(h.first, 1, 'bash', 'command not found')
      appendFailure(h.second, 1, 'bash', 'command not found')
      // One session alone ranks without deciding, so this failure is authored
      // for nobody.
      appendFailure(h.first, 2, 'read', 'missing file')
      const written = await h.feedback.reflectSignals(10, '2026-09-22T00:00:00.000Z')
      expect(written).toHaveLength(1)
      expect(written[0]).toMatchObject({
        failureId: 'bash\0command not found',
        symptom: 'command not found',
        violatedExpectation: 'the bash call succeeds',
        // No template can name a cause or see what already worked, so those
        // fields stay null rather than being guessed.
        rootCause: null,
        whatWorked: null,
        contributingFactors: ['s1', 's2'],
        whatFailed: { count: 2, sessions: 2 },
        confidence: 0.875,
        correctedStrategy: 'change the call before repeating it: \'command not found\' recurred unchanged (2 observations in 2 sessions)',
        reusableWhen: 'when a call whose result was \'command not found\' is about to be repeated',
        antiPattern: 'do not repeat a call whose result was \'command not found\' without changing it (2 observations in 2 sessions)',
        candidateTest: 'replaying a run whose tool result is \'command not found\' no longer repeats that call unchanged',
      })
      // The second pass has no new decisive evidence to author.
      expect(await h.feedback.reflectSignals(10, '2026-09-22T01:00:00.000Z')).toEqual([])
      // The stored half is what every read path now reports, so the failure
      // carries its corrective heuristic wherever it is retrieved.
      expect(h.feedback.reflection('bash\0command not found')).toMatchObject({
        antiPattern: 'do not repeat a call whose result was \'command not found\' without changing it (2 observations in 2 sessions)',
      })
      expect(h.feedback.reflect(['s1', 's2'], 5)[0]?.antiPattern).toContain('without changing it')
      // An analyst reading still merges over the authored half, and states the
      // cause the author left null.
      const merged = await h.feedback.recordReflection('bash\0command not found', { rootCause: 'the shell lacks the tool' })
      expect(merged.rootCause).toBe('the shell lacks the tool')
      expect(merged.antiPattern).toContain('without changing it')
    } finally {
      await h.fiber.dispose()
    }
  })

  it('bounds one pass by the limit and retrieves stored reflections newest first', async () => {
    const h = await harness()
    try {
      appendFailure(h.first, 1, 'bash', 'command not found')
      appendFailure(h.first, 2, 'bash', 'command not found', 'call-2b')
      appendFailure(h.second, 1, 'bash', 'command not found')
      appendFailure(h.first, 3, 'read', 'missing file')
      appendFailure(h.first, 5, 'read', 'missing file')
      appendFailure(h.second, 2, 'read', 'missing file')
      appendFailure(h.second, 4, 'read', 'missing file')
      appendFailure(h.first, 4, 'write', 'disk full')
      appendFailure(h.second, 3, 'write', 'disk full')
      // Most observations first: four across two sessions, then three, then two.
      const limited = await h.feedback.reflectSignals(2, '2026-09-22T00:00:00.000Z')
      expect(limited.map(reflection => reflection.symptom)).toEqual(['missing file', 'command not found'])
      // The limit decides how much one pass authors, never what evidence exists:
      // the next pass picks up the rest.
      const rest = await h.feedback.reflectSignals(2, '2026-09-22T01:00:00.000Z')
      expect(rest.map(reflection => reflection.symptom)).toEqual(['disk full'])
      expect(await h.feedback.reflectSignals(2, '2026-09-22T02:00:00.000Z')).toEqual([])
      const newest = await h.feedback.reflections(['s1', 's2'], 10)
      expect(newest.map(reflection => reflection.symptom)).toEqual(['disk full', 'command not found', 'missing file'])
      // Confidence rises with recurrence at equal support: two observations in
      // each session is fully evidenced, one in each is not.
      expect(newest.map(reflection => reflection.confidence)).toEqual([0.875, 0.9375, 1])
      expect((await h.feedback.reflections(['s1', 's2'], 2)).map(reflection => reflection.symptom))
        .toEqual(['disk full', 'command not found'])
      // A session that never reported the failure is not its origin.
      expect(await h.feedback.reflections(['ghost'], 10)).toEqual([])
    } finally {
      await h.fiber.dispose()
    }
  })
})
