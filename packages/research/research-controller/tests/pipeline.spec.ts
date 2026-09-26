/**
 * The research loop's pure transitions: the stage order and its gates, what one
 * stage records, and the answer contract the epistemic review enforces. These
 * functions touch no provider, no kernel record, and no storage.
 */
import { describe, expect, it } from 'vitest'
import { ResearchError } from '../src/errors.ts'
import {
  ANSWER_BUCKETS,
  assertAdvanceable,
  buildAnswer,
  failStage,
  nextStage,
  renderRun,
  reviewAnswer,
  settleStage,
  stageOf,
  startRun,
} from '../src/pipeline.ts'
import { PROVIDER_STAGES, RESEARCH_STAGES, STAGE_DEFINITIONS } from '../src/stages.ts'
import type { ResearchAnswer, ResearchRunRecord, SectionInput } from '../src/types.ts'

const AT = '2026-01-01T00:00:00.000Z'
const CLAIMS = ['claim-1', 'claim-2']

/** One run opened at the question stage. */
function opened(question = 'Does clause 4 hold?'): ResearchRunRecord {
  return startRun({ runId: 'run-1', sessionId: 'session-1', taskId: 'task-1', question, startedAt: AT })
}

/** One run whose stages up to synthesis produced, with the supplied answer. */
function synthesized(sections: readonly SectionInput[]): ResearchRunRecord {
  let run = opened()
  run = settleStage(run, 'decompose', { output: ['Which clause applies?'] }, AT)
  run = settleStage(run, 'research-plan', { output: ['Read the specification'] }, AT)
  run = settleStage(run, 'search', { output: ['found one source'], evidence: ['evidence-1'], provider: 'test-search' }, AT)
  run = settleStage(run, 'source-triage', { output: ['primary: https://example.test/spec'], provider: 'test-triage' }, AT)
  run = settleStage(run, 'claim-extraction', { output: ['clause 4 applies'], claims: [...CLAIMS] }, AT)
  run = settleStage(run, 'evidence', { output: ['web: https://example.test/spec'], evidence: ['evidence-1'], claims: [...CLAIMS] }, AT)
  run = settleStage(run, 'contradiction-search', { output: ['no counter-evidence'], provider: 'test-contradiction' }, AT)
  return settleStage(run, 'synthesis', {
    output: sections.map(section => `${section.bucket}: ${section.statement}`),
    answer: buildAnswer(sections, CLAIMS),
  }, AT)
}

/** The answer a caller states for one run. */
const GROUNDED: readonly SectionInput[] = [
  { bucket: 'documented', statement: 'clause 4 applies', claims: [...CLAIMS] },
  { bucket: 'unresolved', statement: 'no counter-evidence was found', claims: [] },
]

describe('stage table', () => {
  it('orders the ten stages of the loop, exactly one definition each', () => {
    expect(RESEARCH_STAGES).toEqual([
      'question',
      'decompose',
      'research-plan',
      'search',
      'source-triage',
      'claim-extraction',
      'evidence',
      'contradiction-search',
      'synthesis',
      'epistemic-review',
    ])
    expect(STAGE_DEFINITIONS.map(definition => definition.stage)).toEqual(RESEARCH_STAGES)
    expect(PROVIDER_STAGES.map(stage => STAGE_DEFINITIONS.find(entry => entry.stage === stage)?.producer))
      .toEqual(['provider', 'provider', 'provider'])
  })
})

describe('run transitions', () => {
  it('opens a run with the question produced and every other stage pending', () => {
    const run = opened()
    expect(run.taskClass).toBe('research')
    expect(run.answer).toBeNull()
    expect(run.settledAt).toBeNull()
    expect(stageOf(run, 'question')).toMatchObject({ status: 'produced', output: ['Does clause 4 hold?'] })
    expect(stageOf(run, 'decompose')).toMatchObject({ status: 'pending', provider: null, settledAt: null, failure: null })
    expect(nextStage(run)?.stage).toBe('decompose')
  })

  it('refuses a blank question', () => {
    expect(() => opened('   ')).toThrow(ResearchError)
  })

  it('names a stage the run does not carry', () => {
    const run = opened()
    expect(() => stageOf({ ...run, stages: [] }, 'synthesis')).toThrow(/has no "synthesis" stage/)
  })

  it('refuses an advance that is not the run’s next stage', () => {
    const run = opened()
    expect(() =>{  assertAdvanceable(run, 'search') }).toThrow(/run-1 is at stage "decompose"; "search" cannot run before it/)
    expect(() =>{  assertAdvanceable(run, 'decompose') }).not.toThrow()
  })

  it('refuses any advance once the answer is accepted', () => {
    const run = settledRun()
    expect(() =>{  assertAdvanceable(run, 'synthesis') }).toThrow(/has no stage left to advance/)
    expect(() =>{  assertAdvanceable(run, 'epistemic-review') }).toThrow(/has no stage left to advance/)
  })

  it('keeps every other stage while one settles, then records a failure', () => {
    const run = settleStage(opened(), 'decompose', { output: ['Which clause applies?'], evidence: [], claims: [] }, AT)
    expect(stageOf(run, 'decompose')).toMatchObject({
      status: 'produced',
      output: ['Which clause applies?'],
      provider: null,
      failure: null,
      settledAt: AT,
    })
    expect(stageOf(run, 'question').status).toBe('produced')

    const failed = failStage(run, 'research-plan', 'no provider is registered for "research-plan"', AT)
    expect(stageOf(failed, 'research-plan')).toMatchObject({
      status: 'failed',
      output: [],
      failure: 'no provider is registered for "research-plan"',
      settledAt: AT,
    })
    expect(nextStage(failed)?.stage).toBe('research-plan')
    expect(() =>{  assertAdvanceable(failed, 'research-plan') }).not.toThrow()
  })

  it('admits a revision while the review that refused the answer is the next stage', () => {
    const refused = failStage(synthesized(GROUNDED), 'epistemic-review', 'the answer was refused', AT)
    expect(() =>{  assertAdvanceable(refused, 'synthesis') }).not.toThrow()
    expect(() =>{  assertAdvanceable(refused, 'evidence') }).toThrow(/is at stage "epistemic-review"/)

    const revised = settleStage(refused, 'synthesis', { output: ['documented: clause 4 applies'], answer: buildAnswer(GROUNDED, CLAIMS) }, AT)
    expect(stageOf(revised, 'epistemic-review')).toMatchObject({ status: 'pending', output: [], failure: null, settledAt: null })
    expect(nextStage(revised)?.stage).toBe('epistemic-review')
  })
})

