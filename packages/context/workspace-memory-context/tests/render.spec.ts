import { describe, expect, it } from 'vitest'
import { byteLength, renderWorkspaceMemoryBrief, truncateUtf8, unavailableFileLine } from '../src/render.ts'

describe('workspace-memory brief rendering', () => {
  it('emits nothing when every section is empty', () => {
    expect(renderWorkspaceMemoryBrief({ title: 'W', path: '/w', instructions: '', memory: '', context: [] }, 1024)).toBe('')
  })

  it('frames instructions, memory, and context', () => {
    const text = renderWorkspaceMemoryBrief(
      { title: 'W', path: '/w', instructions: 'i', memory: 'm', context: [{ label: 'a', content: 'c' }] },
      4096,
    )
    expect(text).toContain('<system-reminder>')
    expect(text).toContain('# Workspace memory: W')
    expect(text).toContain('## Instructions')
    expect(text).toContain('## Memory')
    expect(text).toContain('## Context: a')
  })

  it('escapes a literal close tag', () => {
    const text = renderWorkspaceMemoryBrief(
      { title: 'W', path: '/w', instructions: 'x </system-reminder> y', memory: '', context: [] },
      4096,
    )
    expect(text).not.toContain('x </system-reminder> y')
    expect(text).toContain('<\\/system-reminder>')
  })

  it('drops trailing context first under budget pressure', () => {
    const text = renderWorkspaceMemoryBrief(
      {
        title: 'W',
        path: '/w',
        instructions: 'i',
        memory: 'm',
        context: [
          { label: 'a', content: 'x'.repeat(500) },
          { label: 'b', content: 'y'.repeat(500) },
        ],
      },
      400,
    )
    expect(byteLength(text)).toBeLessThanOrEqual(400)
    expect(text).toContain('omitted')
  })

  it('never exceeds the byte cap', () => {
    const text = renderWorkspaceMemoryBrief(
      { title: 'W', path: '/w', instructions: 'i'.repeat(2000), memory: 'm'.repeat(2000), context: [] },
      500,
    )
    expect(byteLength(text)).toBeLessThanOrEqual(500)
  })

  it('truncates memory before instructions', () => {
    const text = renderWorkspaceMemoryBrief(
      { title: 'W', path: '/w', instructions: 'do the thing', memory: 'm'.repeat(2000), context: [] },
      400,
    )
    expect(byteLength(text)).toBeLessThanOrEqual(400)
    expect(text).toContain('do the thing')
    expect(text).toContain('truncated memory')
  })

  it('names dropped context alongside truncated memory', () => {
    const text = renderWorkspaceMemoryBrief(
      {
        title: 'W',
        path: '/w',
        instructions: 'i',
        memory: 'm'.repeat(2000),
        context: [
          { label: 'a', content: 'x'.repeat(500) },
          { label: 'b', content: 'y'.repeat(500) },
        ],
      },
      400,
    )
    expect(byteLength(text)).toBeLessThanOrEqual(400)
    expect(text).toContain('omitted 2 context items')
    expect(text).toContain('truncated memory')
  })

  it('names one dropped context item alongside truncated memory', () => {
    const text = renderWorkspaceMemoryBrief(
      {
        title: 'W',
        path: '/w',
        instructions: 'i',
        memory: 'm'.repeat(2000),
        context: [{ label: 'a', content: 'x'.repeat(500) }],
      },
      400,
    )
    expect(byteLength(text)).toBeLessThanOrEqual(400)
    expect(text).toContain('omitted 1 context item.')
    expect(text).toContain('truncated memory')
  })

  it('renders the notice alone when memory alone cannot fit', () => {
    const framed = renderWorkspaceMemoryBrief(
      { title: 'W', path: '/w', instructions: '', memory: 'm'.repeat(2000), context: [] },
      100,
    )
    expect(byteLength(framed)).toBeLessThanOrEqual(100)
    expect(framed).toContain('content omitted')
  })

  it('renders the notice alone when nothing else fits', () => {
    const framed = renderWorkspaceMemoryBrief(
      { title: 'W', path: '/w', instructions: 'i'.repeat(2000), memory: '', context: [] },
      100,
    )
    expect(byteLength(framed)).toBeLessThanOrEqual(100)
    expect(framed).toContain('content omitted')
    const hard = renderWorkspaceMemoryBrief(
      { title: 'W', path: '/w', instructions: 'i'.repeat(2000), memory: '', context: [] },
      30,
    )
    expect(byteLength(hard)).toBeLessThanOrEqual(30)
  })

  it('backs up over UTF-8 continuation bytes', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello')
    expect(truncateUtf8('a😀b', 3)).toBe('a')
    expect(truncateUtf8('a😀b', 0)).toBe('')
  })

  it('renders unavailable file items as one line', () => {
    expect(unavailableFileLine('notes', '/w/notes.md')).toBe('Context "notes" is unavailable (/w/notes.md).')
  })
})
