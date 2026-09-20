import { describe, expect, it } from 'vitest'
import {
  CONTRIBUTION_CLASSES,
  UNCLASSIFIED_CONTRIBUTION,
  RETENTION_BY_KIND,
  classifyContribution,
  retentionOf,
} from '../src/classify.ts'
import type { ContextSourceKind } from '../src/types.ts'

describe('contribution classification', () => {
  it('classifies every shipped family by its name prefix', () => {
    for (const rule of CONTRIBUTION_CLASSES) {
      expect(classifyContribution(`${rule.prefix}anything`)).toEqual({
        kind: rule.kind,
        trust: rule.trust,
        source: rule.source,
      })
    }
  })

  it('treats an unlisted family as untrusted repository content', () => {
    expect(classifyContribution('mystery:contribution')).toEqual(UNCLASSIFIED_CONTRIBUTION)
    expect(classifyContribution('unprefixed')).toBe(UNCLASSIFIED_CONTRIBUTION)
  })

  it('keeps the task authority required and drops only guidance and data', () => {
    for (const [kind, retention] of Object.entries(RETENTION_BY_KIND)) {
      expect(retentionOf(kind as ContextSourceKind)).toBe(retention)
    }
    expect(retentionOf('policy')).toBe('required')
    expect(retentionOf('task')).toBe('required')
    expect(retentionOf('plan')).toBe('required')
    expect(retentionOf('evidence')).toBe('required')
    expect(retentionOf('tool')).toBe('compressible')
    expect(retentionOf('artifact')).toBe('compressible')
    expect(retentionOf('history')).toBe('compressible')
    expect(retentionOf('memory')).toBe('compressible')
  })
})
