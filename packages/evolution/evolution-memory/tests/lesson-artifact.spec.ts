import { describe, expect, it } from 'vitest'
import { artifactKey, lessonArtifact, wrapLegacyLessons } from '../src/lesson-artifact.ts'

const NOW = '2026-09-13T00:00:00.000Z'

describe('lesson artifacts', () => {
  it('keys a statement by its normalized text, not its raw text', () => {
    expect(artifactKey('  Use   PostgreSQL  ')).toBe(artifactKey('use postgresql'))
    expect(artifactKey('use postgresql')).not.toBe(artifactKey('use mysql'))
  })

  it('wraps a legacy lessons document as one coarse artifact', () => {
    const wrapped = wrapLegacyLessons('## Purpose\nWork', NOW)
    expect(wrapped).toHaveLength(1)
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
})
