import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CaseReference } from '@deepseek-ai/dsh-learner-model'
import { boundText, completeStage, matchPattern, resolveConfig, waitingForOf } from '../src/index.ts'
import MisconceptionEngine from '../src/index.ts'
import type { MisconceptionId, MisconceptionPattern } from '../src/index.ts'
import { advanceToReassess, bootMisconception, EVIDENCE, MSS_PATTERN, THESIS } from './harness.ts'
import type { MisconceptionHarness } from './harness.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(patterns: readonly MisconceptionPattern[] = [MSS_PATTERN]): Promise<MisconceptionHarness> {
  const booted = await bootMisconception(patterns)
  contexts.push(booted.ctx)
  return booted
}

describe('misconception pipeline', () => {
  it('runs explain → counterexample → exercise → new case → reassess and closes the learner record', async () => {
    const booted = await harness()
    const { engine, agent, learnerId, ctx } = booted
    const detection = await engine.detect({ agent, learnerId, thesis: THESIS, evidence: [EVIDENCE] })
    const misconceptionId = detection.misconceptionId

    const explain = engine.directive(learnerId, misconceptionId)
    expect(explain?.stage).toBe('explain')
    expect(explain?.text).toContain('An MSS marks a shift in delivery')
    expect(engine.pipeline(learnerId, misconceptionId)?.waitingFor)
      .toBe('delivery of the explanation for MSS treated as a standalone entry criterion')

    const counterexample = await engine.advance({ misconceptionId, fact: { kind: 'delivered' } })
    expect(counterexample.stage).toBe('counterexample')
    expect(engine.directive(learnerId, misconceptionId)?.text).toContain('supply zone')

    const exercised = await engine.advance({ misconceptionId, fact: { kind: 'delivered' } })
    expect(exercised.stage).toBe('exercise')
    const exercise = engine.directive(learnerId, misconceptionId)?.exercise
    expect(exercise?.objective).toBe('Place MSS inside a full entry model before taking an entry')
    expect(exercise?.prompt).toContain('Mark the last three MSS')
    expect(ctx.learnerModel.objectives(learnerId).map(objective => objective.objectiveId))
      .toEqual([`${misconceptionId}:objective`])

    const attempted = await engine.advance({
      misconceptionId,
      fact: { kind: 'attempted', attempt: 'MSS into supply, then a demand-array test.' },
    })
    expect(attempted.stage).toBe('new-case')
    expect(attempted.attempt).toBe('MSS into supply, then a demand-array test.')
    expect(attempted.waitingFor).toBe('a case artifact for MSS treated as a standalone entry criterion')
    expect(() => engine.directive(learnerId, misconceptionId))
      .toThrow('the new-case stage needs the case the learner must work on')

    const caseId = CaseReference('case-eurusd')
    const selected = await engine.advance({ misconceptionId, fact: { kind: 'case-selected', caseId } })
    expect(selected.stage).toBe('reassess')
    expect(selected.caseId).toBe(caseId)
    expect(engine.directive(learnerId, misconceptionId)?.text).toContain('case-eurusd')

    const complete = await engine.advance({ misconceptionId, fact: { kind: 'reassessed', outcome: 'resolved' } })
    expect(complete.stage).toBe('complete')
    expect(complete.waitingFor).toBeUndefined()
    expect(ctx.learnerModel.misconceptions(learnerId)[0]?.status).toBe('resolved')
    expect(ctx.learnerModel.objectives(learnerId)).toEqual([])
    expect(engine.directive(learnerId, misconceptionId)).toBeUndefined()
  })

  it('restarts teaching when the learner repeats the misconception', async () => {
    const booted = await harness()
    const misconceptionId = await advanceToReassess(booted)

    const repeated = await booted.engine.advance({
      misconceptionId,
      fact: { kind: 'reassessed', outcome: 'repeated' },
    })

    expect(repeated.stage).toBe('explain')
    expect(repeated.waitingFor).toBe('delivery of the explanation for MSS treated as a standalone entry criterion')
    expect(booted.ctx.learnerModel.objectives(booted.learnerId).map(objective => objective.objectiveId))
      .toEqual([`${misconceptionId}:objective`])
    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)[0]?.status).toBe('addressed')
  })

  it('restarts the cycle when a completed misconception reappears', async () => {
    const booted = await harness()
    const misconceptionId = await advanceToReassess(booted)
    await booted.engine.advance({ misconceptionId, fact: { kind: 'reassessed', outcome: 'resolved' } })

    const again = await booted.engine.detect({
      agent: booted.agent,
      learnerId: booted.learnerId,
      thesis: THESIS,
      evidence: [EVIDENCE],
    })

    expect(again.stage).toBe('explain')
    expect(again.recurring).toBe(true)
    expect(booted.engine.pipeline(booted.learnerId, misconceptionId)?.stage).toBe('explain')
    expect(booted.engine.pipeline(booted.learnerId, misconceptionId)?.caseId).toBe('case-eurusd')
  })

  it('marks a resolved misconception as detected again when it reappears', async () => {
    const booted = await harness()
    const misconceptionId = await advanceToReassess(booted)
    await booted.engine.advance({ misconceptionId, fact: { kind: 'reassessed', outcome: 'resolved' } })

    await booted.engine.detect({
      agent: booted.agent,
      learnerId: booted.learnerId,
      thesis: THESIS,
      evidence: [EVIDENCE],
    })

    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)[0]?.status).toBe('detected')
    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)[0]?.recurrences).toBe(2)
  })

  it('moves the misconception to addressed when the explanation is delivered', async () => {
    const booted = await harness()
    const detection = await booted.engine.detect({
      agent: booted.agent,
      learnerId: booted.learnerId,
      thesis: THESIS,
      evidence: [EVIDENCE],
    })

    await booted.engine.advance({ misconceptionId: detection.misconceptionId, fact: { kind: 'delivered' } })

    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)[0]?.status).toBe('addressed')
  })

  it('refuses a fact the current stage does not accept', async () => {
    const booted = await harness()
    const detection = await booted.engine.detect({
      agent: booted.agent,
      learnerId: booted.learnerId,
      thesis: THESIS,
      evidence: [EVIDENCE],
    })

    await expect(booted.engine.advance({
      misconceptionId: detection.misconceptionId,
      fact: { kind: 'attempted', attempt: 'too early' },
    })).rejects.toThrow("the explain stage completes with 'delivered', not 'attempted'")
  })

  it('refuses to advance or render an occurrence no learner holds', async () => {
    const booted = await harness()
    await booted.engine.detect({
      agent: booted.agent,
      learnerId: booted.learnerId,
      thesis: THESIS,
      evidence: [EVIDENCE],
    })
    const unknown = brandString<MisconceptionId>('learner-1/other-pattern')

    await expect(booted.engine.advance({ misconceptionId: unknown, fact: { kind: 'delivered' } }))
      .rejects.toThrow('no pipeline for misconception')
    expect(() => booted.engine.directive(booted.learnerId, unknown))
      .toThrow('holds no pipeline for')
    expect(booted.engine.pipeline(booted.learnerId, unknown)).toBeUndefined()
  })

  it('fails loudly when a stored pipeline names a pattern the catalogue dropped', async () => {
    const booted = await harness()
    const detection = await booted.engine.detect({
      agent: booted.agent,
      learnerId: booted.learnerId,
      thesis: THESIS,
      evidence: [EVIDENCE],
    })
    await booted.fiber.dispose()
    await booted.ctx.plugin(MisconceptionEngine, { patterns: [{ ...MSS_PATTERN, id: 'other-pattern' }] })

    expect(() => booted.ctx.misconception.pipelines(booted.learnerId))
      .toThrow("stored pipeline refers to pattern 'mss-standalone-entry'")
    expect(booted.ctx.misconception.match(THESIS)?.id).toBe('other-pattern')
    expect(() => booted.ctx.misconception.directive(booted.learnerId, detection.misconceptionId))
      .toThrow("stored pipeline refers to pattern 'mss-standalone-entry'")
  })
})

