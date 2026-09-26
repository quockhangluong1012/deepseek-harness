import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CaseReference } from '@deepseek-ai/dsh-learner-model'
import { bootMisconception, EVIDENCE, MSS_PATTERN, THESIS } from './harness.ts'
import type { MisconceptionHarness } from './harness.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(paths: readonly typeof MSS_PATTERN[] = [MSS_PATTERN]): Promise<MisconceptionHarness> {
  const booted = await bootMisconception(paths)
  contexts.push(booted.ctx)
  return booted
}

describe('misconception detection', () => {
  it('names the thesis, the misconception, and the design error behind it', async () => {
    const { engine, agent, kernel, learnerId, ctx } = await harness()

    const detection = await engine.detect({ agent, learnerId, thesis: THESIS, evidence: [EVIDENCE] })

    expect(detection.misconception).toBe('MSS treated as a standalone entry criterion')
    expect(detection.designError).toContain('not an entry trigger')
    expect(detection.thesis).toBe(THESIS)
    expect(detection.objective).toBe('Place MSS inside a full entry model before taking an entry')
    expect(detection.evidence).toEqual([EVIDENCE])
    expect(detection.occurrences).toBe(1)
    expect(detection.recurring).toBe(false)
    expect(detection.stage).toBe('explain')
    expect(detection.claimId).toBe('claim-1')

    expect(kernel.claims).toHaveLength(1)
    expect(kernel.claims[0]).toMatchObject({ status: 'contradicted', evidence: [EVIDENCE] })
    expect(kernel.claims[0]?.statement).toContain('MSS treated as a standalone entry criterion')

    const recorded = ctx.learnerModel.misconceptions(learnerId)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.misconceptionId).toBe(String(detection.misconceptionId))
    expect(recorded[0]?.recurrences).toBe(1)
    expect(recorded[0]?.status).toBe('detected')
    expect(ctx.learnerModel.objectives(learnerId).map(objective => objective.statement))
      .toEqual(['Place MSS inside a full entry model before taking an entry'])
    expect(ctx.learnerModel.objectives(learnerId)[0]?.concepts).toEqual(['mss-standalone-entry'])
    expect(engine.pipelines(learnerId).map(pipeline => pipeline.stage)).toEqual(['explain'])
  })

  it('counts the second occurrence as a recurrence of the same misconception', async () => {
    const { engine, agent, learnerId, ctx } = await harness()

    const first = await engine.detect({ agent, learnerId, thesis: THESIS, evidence: [EVIDENCE] })
    const second = await engine.detect({
      agent,
      learnerId,
      thesis: 'MSS happened on the H4 again, so the entry stands.',
      evidence: [EVIDENCE],
    })

    expect(second.misconceptionId).toBe(first.misconceptionId)
    expect(second.occurrences).toBe(2)
    expect(second.recurring).toBe(true)
    expect(ctx.learnerModel.misconceptions(learnerId)[0]?.recurrences).toBe(2)
    expect(engine.pipelines(learnerId)).toHaveLength(1)
    expect(ctx.learnerModel.objectives(learnerId)).toHaveLength(1)
  })

  it('detects a recurring misconception in a case the learner already worked', async () => {
    const { engine, agent, learnerId, ctx } = await harness()
    const caseId = CaseReference('case-eurusd')

    const first = await engine.detect({ agent, learnerId, thesis: THESIS, evidence: [EVIDENCE], caseId })
    const second = await engine.detect({ agent, learnerId, thesis: THESIS, evidence: [EVIDENCE] })

    expect(first.misconceptionId).toBe(second.misconceptionId)
    expect(ctx.learnerModel.misconceptions(learnerId)[0]?.caseIds).toEqual([caseId])
    expect(engine.pipeline(learnerId, second.misconceptionId)?.caseId).toBe(caseId)
  })

  it('records the finding without a kernel claim when no kernel is mounted', async () => {
    const booted = await bootMisconception([MSS_PATTERN], false)
    contexts.push(booted.ctx)

    const detection = await booted.engine.detect({
      agent: booted.agent,
      learnerId: booted.learnerId,
      thesis: THESIS,
      evidence: [EVIDENCE],
    })

    expect(detection.claimId).toBeUndefined()
    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)).toHaveLength(1)
  })

  it('refuses a detection with no contradicting evidence', async () => {
    const { engine, agent, learnerId } = await harness()

    await expect(engine.detect({ agent, learnerId, thesis: THESIS, evidence: [] }))
      .rejects.toThrow('a detection needs the observations that contradict the thesis')
  })

  it('refuses a thesis the catalogue does not recognize', async () => {
    const { engine, agent, learnerId } = await harness()

    await expect(engine.detect({
      agent,
      learnerId,
      thesis: 'I will wait for the London open before looking for anything.',
      evidence: [EVIDENCE],
    })).rejects.toThrow('no catalogued pattern matches the stated thesis')
  })
})
