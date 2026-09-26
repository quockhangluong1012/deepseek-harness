import { describe, expect, it } from 'vitest'
import { attributeImprovement, changedDependencies, comparable, DEPENDENCY_KEYS, lineDiff, revisionKey } from '../src/lineage.ts'
import type { DependencyVersions } from '../src/types.ts'

describe('revisionKey', () => {
  it('keeps a policy and its revision number in one distinct key', () => {
    expect(revisionKey('skill:writer', 2)).toBe('skill:writer#2')
    expect(revisionKey('skill:writer', 12)).not.toBe(revisionKey('skill:writer', 2))
  })
})

describe('lineDiff', () => {
  it('reports zero for identical bodies', () => {
    expect(lineDiff('# writer\nrule one\n', '# writer\nrule one\n')).toEqual({ addedLines: 0, removedLines: 0 })
  })

  it('counts one added and one removed line for a changed rule', () => {
    expect(lineDiff('# writer\nold rule\n', '# writer\nnew rule\n')).toEqual({ addedLines: 1, removedLines: 1 })
  })

  it('counts appended lines as added only', () => {
    expect(lineDiff('# writer\n', '# writer\nrule one\nrule two\n')).toEqual({ addedLines: 2, removedLines: 0 })
  })

  it('counts a pure reorder as change, since order is content', () => {
    expect(lineDiff('a\nb\n', 'b\na\n')).toEqual({ addedLines: 1, removedLines: 1 })
  })

  it('shares context across a substitution, so surrounding lines cost nothing', () => {
    expect(lineDiff('head\nold\ntail\n', 'head\nnew\ntail\n')).toEqual({ addedLines: 1, removedLines: 1 })
  })
})

describe('DEPENDENCY_KEYS', () => {
  it('lists every dependency in canonical order', () => {
    expect([...DEPENDENCY_KEYS]).toEqual(['prompt', 'skill', 'retriever', 'evaluator', 'model', 'tool', 'env'])
  })
})

describe('changedDependencies', () => {
  it('reports no change for identical records', () => {
    const versions: DependencyVersions = { skill: 'v1', evaluator: 'v2' }
    expect(changedDependencies(versions, { ...versions }, DEPENDENCY_KEYS)).toEqual([])
  })

  it('counts an undefined version against a recorded one as changed', () => {
    expect(changedDependencies({}, { skill: 'v1' }, DEPENDENCY_KEYS)).toEqual(['skill'])
    expect(changedDependencies({ skill: 'v1' }, {}, DEPENDENCY_KEYS)).toEqual(['skill'])
    expect(changedDependencies({}, {}, DEPENDENCY_KEYS)).toEqual([])
  })

  it('reports changed keys in the given order, not record order', () => {
    const a: DependencyVersions = { prompt: 'p1', skill: 's1', model: 'm1' }
    const b: DependencyVersions = { prompt: 'p2', skill: 's2', model: 'm2' }
    expect(changedDependencies(a, b, ['model', 'prompt'])).toEqual(['model', 'prompt'])
    expect(changedDependencies(a, b, DEPENDENCY_KEYS)).toEqual(['prompt', 'skill', 'model'])
  })

  it('ignores keys outside the given set', () => {
    const a: DependencyVersions = { skill: 's1', model: 'm1' }
    const b: DependencyVersions = { skill: 's2', model: 'm2' }
    expect(changedDependencies(a, b, ['skill'])).toEqual(['skill'])
  })
})

describe('comparable', () => {
  it('holds when no compared key changed', () => {
    const a: DependencyVersions = { skill: 's1', evaluator: 'e1', model: 'm1' }
    expect(comparable(a, { ...a }, ['skill', 'evaluator'])).toBe(true)
  })

  it('fails when any compared key changed', () => {
    const a: DependencyVersions = { skill: 's1', evaluator: 'e1' }
    expect(comparable(a, { ...a, evaluator: 'e2' }, ['skill', 'evaluator'])).toBe(false)
    expect(comparable(a, { ...a, evaluator: 'e2' }, ['skill'])).toBe(true)
  })
})

describe('attributeImprovement', () => {
  it('credits nothing when the joint arm fails', () => {
    expect(attributeImprovement({ baseline: false, aOnly: true, bOnly: true, both: false })).toBe('none')
    expect(attributeImprovement({ baseline: true, aOnly: false, bOnly: false, both: false })).toBe('none')
  })

  it('credits both changes when each reproduces the joint gain alone', () => {
    expect(attributeImprovement({ baseline: false, aOnly: true, bOnly: true, both: true })).toBe('both')
  })

  it('credits the single change that reproduces the joint gain', () => {
    expect(attributeImprovement({ baseline: false, aOnly: true, bOnly: false, both: true })).toBe('a')
    expect(attributeImprovement({ baseline: false, aOnly: false, bOnly: true, both: true })).toBe('b')
  })

  it('credits the interaction when neither change reproduces the gain alone', () => {
    expect(attributeImprovement({ baseline: false, aOnly: false, bOnly: false, both: true })).toBe('interaction')
  })
})
