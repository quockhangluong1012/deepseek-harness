import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { CaseReference } from '@deepseek-ai/dsh-learner-model'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { MentorLoopReport } from '../src/index.ts'
import {
  bootMentorLoop, COUNTER_EVIDENCE, MSS_PATTERN, preStep, REPEATED_THESIS, RESOLVED_THESIS, say, textOf, THESIS,
} from './harness.ts'
import type { MentorLoopHarness } from './harness.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(withKernel = true): Promise<MentorLoopHarness> {
  const booted = await bootMentorLoop('learner-1', withKernel)
  contexts.push(booted.ctx)
  return booted
}

/** Commit one delivered directive to the log, as the agent loop does for the injected message. */
function commit(harness: MentorLoopHarness, message: UserMessage): void {
  say(harness.agent, textOf(message), message.source)
}

/** Take the directive the loop owes and commit it, returning its text. */
function deliver(harness: MentorLoopHarness): string {
  const message = harness.loop.directiveMessage(harness.agent)
  if (message === undefined) throw new Error('the loop owed no directive')
  commit(harness, message)
  return textOf(message)
}

/** The standard opening: the learner states the thesis, and the mentor records a claim plus the observation behind it. */
function stateThesis(harness: MentorLoopHarness, thesis = THESIS): void {
  say(harness.agent, thesis)
  harness.kernel.recorded = [COUNTER_EVIDENCE]
  harness.kernel.claims = [{ statement: `The learner's thesis: ${thesis}`, evidence: [], confidence: 0.5 }]
}