describe('misconception catalogue', () => {
  it('rejects a catalogue the engine cannot detect anything with', () => {
    expect(() => resolveConfig({ patterns: [] })).toThrow('the pattern catalogue is empty')
    expect(() => resolveConfig({ patterns: [{ ...MSS_PATTERN, id: ' ' }] })).toThrow('declares a blank id')
    expect(() => resolveConfig({ patterns: [MSS_PATTERN, MSS_PATTERN] }))
      .toThrow("pattern id 'mss-standalone-entry' is declared twice")
    expect(() => resolveConfig({ patterns: [{ ...MSS_PATTERN, triggers: [] }] })).toThrow('declares no trigger')
    expect(() => resolveConfig({ patterns: [{ ...MSS_PATTERN, triggers: ['  '] }] })).toThrow('declares a blank trigger')
    expect(() => resolveConfig({ patterns: [{ ...MSS_PATTERN, misconception: '' }] })).toThrow('names no misconception')
    expect(() => resolveConfig({ patterns: [{ ...MSS_PATTERN, objective: '' }] })).toThrow('names no objective')
  })

  it('resolves the declared catalogue and the text cap', () => {
    expect(resolveConfig({ patterns: [MSS_PATTERN], maxTextChars: 12 }).maxTextChars).toBe(12)
    expect(resolveConfig({ patterns: [MSS_PATTERN] }).patterns).toHaveLength(1)
    expect(resolveConfig({ patterns: [MSS_PATTERN] }).maxTextChars).toBe(2_000)
  })

  it('matches the first pattern whose trigger the thesis carries, ignoring case', () => {
    expect(matchPattern([MSS_PATTERN], 'mss HAPPENED, so I am long.')?.id).toBe(MSS_PATTERN.id)
    expect(matchPattern([MSS_PATTERN], 'Nothing happened yet.')).toBeUndefined()
    expect(matchPattern([], THESIS)).toBeUndefined()
  })

  it('bounds text at the cap', () => {
    expect(boundText('abcdef', 6)).toBe('abcdef')
    expect(boundText('abcdef', 3)).toBe('abc')
  })
})

describe('pipeline state machine', () => {
  it('names the wait each stage holds', () => {
    expect(waitingForOf('explain', 'MSS', undefined)).toContain('delivery of the explanation')
    expect(waitingForOf('counterexample', 'MSS', undefined)).toContain('delivery of the counterexample')
    expect(waitingForOf('exercise', 'MSS', 'ex-1')).toContain('exercise ex-1')
    expect(waitingForOf('new-case', 'MSS', 'ex-1')).toContain('a case artifact for MSS')
    expect(waitingForOf('reassess', 'MSS', 'ex-1')).toContain('reassessment after exercise ex-1')
    expect(waitingForOf('complete', 'MSS', undefined)).toBeUndefined()
  })

  it('refuses any fact for a completed cycle', () => {
    expect(() => completeStage('complete', { kind: 'delivered' }))
      .toThrow('the complete stage accepts no further fact')
  })
})
