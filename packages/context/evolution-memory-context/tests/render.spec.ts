import { describe, expect, it } from 'vitest'
import { artifactKey, type LessonArtifact } from '@deepseek-ai/dsh-evolution-memory'
import {
  byteLength,
  evolutionBriefSections,
  renderEvolutionBrief,
  renderLessonLines,
  unavailableFileLine,
} from '../src/render.ts'

/** One lesson artifact fixture; identity follows the real key derivation. */
function lesson(statement: string, confidence: number): LessonArtifact {
  return {
    id: artifactKey(statement),
    statement,
    source: 's1',
    conditions: '',
    evidence: 'fact',
    confidence,
    validationCount: 0,
    refutationCount: 0,
    scope: 'project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function input(overrides: Partial<Parameters<typeof renderEvolutionBrief>[0]> = {}) {
  return {
    title: 'Project',
    path: '/work/project',
    usage: { usedBytes: 10, capacityBytes: 100 },
    capacityWarnPct: 0.8,
    instructions: '',
    lessons: [],
    profile: '',
    context: [],
    ...overrides,
  }
}

describe('lesson line rendering', () => {
  it('renders lessons strongest first and drops the weakest under pressure', () => {
    const artifacts = [lesson('weak fact', 0.2), lesson('strong fact', 0.9)]
    expect(renderLessonLines(artifacts, 4096).text).toBe('- strong fact (confidence: 0.90)\n- weak fact (confidence: 0.20)')
    const tight = renderLessonLines(artifacts, byteLength('- strong fact (confidence: 0.90)'))
    expect(tight.text).toBe('- strong fact (confidence: 0.90)')
    expect(tight.dropped).toBe(1)
  })

  it('breaks a confidence tie by ascending id', () => {
    // This order makes the sort compare both directions of the id tie-break.
    const artifacts = [lesson('beta fact', 0.5), lesson('gamma fact', 0.5), lesson('alpha fact', 0.5)]
    expect(renderLessonLines(artifacts, 4096).text).toBe(
      '- alpha fact (confidence: 0.50)\n- beta fact (confidence: 0.50)\n- gamma fact (confidence: 0.50)',
    )
  })

  it('renders an empty block when not even one artifact fits', () => {
    const rendered = renderLessonLines([lesson('a fact long enough to overflow', 0.9)], 4)
    expect(rendered.text).toBe('')
    expect(rendered.dropped).toBe(1)
  })

  it('renders an empty block for an empty artifact array', () => {
    expect(renderLessonLines([], 4096)).toEqual({ text: '', dropped: 0 })
  })
})

describe('evolution brief rendering', () => {
  it('emits nothing when every section is empty', () => {
    expect(renderEvolutionBrief(input(), 8192)).toBe('')
  })

  it('frames instructions, lessons, profile, and context with a usage header', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'follow the guide',
      lessons: [lesson('tabs win', 0.9)],
      profile: 'night owl',
      context: [{ label: 'note', content: 'attached words' }],
    }), 8192)
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('# Workspace memory: Project')
    expect(text).toContain('Directory: /work/project')
    expect(text).toContain('Memory usage: 10/100 (10%)')
    expect(text).toContain('## Instructions\nfollow the guide')
    expect(text).toContain('## Lessons\n- tabs win (confidence: 0.90)')
    expect(text).toContain('## User profile\nnight owl')
    expect(text).toContain('## Context: note\nattached words')
    expect(text).toContain('</system-reminder>')
    expect(text).not.toContain('budget')
  })

  it('warns in the header once usage reaches the warn threshold', () => {
    const full = renderEvolutionBrief(input({
      instructions: 'follow the guide',
      usage: { usedBytes: 80, capacityBytes: 100 },
      capacityWarnPct: 0.8,
    }), 8192)
    expect(full).toContain('Memory usage: 80/100 (80%) — near capacity: consolidate instead of adding')
    const below = renderEvolutionBrief(input({
      instructions: 'follow the guide',
      usage: { usedBytes: 79, capacityBytes: 100 },
      capacityWarnPct: 0.8,
    }), 8192)
    expect(below).toContain('Memory usage: 79/100 (79%)')
    expect(below).not.toContain('near capacity')
  })

  it('honours a custom warn threshold', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'follow the guide',
      usage: { usedBytes: 10, capacityBytes: 100 },
      capacityWarnPct: 0.1,
    }), 8192)
    expect(text).toContain('near capacity')
  })

  it('omits empty sections', () => {
    const text = renderEvolutionBrief(input({ lessons: [lesson('only lessons', 0.5)] }), 8192)
    expect(text).toContain('## Lessons')
    expect(text).not.toContain('## Instructions')
    expect(text).not.toContain('## User profile')
    expect(text).not.toContain('## Context:')
  })

  it('renders no lessons section for an empty artifact array', () => {
    const withLessons = input({ instructions: 'rules' })
    const text = renderEvolutionBrief(withLessons, 8192)
    expect(text).not.toContain('## Lessons')
    expect(evolutionBriefSections(withLessons, 8192).map(section => section.name))
      .not.toContain('Lessons')
  })

  it('escapes a close tag in a lesson statement instead of closing the frame early', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'a </system-reminder> b',
      lessons: [lesson('never emit </system-reminder> raw', 0.9)],
      context: [{ label: 'note', content: 'c </system-reminder> d' }],
    }), 8192)
    expect(text).toContain('<\\/system-reminder>')
    expect(text).not.toContain('a </system-reminder> b')
    expect(text).not.toContain('never emit </system-reminder> raw')
    expect(text).not.toContain('c </system-reminder> d')
    // Exactly one literal close tag survives: the frame's own final line.
    expect(text.indexOf('</system-reminder>')).toBe(text.lastIndexOf('</system-reminder>'))
    expect(text.endsWith('</system-reminder>')).toBe(true)
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
      lessons: [lesson('learned learned learned', 0.9)],
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

  it('drops the weakest lessons before profile and instructions', () => {
    const weakest = `charlie lesson ${'c'.repeat(80)}`
    const text = renderEvolutionBrief(input({
      instructions: 'rules',
      lessons: [lesson('alpha lesson', 0.9), lesson('bravo lesson', 0.8), lesson(weakest, 0.1)],
      profile: 'short profile',
    }), 320)
    expect(text).toContain('- alpha lesson (confidence: 0.90)')
    expect(text).toContain('- bravo lesson (confidence: 0.80)')
    expect(text).not.toContain(weakest)
    expect(text).toContain('omitted 1 lesson artifact')
    expect(text).toContain('## User profile\nshort profile')
    expect(text).toContain('## Instructions\nrules')
    expect(byteLength(text)).toBeLessThanOrEqual(320)
  })

  it('reports a plural drop count when several weakest lessons go', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'rules',
      lessons: [lesson('alpha lesson', 0.9), lesson('bravo lesson', 0.8), lesson('charlie lesson', 0.1)],
      profile: 'short profile',
    }), 250)
    expect(text).not.toContain('## Lessons')
    expect(text).toContain('omitted 3 lesson artifacts')
    expect(byteLength(text)).toBeLessThanOrEqual(250)
  })

  it('drops every lesson, then truncates the profile', () => {
    const profile = `profile ${'y'.repeat(500)}`
    const text = renderEvolutionBrief(input({
      lessons: [lesson('doomed', 0.4)],
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
      lessons: [lesson(`learned ${'x'.repeat(500)}`, 0.9)],
    }), 30)
    expect(byteLength(text)).toBeLessThanOrEqual(30)
    expect(text.startsWith('<system-reminder>')).toBe(true)
  })

  it('names dropped context alongside dropped lessons', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'rules',
      lessons: [lesson(`lessons ${'x'.repeat(500)}`, 0.4)],
      context: [
        { label: 'one', content: 'first words' },
        { label: 'two', content: 'second words' },
      ],
    }), 300)
    expect(text).toContain('omitted 2 context items; omitted 1 lesson artifact')
    expect(byteLength(text)).toBeLessThanOrEqual(300)
  })

  it('renders the notice alone when only lessons and profile cannot fit', () => {
    const text = renderEvolutionBrief(input({
      lessons: [lesson('doomed lesson', 0.4)],
      profile: `profile ${'y'.repeat(500)}`,
    }), 140)
    expect(byteLength(text)).toBeLessThanOrEqual(140)
    expect(text).toContain('Evolution memory budget 140 bytes:')
    expect(text).toContain('omitted 1 lesson artifact')
    expect(text).toContain('truncated profile from')
    expect(text).not.toContain('## Lessons')
    expect(text).not.toContain('## User profile')
  })

  it('renders the notice alone when nothing else fits', () => {
    const text = renderEvolutionBrief(input({
      instructions: 'rules rules rules',
      lessons: [lesson('learned learned', 0.5)],
    }), 120)
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('Evolution memory budget 120 bytes:')
    expect(byteLength(text)).toBeLessThanOrEqual(120)
  })

  it('backs up over UTF-8 continuation bytes', () => {
    const profile = `a😀b${'x'.repeat(300)}`
    const text = renderEvolutionBrief(input({ profile }), 200)
    expect(byteLength(text)).toBeLessThanOrEqual(200)
    expect(() => new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(text, 'utf8'))).not.toThrow()
  })

  it('renders unavailable file items as one line', () => {
    expect(unavailableFileLine('doc', '/work/doc.md')).toBe('Context "doc" is unavailable (/work/doc.md).')
  })
})

