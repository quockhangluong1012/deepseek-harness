import { describe, expect, it } from 'vitest'
import { artifactKey, lessonArtifact, lessonArtifactInput, scrubArtifactText, wrapLegacyLessons } from '../src/lesson-artifact.ts'

const NOW = '2026-09-13T00:00:00.000Z'

describe('lesson artifacts', () => {
  it('keys a statement by its normalized text, not its raw text', () => {
    expect(artifactKey('  Use   PostgreSQL  ')).toBe(artifactKey('use postgresql'))
    expect(artifactKey('use postgresql')).not.toBe(artifactKey('use mysql'))
  })

  it('wraps a legacy lessons document as one coarse artifact', () => {
    const wrapped = wrapLegacyLessons('## Purpose\nWork', NOW)
    expect(wrapped).toHaveLength(1)
    expect(wrapped[0]?.id).toBe(artifactKey('## Purpose\nWork'))
    expect(wrapped[0]).toMatchObject({
      statement: '## Purpose\nWork',
      source: 'migration-pending',
      evidence: 'inference',
      confidence: 0.5,
      conditions: '',
      scope: 'project',
      validationCount: 0,
      refutationCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  it('wraps empty or whitespace-only text as no artifacts', () => {
    expect(wrapLegacyLessons('', NOW)).toEqual([])
    expect(wrapLegacyLessons('   \n ', NOW)).toEqual([])
  })

  it('rejects an artifact outside the declared vocabularies', () => {
    expect(lessonArtifact.safeParse({
      id: 'x', statement: 's', source: 'src', conditions: '', evidence: 'guess',
      confidence: 0.5, validationCount: 0, refutationCount: 0, scope: 'project',
      createdAt: NOW, updatedAt: NOW,
    }).success).toBe(false)
    expect(lessonArtifact.safeParse({
      id: 'x', statement: 's', source: 'src', conditions: '', evidence: 'fact',
      confidence: 2, validationCount: 0, refutationCount: 0, scope: 'project',
      createdAt: NOW, updatedAt: NOW,
    }).success).toBe(false)
  })

  it('parses a caller-supplied candidate through the input schema', () => {
    const candidate = {
      statement: 'prefer pnpm over npm',
      source: 'session-1',
      conditions: '',
      evidence: 'fact' as const,
      confidence: 0.5,
      scope: 'project' as const,
    }
    expect(lessonArtifactInput.parse(candidate)).toEqual(candidate)
  })

  it('rejects a candidate that omits the scope', () => {
    expect(lessonArtifactInput.safeParse({
      statement: 'prefer pnpm over npm', source: 'session-1', conditions: '',
      evidence: 'fact', confidence: 0.5,
    }).success).toBe(false)
  })
})

describe('credential scrubbing before a durable write', () => {
  it('replaces recognized credential shapes in the text a lesson stores', () => {
    expect(scrubArtifactText('use sk-abcdefghijklmnopqrstuvwxyz0123 for the API')).toBe('use [REDACTED] for the API')
    expect(scrubArtifactText('curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"')).toBe('curl -H "Authorization: [REDACTED]"')
    expect(scrubArtifactText('AKIAIOSFODNN7EXAMPLE is the access key')).toBe('[REDACTED] is the access key')
    // Ordinary prose is untouched.
    expect(scrubArtifactText('prefer tabs over spaces')).toBe('prefer tabs over spaces')
  })
})
