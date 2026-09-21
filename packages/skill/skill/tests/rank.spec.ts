import { describe, expect, it } from 'vitest'
import { rankSkills } from '../src/rank.ts'
import type { RankSkillsOptions, SkillRankSignal } from '../src/rank.ts'

interface Fixture {
  name: string
  text: string
}

function skill(name: string, text: string): Fixture {
  return { name, text }
}

function textOf(candidate: Fixture): string {
  return `${candidate.name} ${candidate.text}`
}

function rank(query: string, skills: readonly Fixture[], options: RankSkillsOptions = {}) {
  return rankSkills(query, skills, candidate => candidate.name, textOf, options)
}

describe('rankSkills', () => {
  it('ranks nothing for no candidates', () => {
    expect(rank('query', [])).toEqual([])
  })

  it('orders an exact name match above a description match above no match', () => {
    const skills = [
      skill('unrelated', 'nothing to do with the request'),
      skill('code-review', 'does code review'),
      skill('deploy', 'ships after review'),
    ]
    const ordered = rank('code review', skills)
    expect(ordered.map(entry => entry.skill.name)).toEqual(['code-review', 'deploy', 'unrelated'])
    expect(ordered[2]?.roughScore).toBe(0)
    expect(ordered[0]?.score).toBeGreaterThan(ordered[1]?.score as number)
  })

  it('matches kebab-case names on their parts and unicode descriptions', () => {
    const ordered = rank('静态检查', [
      skill('lint', 'runs 静态检查 over the workspace'),
      skill('format', 'rewrites whitespace'),
    ])
    expect(ordered.map(entry => entry.skill.name)).toEqual(['lint', 'format'])
  })

  it('falls back to utility then name when the query matches nothing', () => {
    const signals = new Map<string, SkillRankSignal>([
      ['b-skill', { trusted: false, useCount: 10, failureCount: 0 }],
      ['a-skill', { trusted: true, useCount: 0, failureCount: 0 }],
    ])
    const ordered = rank('!!!', [
      skill('b-skill', ''),
      skill('a-skill', ''),
      skill('c-skill', ''),
    ], { signals })
    expect(ordered.map(entry => entry.skill.name)).toEqual(['a-skill', 'c-skill', 'b-skill'])
    for (const entry of ordered) {
      expect(entry.roughScore).toBe(0)
    }
  })

  it('demotes provisional and failure-prone skills at similar lexical fit', () => {
    const skills = [
      skill('alpha-review', 'reviews code for defects'),
      skill('beta-review', 'reviews code for defects'),
    ]
    const signals = new Map<string, SkillRankSignal>([
      ['alpha-review', { trusted: true, useCount: 5, failureCount: 0 }],
      ['beta-review', { trusted: false, useCount: 5, failureCount: 5 }],
    ])
    const ordered = rank('code review', skills, { signals })
    expect(ordered.map(entry => entry.skill.name)).toEqual(['alpha-review', 'beta-review'])
  })

  it('prefers the closer vector when lexical fit ties', () => {
    const skills = [skill('first', 'does things'), skill('second', 'does things')]
    const ordered = rank('things', skills, {
      vectors: {
        query: [1, 0],
        byName: new Map([
          ['first', [1, 0]],
          ['second', [0, 1]],
        ]),
      },
    })
    expect(ordered.map(entry => entry.skill.name)).toEqual(['first', 'second'])
  })

  it('gives no semantic support to missing, mismatched, or empty vectors', () => {
    const skills = [skill('first', 'does things'), skill('second', 'does things')]
    const without = rank('things', skills)
    const missing = rank('things', skills, {
      vectors: { query: [1, 0], byName: new Map([['first', [1, 0]]]) },
    })
    expect(missing.map(entry => entry.skill.name)).toEqual(['first', 'second'])
    expect(missing[1]).toEqual(without[1])
    const mismatched = rank('things', skills, {
      vectors: { query: [1, 0], byName: new Map([['first', [1]], ['second', [1]]]) },
    })
    expect(mismatched.map(entry => entry.skill.name)).toEqual(['first', 'second'])
    const empty = rank('things', skills, {
      vectors: { query: [], byName: new Map([['first', []], ['second', []]]) },
    })
    expect(empty.map(entry => entry.skill.name)).toEqual(['first', 'second'])
    const zeroed = rank('things', skills, {
      vectors: { query: [0, 0], byName: new Map([['first', [0, 0]], ['second', [0, 0]]]) },
    })
    expect(zeroed.map(entry => entry.skill.name)).toEqual(['first', 'second'])
    const negative = rank('things', skills, {
      vectors: { query: [1, 0], byName: new Map([['first', [-1, 0]], ['second', [-1, 0]]]) },
    })
    expect(negative.map(entry => entry.skill.name)).toEqual(['first', 'second'])
  })

  it('breaks full ties deterministically, including duplicate names', () => {
    const ordered = rank('', [skill('b', 'same'), skill('a', 'same'), skill('a', 'same')])
    expect(ordered.map(entry => entry.skill.name)).toEqual(['a', 'a', 'b'])
  })

  it('scores zero for a skill whose prerequisites are absent from the candidate set', () => {
    const skills = [
      skill('composed', 'reviews code with base rules'),
      skill('base', 'base review rules'),
    ]
    const requires = new Map([['composed', ['base']]])
    const gated = rank('code review', skills, { requires })
    expect(gated.find(entry => entry.skill.name === 'composed')?.score).toBeGreaterThan(0)
    const orphaned = rank('code review', [skills[0]!], { requires })
    expect(orphaned[0]?.score).toBe(0)
    expect(orphaned[0]?.roughScore).toBeGreaterThan(0)
  })

  it('leaves scores untouched when every prerequisite is present or none is declared', () => {
    const skills = [
      skill('composed', 'reviews code with base rules'),
      skill('base', 'base review rules'),
    ]
    const gated = rank('code review', skills, { requires: new Map([['composed', ['base']]]) })
    const plain = rank('code review', skills)
    expect(gated).toEqual(plain)
  })

  it('satisfies a prerequisite through a capability another candidate provides', () => {
    const skills = [
      skill('composed', 'reviews code with base rules'),
      skill('consultant', 'supplies review expertise on request'),
    ]
    const requires = new Map([['composed', ['base-rules']]])
    expect(rank('code review', skills, { requires }).find(entry => entry.skill.name === 'composed')?.score).toBe(0)
    const gated = rank('code review', skills, {
      requires,
      capabilities: new Map([['consultant', ['base-rules']]]),
    })
    expect(gated.find(entry => entry.skill.name === 'composed')?.score).toBeGreaterThan(0)
  })

  it('routes at most one of a conflicting pair, whichever side declares it', () => {
    const skills = [
      skill('alpha-review', 'reviews alpha changes'),
      skill('beta-review', 'reviews beta changes'),
    ]
    const conflicts = new Map([['beta-review', ['alpha-review']]])
    const ordered = rank('alpha review', skills, { conflicts })
    const alpha = ordered.find(entry => entry.skill.name === 'alpha-review')
    const beta = ordered.find(entry => entry.skill.name === 'beta-review')
    expect(alpha?.score).toBeGreaterThan(0)
    expect(beta?.score).toBe(0)
    expect(beta?.roughScore).toBeGreaterThan(0)
    expect(ordered[0]?.skill.name).toBe('alpha-review')
  })

  it('keeps a candidate whose unroutable rival declares the conflict', () => {
    const skills = [
      skill('rival', 'reviews alpha changes'),
      skill('sibling', 'reviews alpha changes too'),
    ]
    const conflicts = new Map([['rival', ['sibling']]])
    const requires = new Map([['rival', ['absent-base']]])
    const ordered = rank('alpha review', skills, { conflicts, requires })
    expect(ordered.find(entry => entry.skill.name === 'sibling')?.score).toBeGreaterThan(0)
  })

  it('excludes every rival a winner declares, not just the first', () => {
    const skills = [
      skill('alpha-review', 'reviews alpha changes'),
      skill('beta-review', 'reviews beta changes'),
      skill('gamma-review', 'reviews gamma changes'),
    ]
    const conflicts = new Map([['alpha-review', ['beta-review', 'gamma-review']]])
    const ordered = rank('alpha review beta gamma', skills, { conflicts })
    expect(ordered[0]?.skill.name).toBe('alpha-review')
    expect(ordered[0]?.score).toBeGreaterThan(0)
    for (const name of ['beta-review', 'gamma-review']) {
      expect(ordered.find(entry => entry.skill.name === name)?.score).toBe(0)
    }
  })

  it('drops a self-declared conflict instead of excluding its own skill', () => {
    const skills = [
      skill('alpha-review', 'reviews alpha changes'),
      skill('beta-review', 'reviews beta changes'),
    ]
    const conflicts = new Map([['alpha-review', ['alpha-review']]])
    expect(rank('alpha review beta', skills, { conflicts })).toEqual(rank('alpha review beta', skills))
  })

  it('leaves scores untouched when no relation is declared', () => {
    const skills = [
      skill('alpha-review', 'reviews alpha changes'),
      skill('beta-review', 'reviews beta changes'),
    ]
    expect(rank('alpha review', skills, { capabilities: new Map(), conflicts: new Map() })).toEqual(rank('alpha review', skills))
  })
})