describe('evolution brief sections', () => {
  it('emits nothing when every section is empty', () => {
    expect(evolutionBriefSections(input(), 8192)).toEqual([])
  })

  it('names one section per non-empty part, plus a leading Overview', () => {
    const sections = evolutionBriefSections(input({
      instructions: 'follow the guide',
      lessons: [lesson('tabs win', 0.9)],
      profile: 'night owl',
      context: [{ label: 'note', content: 'attached words' }],
    }), 8192)
    expect(sections.map(section => section.name)).toEqual([
      'Overview',
      'Instructions',
      'Lessons',
      'User profile',
      'Context: note',
    ])
    expect(sections[0]?.text).toContain('Memory usage: 10/100 (10%)')
    expect(sections[1]).toEqual({ name: 'Instructions', text: 'follow the guide' })
    expect(sections[2]).toEqual({ name: 'Lessons', text: '- tabs win (confidence: 0.90)' })
    expect(sections[3]).toEqual({ name: 'User profile', text: 'night owl' })
    expect(sections[4]).toEqual({ name: 'Context: note', text: 'attached words' })
    // Section text carries no '##' heading markup: the section name already
    // states what part this is.
    expect(sections[1]?.text).not.toContain('##')
  })

  it('omits sections for empty parts', () => {
    const sections = evolutionBriefSections(input({ lessons: [lesson('only lessons', 0.5)] }), 8192)
    expect(sections.map(section => section.name)).toEqual(['Overview', 'Lessons'])
  })

  it('drops the same trailing context section the text drops under pressure', () => {
    const sections = evolutionBriefSections(input({
      instructions: 'rules',
      context: [
        { label: 'one', content: 'x'.repeat(500) },
        { label: 'two', content: 'y'.repeat(500) },
      ],
    }), 400)
    expect(sections.map(section => section.name)).not.toContain('Context: two')
    expect(sections.some(section => section.name === 'Notice')).toBe(true)
  })

  it('drops the Overview section alongside the header in the notice-only fallback', () => {
    const sections = evolutionBriefSections(input({
      instructions: `rules ${'z'.repeat(500)}`,
      lessons: [lesson(`learned ${'x'.repeat(500)}`, 0.9)],
    }), 30)
    expect(sections).toEqual([])
  })

  it('keeps sections and rendered text mutually consistent under every budget', () => {
    const underTest = input({
      instructions: 'rules rules rules',
      lessons: [lesson('learned learned learned', 0.9)],
      profile: 'likes likes likes',
      context: [
        { label: 'one', content: 'words words words' },
        { label: 'two', content: 'more more more' },
      ],
    })
    for (const maxBytes of [8192, 400, 200, 120, 80, 40, 10]) {
      const text = renderEvolutionBrief(underTest, maxBytes)
      const sections = evolutionBriefSections(underTest, maxBytes)
      for (const section of sections) expect(text).toContain(section.text)
    }
  })
})
