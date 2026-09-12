/**
 * Lean squeeze: the pure reduction applied between extractor output and the
 * store write. The extracted document keeps only the memory headings their
 * prompt fixed; when it still exceeds the byte budget, heading bodies are
 * cleared one at a time in the configured pressure order, and the last
 * remaining body is clipped at a UTF-8 boundary.
 * @module @deepseek-ai/dsh-evolution-reviewer/squeeze
 */

import { truncateUtf8, utf8Bytes } from '@deepseek-ai/dsh-evolution-memory'
import { LESSON_HEADINGS } from './prompt.ts'

/**
 * Pressure order applied when a document exceeds its budget: the first
 * heading listed is the first whose body is cleared.
 */
export const DEFAULT_SQUEEZE_ORDER: readonly string[] = [...LESSON_HEADINGS].reverse()

/** One heading and the document lines collected under it. */
interface MemorySection {
  heading: string
  lines: string[]
}

/** A markdown heading line that is not one of the recognized memory headings. */
const MARKDOWN_HEADING = /^#{1,6}\s/u

/** Outcome of one squeeze: the reduced document and whether material was lost. */
export interface SqueezedDocument {
  /** The document to store. */
  text: string
  /** Whether material left the document: prose, a shed body, or a clipped body. */
  truncated: boolean
}

/**
 * Collect the recognized heading sections of one document, in document order.
 * Text before the first heading and lines under an unrecognized heading are
 * dropped and reported as ignored.
 * @param text - raw extractor output.
 * @param headings - headings the squeeze keeps.
 * @returns the collected sections and whether non-heading material was dropped.
 */
function collectSections(text: string, headings: ReadonlySet<string>): { sections: MemorySection[]; ignored: boolean } {
  const sections: MemorySection[] = []
  let ignored = false
  let current: MemorySection | undefined
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (headings.has(trimmed)) {
      current = sections.find(section => section.heading === trimmed)
      if (current === undefined) {
        current = { heading: trimmed, lines: [] }
        sections.push(current)
      }
      continue
    }
    // Any other markdown heading ends the section it followed; its body is
    // not memory material.
    if (MARKDOWN_HEADING.test(trimmed)) {
      current = undefined
      ignored = true
      continue
    }
    if (current === undefined) {
      if (trimmed.length > 0) ignored = true
      continue
    }
    current.lines.push(line)
  }
  for (const section of sections) trimBlankEdges(section.lines)
  return { sections, ignored }
}

/**
 * Drop blank lines at both ends of one section body in place.
 * @param lines - the section's collected lines.
 */
function trimBlankEdges(lines: string[]): void {
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop()
}

/**
 * Report whether one heading still carries a body.
 * @param sections - collected sections.
 * @param heading - heading to look up.
 * @returns whether that section exists with at least one retained line.
 */
function hasBody(sections: readonly MemorySection[], heading: string): boolean {
  const section = sections.find(candidate => candidate.heading === heading)
  return section !== undefined && section.lines.length > 0
}

/**
 * Render the kept sections, each as its heading followed by its remaining
 * body.
 * @param sections - sections in document order.
 * @returns the reduced document.
 */
function renderSections(sections: readonly MemorySection[]): string {
  return sections
    .map(section => section.lines.length === 0 ? section.heading : `${section.heading}\n${section.lines.join('\n')}`)
    .join('\n')
}

/**
 * Reduce one extracted document to the memory headings under a byte budget.
 *
 * Bodies are cleared whole in pressure order; the last body still standing
 * when the budget is reached is clipped at a UTF-8 boundary instead, so the
 * result fits whenever the headings themselves do. Headings are never
 * removed, and output carrying no recognized heading at all is returned
 * unchanged: a malformed response must not silently erase the document.
 * @param text - raw extractor output.
 * @param maxBytes - UTF-8 byte budget the result should fit.
 * @param order - pressure order: the heading whose body clears first comes first.
 * @returns the reduced document and whether material was lost.
 */
export function squeezeLessons(text: string, maxBytes: number, order: readonly string[]): SqueezedDocument {
  const collected = collectSections(text, new Set(order))
  if (collected.sections.length === 0) return { text, truncated: false }
  const { sections } = collected
  let lost = collected.ignored
  let rendered = renderSections(sections)
  for (const [index, heading] of order.entries()) {
    if (utf8Bytes(rendered) <= maxBytes) return { text: rendered, truncated: lost }
    const section = sections.find(candidate => candidate.heading === heading)
    if (section === undefined || section.lines.length === 0) continue
    if (order.slice(index + 1).some(next => hasBody(sections, next))) {
      section.lines.length = 0
      lost = true
      rendered = renderSections(sections)
      continue
    }
    // Nothing less important is left to shed, so this body is clipped at a
    // UTF-8 boundary into the budget the headings leave.
    const kept = section.lines.join('\n')
    section.lines.length = 0
    const room = maxBytes - utf8Bytes(renderSections(sections)) - 1
    const clipped = truncateUtf8(kept, room)
    section.lines = clipped.length === 0 ? [] : clipped.split('\n')
    return { text: renderSections(sections), truncated: true }
  }
  return { text: rendered, truncated: lost }
}