describe('answer contract', () => {
  it('groups statements into the six buckets, keeping every citation', () => {
    const answer = buildAnswer([
      { bucket: 'observation', statement: 'the log records two retries', claims: ['claim-1', 'claim-2'] },
      { bucket: 'unresolved', statement: 'the third retry is unexplained', claims: [] },
    ], CLAIMS)
    expect(ANSWER_BUCKETS).toEqual(['documented', 'observation', 'interpretation', 'inference', 'hypothesis', 'unresolved'])
    expect(answer.observation).toEqual([{ statement: 'the log records two retries', claims: ['claim-1', 'claim-2'] }])
    expect(answer.unresolved).toEqual([{ statement: 'the third retry is unexplained', claims: [] }])
    expect(answer.documented).toEqual([])
  })

  it('refuses a blank statement and a citation the run never recorded', () => {
    expect(() => buildAnswer([{ bucket: 'documented', statement: '  ', claims: ['claim-1'] }], CLAIMS))
      .toThrow(/a synthesis statement is empty/)
    expect(() => buildAnswer([{ bucket: 'documented', statement: 'clause 4 applies', claims: ['missing'] }], CLAIMS))
      .toThrow(/cites claim "missing", which this run never recorded/)
  })

  it('reviews nothing as a violation and accepts a grounded answer', () => {
    expect(reviewAnswer(opened())).toEqual(['the run produced no answer to review'])
    expect(reviewAnswer({ ...synthesized(GROUNDED), answer: buildAnswer([], CLAIMS) })).toEqual([
      'the answer states nothing',
      'claim "claim-1" is stated in no bucket',
      'claim "claim-2" is stated in no bucket',
    ])
    expect(reviewAnswer(synthesized(GROUNDED))).toEqual([])
  })

  it('names an ungrounded statement and a claim stated in no bucket', () => {
    const ungrounded = reviewAnswer(synthesized([
      { bucket: 'inference', statement: 'clause 4 therefore applies', claims: [] },
      { bucket: 'unresolved', statement: 'nothing else is open', claims: [] },
    ]))
    expect(ungrounded).toContain('the inference statement "clause 4 therefore applies" rests on no claim')
    expect(ungrounded).toContain('claim "claim-1" is stated in no bucket')
    expect(ungrounded).toContain('claim "claim-2" is stated in no bucket')
  })

  it('renders the run, its failures, the next stage, and an accepted answer', () => {
    const run = settledRun()
    const rendered = renderRun(run)
    expect(rendered).toContain('research run run-1 (10/10 stages produced)')
    expect(rendered).toContain('question: Does clause 4 hold?')
    expect(rendered).toContain('- search: produced by test-search')
    expect(rendered).toContain('next: none')
    expect(rendered).toContain('answer:')
    expect(rendered).toContain('documented: clause 4 applies [claims: claim-1, claim-2]')
  })

  it('renders a failed stage, its reason, and the stage to advance next', () => {
    const refused = failStage(synthesized(GROUNDED), 'epistemic-review', 'the answer was refused: nothing', AT)
    const rendered = renderRun(refused)
    expect(rendered).toContain('- epistemic-review: failed')
    expect(rendered).toContain('  the answer was refused: nothing')
    expect(rendered).toContain('next: epistemic-review (agent-loop)')
  })

  it('renders an unsettled run without an answer section', () => {
    const rendered = renderRun(failStage({ ...opened(), question: '' }, 'decompose', 'failing', AT))
    expect(rendered).not.toContain('\nquestion:')
    expect(rendered).toContain('next: decompose (agent-loop)')
    expect(rendered).not.toContain('answer:')
  })
})

/** One run whose answer the review accepted. */
function settledRun(): ResearchRunRecord {
  const at = '2026-01-02T00:00:00.000Z'
  return { ...settleStage(synthesized(GROUNDED), 'epistemic-review', { output: ['documented: 1'] }, at), settledAt: at }
}

describe('answer shape', () => {
  it('carries one list per bucket', () => {
    const answer: ResearchAnswer = buildAnswer(GROUNDED, CLAIMS)
    expect(Object.keys(answer).sort()).toEqual([...ANSWER_BUCKETS].sort())
  })
})
