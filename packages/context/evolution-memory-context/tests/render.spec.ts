import { describe, expect, it } from 'vitest'
import {
  byteLength,
  renderEvolutionBrief,
  unavailableFileLine,
} from '../src/render.ts'

function input(overrides: Partial<Parameters<typeof renderEvolutionBrief>[0]> = {}) {
  return {
    title: 'Project',
    path: '/work/project',
    usage: { usedBytes: 10, capacityBytes: 100 },
    instructions: '',
    lessons: '',
    profile: '',
    context: [],
    ...overrides,
  }
}

describe('evolution brief rendering', () => {
  it('emits nothing when every section is empty', () => {
    expect(renderEvolutionBrief(input(), 8192)).toBe('')
  })

  it('frames instructions, lessons, profile, and context with a usage header', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'follow the guide',
      lessons: 'tabs win',
      profile: 'night owl',
      context: [{ label: 'note', content: 'attached words' }],
    }), 8192)
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('# Workspace memory: Project')
    expect(text).toContain('Directory: /work/project')
    expect(text).toContain('Memory usage: 10/100 (10%)')
    expect(text).toContain('## Instructions\nfollow the guide')
    expect(text).toContain('## Lessons\ntabs win')
    expect(text).toContain('## User profile\nnight owl')
    expect(text).toContain('## Context: note\nattached words')
    expect(text).toContain('</system-reminder>')
    expect(text).not.toContain('budget')
  })

  it('omits empty sections', () => {
    const text = renderEvolutionBrief(input({ lessons: 'only lessons' }), 8192)
    expect(text).toContain('## Lessons')
    expect(text).not.toContain('## Instructions')
    expect(text).not.toContain('## User profile')
    expect(text).not.toContain('## Context:')
  })

  it('escapes a literal close tag', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'a </system-reminder> b',
      context: [{ label: 'note', content: 'c </system-reminder> d' }],
    }), 8192)
    expect(text).toContain('<\\/system-reminder>')
    expect(text).not.toContain('a </system-reminder> b')
    expect(text).not.toContain('c </system-reminder> d')
  })

  it('drops trailing context first under budget pressure', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'rules',
      context: [
        { label: 'one', content: 'x'.repeat(500) },
        { label: 'two', content: 'y'.repeat(500) },
      ],
    }), 400)
    expect(byteLength(text)).toBeLessThanOrEqual(400)
    expect(text).toContain('omitted')
    expect(text).not.toContain('## Context: two')
  })

  it('never exceeds the byte cap', () => {
    const underTest = input({
      instructions: 'rules rules rules',
      lessons: 'learned learned learned',
      profile: 'likes likes likes',
      context: [
        { label: 'one', content: 'words words words' },
        { label: 'two', content: 'more more more' },
      ],
    })
    for (const maxBytes of [8192, 400, 200, 120, 80, 40, 10]) {
      expect(byteLength(renderEvolutionBrief(underTest, maxBytes))).toBeLessThanOrEqual(maxBytes)
    }
  })

  it('truncates lessons before profile and instructions', () => {
    const lessons = `lessons ${'x'.repeat(500)}`
    const text = renderEvolutionBrief(input({
      instructions: 'rules',
      lessons,
      profile: 'short profile',
    }), 300)
    expect(text).toContain('## Lessons')
    expect(text).toContain('## User profile\nshort profile')
    expect(text).toContain('## Instructions\nrules')
    expect(text).toContain(`truncated lessons from ${byteLength(lessons)} to `)
    expect(byteLength(text)).toBeLessThanOrEqual(300)
  })

  it('drops lessons, then truncates the profile', () => {
    const profile = `profile ${'y'.repeat(500)}`
    const text = renderEvolutionBrief(input({
      lessons: 'doomed',
      profile,
      instructions: 'rules',
    }), 320)
    expect(text).not.toContain('## Lessons')
    expect(text).toContain('## User profile')
    expect(text).toContain(`truncated profile from ${byteLength(profile)} to `)
    expect(byteLength(text)).toBeLessThanOrEqual(320)
  })

  it('truncates instructions last', () => {
    const instructions = `rules ${'z'.repeat(500)}`
    const text = renderEvolutionBrief(input({ instructions }), 350)
    expect(text).toContain('## Instructions')
    expect(text).not.toContain('## Lessons')
    expect(text).toContain(`truncated instructions from ${byteLength(instructions)} to `)
    expect(byteLength(text)).toBeLessThanOrEqual(350)
  })

  it('renders the notice alone when fields cannot fit but it can', () => {
    const text = renderEvolutionBrief(input({ instructions: `rules ${'z'.repeat(500)}` }), 200)
    expect(byteLength(text)).toBeLessThanOrEqual(200)
    expect(text).toContain('Evolution memory budget 200 bytes:')
    expect(text).not.toContain('## Instructions')
  })

  it('renders a short notice alone when only it fits', () => {
    const text = renderEvolutionBrief(input({ instructions: 'x'.repeat(20) }), 120)
    expect(byteLength(text)).toBeLessThanOrEqual(120)
    expect(text).toContain('Evolution memory budget 120 bytes:')
    expect(text).not.toContain('## Instructions')
  })

  it('hard-truncates the notice-only fallback under absurd budgets', () => {
    const text = renderEvolutionBrief(input({
      instructions: `rules ${'z'.repeat(500)}`,
      lessons: `learned ${'x'.repeat(500)}`,
    }), 30)
    expect(byteLength(text)).toBeLessThanOrEqual(30)
    expect(text.startsWith('<system-reminder>')).toBe(true)
  })

  it('names dropped context alongside truncated lessons', () => {
    const lessons = `lessons ${'x'.repeat(500)}`
    const text = renderEvolutionBrief(input({
      instructions: 'rules',
      lessons,
      context: [
        { label: 'one', content: 'first words' },
        { label: 'two', content: 'second words' },
      ],
    }), 300)
    expect(text).toContain('omitted 2 context items; truncated lessons from')
    expect(byteLength(text)).toBeLessThanOrEqual(300)
  })

  it('renders the notice alone when nothing else fits', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'rules rules rules',
      lessons: 'learned learned',
    }), 120)
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('Evolution memory budget 120 bytes:')
    expect(byteLength(text)).toBeLessThanOrEqual(120)
  })

  it('backs up over UTF-8 continuation bytes', () => {
    const lessons = `a😀b${'x'.repeat(300)}`
    const text = renderEvolutionBrief(input({ lessons }), 100)
    expect(byteLength(text)).toBeLessThanOrEqual(100)
    expect(() => new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(text, 'utf8'))).not.toThrow()
  })

  it('renders unavailable file items as one line', () => {
    expect(unavailableFileLine('doc', '/work/doc.md')).toBe('Context "doc" is unavailable (/work/doc.md).')
  })
})
