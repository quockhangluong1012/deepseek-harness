import { describe, expect, it } from 'vitest'
import type { LessonArtifact } from '@deepseek-ai/dsh-evolution-memory'
import { extractionSystemPrompt, frameExtractionRequest, parseExtractionDecisions } from '../src/protocol.ts'
import type { IndexedArtifact } from '../src/protocol.ts'

function artifact(statement: string): LessonArtifact {
  return {
    id: statement,
    statement,
    source: 'session-1',
    conditions: 'when editing the reviewer',
    evidence: 'fact',
    confidence: 0.8,
    validationCount: 0,
    refutationCount: 0,
    scope: 'project',
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z',
  }
}

const INDEXED: readonly IndexedArtifact[] = [
  { index: 1, artifact: artifact('ship the parser') },
  { index: 2, artifact: artifact('prefer pnpm') },
]

describe('extraction protocol prompt', () => {
  it('names all three actions verbatim', () => {
    const prompt = extractionSystemPrompt()
    expect(prompt).toContain('confirms')
    expect(prompt).toContain('contradicts')
    expect(prompt).toContain('new')
  })

  it('numbers the relevant artifacts from one and lists every statement', () => {
    const framed = frameExtractionRequest([{ role: 'user', text: 'hello' }], INDEXED)
    expect(framed).toContain('1. ship the parser')
    expect(framed).toContain('2. prefer pnpm')
    expect(framed).toContain(JSON.stringify([{ role: 'user', text: 'hello' }]))
  })
})

describe('parseExtractionDecisions', () => {
  it('accepts a fenced JSON block', () => {
    const fenced = '```json\n[{"action":"confirms","index":1}]\n```'
    expect(parseExtractionDecisions(fenced)).toEqual([{ action: 'confirms', index: 1 }])
  })

  it('accepts unfenced JSON carrying every action', () => {
    const raw = JSON.stringify([
      { action: 'confirms', index: 2 },
      { action: 'contradicts', index: 1, statement: 'ship the lexer', confidence: 0.4 },
      {
        action: 'new',
        statement: 'prefer vitest',
        conditions: 'when adding tests',
        evidence: 'inference',
        confidence: 0.6,
        scope: 'user',
        ttlDays: 30,
      },
    ])
    expect(parseExtractionDecisions(raw)).toEqual([
      { action: 'confirms', index: 2 },
      { action: 'contradicts', index: 1, statement: 'ship the lexer', confidence: 0.4 },
      {
        action: 'new',
        statement: 'prefer vitest',
        conditions: 'when adding tests',
        evidence: 'inference',
        confidence: 0.6,
        scope: 'user',
        ttlDays: 30,
      },
    ])
  })

  it('reads an empty or whitespace-only answer as no decisions', () => {
    expect(parseExtractionDecisions('')).toEqual([])
    expect(parseExtractionDecisions('   \n ')).toEqual([])
    expect(parseExtractionDecisions('```json\n```')).toEqual([])
    expect(parseExtractionDecisions('[]')).toEqual([])
  })

  it('rejects an action outside the three', () => {
    expect(() => parseExtractionDecisions('[{"action":"ignores","index":1}]'))
      .toThrow('evolution-reviewer: extraction returned an invalid decision list')
  })

  it('rejects a non-integer or non-positive index', () => {
    expect(() => parseExtractionDecisions('[{"action":"confirms","index":1.5}]'))
      .toThrow('evolution-reviewer: extraction returned an invalid decision list')
    expect(() => parseExtractionDecisions('[{"action":"contradicts","index":0}]'))
      .toThrow('evolution-reviewer: extraction returned an invalid decision list')
    expect(() => parseExtractionDecisions('[{"action":"confirms","index":-2}]'))
      .toThrow('evolution-reviewer: extraction returned an invalid decision list')
  })

  it('rejects a new decision missing a required field', () => {
    expect(() => parseExtractionDecisions('[{"action":"new","statement":"prefer vitest"}]'))
      .toThrow('evolution-reviewer: extraction returned an invalid decision list')
    const withoutScope = JSON.stringify([{
      action: 'new',
      statement: 'prefer vitest',
      conditions: 'always',
      evidence: 'fact',
      confidence: 0.5,
    }])
    expect(() => parseExtractionDecisions(withoutScope))
      .toThrow('evolution-reviewer: extraction returned an invalid decision list')
  })

  it('rejects a payload that is not a JSON array of decisions', () => {
    expect(() => parseExtractionDecisions('{"action":"confirms","index":1}'))
      .toThrow('evolution-reviewer: extraction returned an invalid decision list')
  })

  it('rejects unparseable output', () => {
    expect(() => parseExtractionDecisions('not json at all'))
      .toThrow('evolution-reviewer: extraction did not return JSON')
  })
})
