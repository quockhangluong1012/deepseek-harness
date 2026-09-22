import { describe, expect, it, vi } from 'vitest'
import { runVerifierLadder, VERIFIER_LEVEL_NAMES, verifyDeterministic, verifySchema } from '../src/ladder.ts'

const BODY = '---\nname: leaf\ndescription: leaf skill\n---\nrewrite the leaf instructions\n'

describe('verifier ladder levels', () => {
  it('decides the schema level on the frontmatter invariant', () => {
    expect(verifySchema('leaf', BODY)).toEqual({
      status: 'passed',
      reason: "frontmatter parses and keeps name 'leaf' with a description",
    })
    expect(verifySchema('leaf', 'no fence at all\n')).toEqual({ status: 'failed', reason: 'body has no frontmatter' })
    expect(verifySchema('leaf', '---\nname: other\ndescription: d\n---\nbody\n').reason).toBe('skill "leaf" frontmatter must keep name "leaf"')
    expect(verifySchema('leaf', '---\nname: leaf\n---\nbody\n').reason).toBe('skill "leaf" frontmatter must keep a description')
    expect(verifySchema('leaf', '---\nname: [\n---\nbody\n').reason).toContain('kept invalid frontmatter')
  })

  it('decides the invariant level on the name and the instructions', () => {
    expect(verifyDeterministic('leaf', BODY)).toEqual({
      status: 'passed',
      reason: "'leaf' is a legal skill name with instructions to route on",
    })
    expect(verifyDeterministic('Leaf Skill', BODY)).toEqual({
      status: 'failed',
      reason: 'invalid skill name "Leaf Skill": use lowercase kebab-case like "code-review"',
    })
    expect(verifyDeterministic('leaf', '---\nname: leaf\ndescription: d\n---\n\n   \n')).toEqual({
      status: 'failed',
      reason: 'body carries no instructions after its frontmatter',
    })
    expect(verifyDeterministic('leaf', 'no fence at all\n').status).toBe('failed')
  })
})

describe('verifier ladder', () => {
  it('stops at the refusing rung and never consults a higher one', async () => {
    const simulator = vi.fn(async () => ({ status: 'passed' as const, reason: 'replay held' }))
    const verdict = await runVerifierLadder({ name: 'leaf', body: 'no fence at all\n', simulation: simulator })
    expect(verdict).toEqual({
      name: 'leaf',
      status: 'failed',
      decidedBy: 0,
      reason: 'schema: body has no frontmatter',
      rungs: [{ level: 0, status: 'failed', reason: 'body has no frontmatter' }],
    })
    expect(simulator).not.toHaveBeenCalled()
  })

  it('stops at the invariant rung for a body with no instructions', async () => {
    const verdict = await runVerifierLadder({ name: 'leaf', body: '---\nname: leaf\ndescription: leaf skill\n---\n' })
    expect(verdict).toMatchObject({
      status: 'failed',
      decidedBy: 1,
      reason: 'invariant: body carries no instructions after its frontmatter',
    })
  })

  it('reports the abstention of the rungs no host mounts instead of a pass', async () => {
    const verdict = await runVerifierLadder({ name: 'leaf', body: BODY })
    expect(verdict.status).toBe('abstained')
    expect(verdict.decidedBy).toBeNull()
    expect(verdict.rungs.map(rung => [rung.level, rung.status])).toEqual([
      [0, 'passed'],
      [1, 'passed'],
      [2, 'abstained'],
      [3, 'abstained'],
      [4, 'abstained'],
    ])
    expect(verdict.reason).toBe(
      'nothing failed; 3 of 5 rungs abstained: '
      + 'simulation (no domain simulator is mounted); evaluator (no evaluator model is mounted); human (no human review is recorded)',
    )
    expect(VERIFIER_LEVEL_NAMES[4]).toBe('human')
  })

  it('continues past an abstaining rung and stops at the refusing one', async () => {
    const evaluator = vi.fn(async () => ({ status: 'failed' as const, reason: 'the judge rejected the rewrite' }))
    const review = vi.fn(async () => ({ status: 'passed' as const, reason: 'operator approved' }))
    const verdict = await runVerifierLadder({
      name: 'leaf',
      body: BODY,
      simulation: async () => ({ status: 'abstained', reason: 'the corpus does not describe this skill' }),
      evaluator,
      review,
    })
    expect(verdict).toMatchObject({ status: 'failed', decidedBy: 3, reason: 'evaluator: the judge rejected the rewrite' })
    expect(verdict.rungs.map(rung => rung.status)).toEqual(['passed', 'passed', 'abstained', 'failed'])
    expect(review).not.toHaveBeenCalled()
  })

  it('passes only when every rung passed, credited to the human rung', async () => {
    const verdict = await runVerifierLadder({
      name: 'leaf',
      body: BODY,
      simulation: async () => ({ status: 'passed', reason: 'replay held' }),
      evaluator: async () => ({ status: 'passed', reason: 'judge approved' }),
      review: async () => ({ status: 'passed', reason: 'operator approved' }),
    })
    expect(verdict).toMatchObject({ status: 'passed', decidedBy: 4, reason: 'every rung of the ladder passed' })
    expect(verdict.rungs).toHaveLength(5)
  })

  it('reports an abstention when a mounted rung cannot judge the candidate', async () => {
    const verdict = await runVerifierLadder({
      name: 'leaf',
      body: BODY,
      simulation: async () => ({ status: 'abstained', reason: 'no scenario covers this skill' }),
      evaluator: async () => ({ status: 'passed', reason: 'judge approved' }),
      review: async () => ({ status: 'passed', reason: 'operator approved' }),
    })
    expect(verdict).toMatchObject({ status: 'abstained', decidedBy: null })
    expect(verdict.reason).toContain('1 of 5 rungs abstained: simulation (no scenario covers this skill)')
  })

  it('fails the verification when a mounted rung cannot run at all', async () => {
    await expect(runVerifierLadder({
      name: 'leaf',
      body: BODY,
      simulation: async () => { throw new Error('the replay harness is unavailable') },
    })).rejects.toThrow('the replay harness is unavailable')
  })
})