describe('mentor loop', () => {
  it('waits for the learner before taking any action', async () => {
    const booted = await harness()

    expect(booted.loop.position(booted.agent)).toMatchObject({
      stage: 'observe',
      action: 'none',
      waitingFor: 'a learner message in this session',
    })
    expect(await booted.loop.step(booted.agent)).toMatchObject({ stage: 'observe', action: 'none' })
    expect(booted.loop.directiveMessage(booted.agent)).toBeUndefined()
  })

  it('waits for a catalogued pattern when the catalogue does not recognize the thesis', async () => {
    const booted = await harness()
    say(booted.agent, 'I will wait for the London open before looking for anything.')

    expect(booted.loop.position(booted.agent)).toMatchObject({
      stage: 'evaluate',
      action: 'none',
      waitingFor: 'a catalogued misconception pattern matching the stated thesis',
      thesis: 'I will wait for the London open before looking for anything.',
    })
  })

  it('waits for the mentor\'s recorded claim and observations before naming a misconception', async () => {
    const booted = await harness()
    say(booted.agent, THESIS)
    booted.kernel.recorded = [COUNTER_EVIDENCE]

    expect(booted.loop.position(booted.agent)).toMatchObject({
      stage: 'devil-advocate',
      action: 'none',
      waitingFor: 'the mentor\'s recorded claim and observations about the analysis',
    })

    booted.kernel.claims = [{ statement: THESIS, evidence: [], confidence: 0.5 }]
    expect(booted.loop.position(booted.agent)).toMatchObject({
      stage: 'misconception-detection',
      action: 'detect',
    })
  })

  it('waits for the kernel when no task record exists', async () => {
    const booted = await harness(false)
    say(booted.agent, THESIS)

    expect(booted.loop.position(booted.agent)).toMatchObject({
      stage: 'devil-advocate',
      action: 'none',
      waitingFor: 'the mentor\'s recorded claim and observations about the analysis',
    })
  })

  it('detects the misconception, then delivers the explanation', async () => {
    const booted = await harness()
    stateThesis(booted)

    const detected = await booted.loop.step(booted.agent)

    expect(detected).toMatchObject({ stage: 'teach', action: 'deliver', pipelineStage: 'explain' })
    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)).toHaveLength(1)
    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)[0]?.recurrences).toBe(1)

    const message = booted.loop.directiveMessage(booted.agent)
    expect(message?.source).toMatchObject({ kind: 'mentor-loop', stage: 'explain' })
    expect(textOf(message as UserMessage)).toContain('An MSS marks a shift in delivery')
  })

  it('advances a stage only after the learner speaks again', async () => {
    const booted = await harness()
    stateThesis(booted)
    await booted.loop.step(booted.agent)
    deliver(booted)

    expect(booted.loop.position(booted.agent)).toMatchObject({
      stage: 'teach',
      action: 'none',
      waitingFor: 'a learner message after the explanation',
    })

    say(booted.agent, 'Then why did it reverse?')
    expect(booted.loop.position(booted.agent)).toMatchObject({ stage: 'teach', action: 'advance' })

    const advanced = await booted.loop.step(booted.agent)
    expect(advanced).toMatchObject({ stage: 'teach', action: 'deliver', pipelineStage: 'counterexample' })
    expect(deliver(booted)).toContain('supply zone')
  })

  it('assigns an exercise that targets the misconception\'s objective', async () => {
    const booted = await harness()
    stateThesis(booted)
    await booted.loop.step(booted.agent)
    deliver(booted)
    say(booted.agent, 'Because the zone held.')
    await booted.loop.step(booted.agent)
    deliver(booted)
    say(booted.agent, 'The MSS was into supply, not out of it.')
    await booted.loop.step(booted.agent)

    const text = deliver(booted)

    expect(text).toContain('Mark the last three MSS on EURUSD H1')
    expect(text).toContain('Place MSS inside a full entry model before taking an entry')
    expect(booted.ctx.learnerModel.objectives(booted.learnerId).map(objective => objective.statement))
      .toEqual([MSS_PATTERN.objective])
  })

  it('waits for a case artifact before assigning a new case, then resolves the misconception', async () => {
    const booted = await harness()
    stateThesis(booted)
    await booted.loop.step(booted.agent)
    deliver(booted)
    say(booted.agent, 'Because the zone held.')
    await booted.loop.step(booted.agent)
    deliver(booted)
    say(booted.agent, 'The MSS was into supply, not out of it.')
    await booted.loop.step(booted.agent)
    deliver(booted)
    say(booted.agent, 'Here is my attempt.')

    const attempted = await booted.loop.step(booted.agent)
    expect(attempted).toMatchObject({
      stage: 'reassess',
      action: 'none',
      pipelineStage: 'new-case',
      waitingFor: 'a case artifact for MSS treated as a standalone entry criterion',
    })
    expect(booted.loop.directiveMessage(booted.agent)).toBeUndefined()

    await booted.ctx.learnerModel.applyCase(booted.learnerId, {
      caseId: CaseReference('case-gbpusd'),
      symbol: 'GBPUSD',
      outcome: null,
      conceptsTested: [],
      lessons: [],
      mistakes: [],
      impacts: [],
      trust: 'trusted',
    })
    expect(booted.loop.position(booted.agent)).toMatchObject({ stage: 'reassess', action: 'deliver' })
    expect(deliver(booted)).toContain('case-gbpusd')

    say(booted.agent, 'I redid the reading and the demand array came first.')
    await booted.loop.step(booted.agent)
    deliver(booted)
    say(booted.agent, RESOLVED_THESIS)

    const complete = await booted.loop.step(booted.agent)

    expect(complete).toMatchObject({ stage: 'learner-model-update', action: 'none' })
    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)[0]?.status).toBe('resolved')
    expect(booted.ctx.learnerModel.objectives(booted.learnerId)).toEqual([])
  })

  it('counts a recurring mistake when the learner repeats the misconception', async () => {
    const booted = await harness()
    const misconceptionId = await toReassess(booted)
    deliver(booted)
    say(booted.agent, REPEATED_THESIS)

    const repeated = await booted.loop.step(booted.agent)

    expect(repeated).toMatchObject({ stage: 'teach', action: 'deliver', pipelineStage: 'explain' })
    expect(booted.ctx.learnerModel.mistakes(booted.learnerId)).toHaveLength(1)
    expect(booted.ctx.learnerModel.mistakes(booted.learnerId)[0]?.occurrences).toBe(1)
    expect(booted.ctx.learnerModel.misconceptions(booted.learnerId)[0]?.recurrences).toBe(2)
    expect(misconceptionId).toBe(String(booted.ctx.learnerModel.misconceptions(booted.learnerId)[0]?.misconceptionId))
  })

  it('injects the directive into the next admitted step and stops repeating it', async () => {
    const booted = await harness()
    stateThesis(booted)

    const first = await preStep(booted.ctx, booted.agent)
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]?.source).toMatchObject({ kind: 'mentor-loop', stage: 'explain' })
    expect(textOf(first.messages[0] as UserMessage)).toContain('An MSS marks a shift in delivery')

    commit(booted, first.messages[0] as UserMessage)
    const second = await preStep(booted.ctx, booted.agent)
    expect(second.messages).toEqual([])

    say(booted.agent, 'So what breaks that thesis?')
    const third = await preStep(booted.ctx, booted.agent)
    expect(third.messages).toHaveLength(1)
    expect(textOf(third.messages[0] as UserMessage)).toContain('supply zone')
  })

  it('announces each position it reaches once', async () => {
    const booted = await harness()
    const seen: MentorLoopReport[] = []
    booted.ctx.on('mentor/loop-position', (report) => { seen.push(report) })
    stateThesis(booted)

    await booted.loop.step(booted.agent)
    await booted.loop.step(booted.agent)

    expect(seen.map(report => report.stage)).toEqual(['teach'])
    expect(seen[0]?.learnerId).toBe('learner-1')
    expect(seen[0]?.action).toBe('deliver')
  })

  it('contains a failing step and leaves the turn decision untouched', async () => {
    const booted = await harness()
    stateThesis(booted)
    booted.kernel.state.view = () => { throw new Error('kernel unavailable') }

    await expect(preStep(booted.ctx, booted.agent)).resolves.toEqual({ messages: [] })
  })

  it('refuses a blank learner id', async () => {
    await expect(bootMentorLoop('   ')).rejects.toThrow('learnerId is blank')
  })
})

/** Drive the loop through teach, exercise, and the learner's attempt, stopping at the reassessment. */
async function toReassess(harness: MentorLoopHarness): Promise<string> {
  stateThesis(harness)
  await harness.loop.step(harness.agent)
  deliver(harness)
  say(harness.agent, 'Because the zone held.')
  await harness.loop.step(harness.agent)
  deliver(harness)
  say(harness.agent, 'The MSS was into supply, not out of it.')
  await harness.loop.step(harness.agent)
  deliver(harness)
  say(harness.agent, 'Here is my attempt.')
  await harness.loop.step(harness.agent)
  await harness.ctx.learnerModel.applyCase(harness.learnerId, {
    caseId: CaseReference('case-gbpusd'),
    symbol: 'GBPUSD',
    outcome: null,
    conceptsTested: [],
    lessons: [],
    mistakes: [],
    impacts: [],
    trust: 'trusted',
  })
  deliver(harness)
  say(harness.agent, 'I redid the reading and the demand array came first.')
  await harness.loop.step(harness.agent)
  const misconceptionId = String(harness.ctx.learnerModel.misconceptions(harness.learnerId)[0]?.misconceptionId)
  return misconceptionId
}
