/**
 * Extraction prompt framing for evolution lessons. The model returns only the
 * replacement lessons document under fixed headings.
 * @module @deepseek-ai/dsh-evolution-reviewer/prompt
 */

import { truncateUtf8 } from '@deepseek-ai/dsh-evolution-memory'

/**
 * Fixed headings the replacement lessons document must use. The evolution
 * reviewer is a fork of the workspace-memory extractor, and this copy of its
 * `MEMORY_HEADINGS` keeps the two documents independently versioned while
 * both prompts and specs pin the same four headings.
 */
export const LESSON_HEADINGS = ['## Purpose', '## Preferences', '## Decisions', '## References'] as const

/**
 * Build the system prompt for one lessons-extraction call.
 * @returns deterministic instruction text forbidding derived, secret, and sensitive content.
 */
export function extractionSystemPrompt(): string {
  return [
    'You distill durable lessons for an agent scope from one turn of conversation.',
    'Emit ONLY the complete replacement lessons document, keeping exactly these headings in order:',
    ...LESSON_HEADINGS,
    '',
    'Guidance:',
    '- Keep project purpose, user preferences, decisions taken, and stable references that future turns can reuse.',
    '- Leave out anything readable from the code or the scope instructions themselves.',
    '- Leave out credentials, tokens, keys, secrets, and health, race, religion, political, or gender-identity data.',
    '- Remove entries the new transcript contradicts; stay concise.',
    '- With nothing worth keeping, emit the four headings with empty sections.',
  ].join('\n')
}

/**
 * Frame transcript rows as JSON so conversation text cannot break delimiters.
 * @param rows - role/text rows in chronological order.
 * @param currentLessons - current lessons document, possibly empty.
 * @returns the user prompt text.
 */
export function frameExtractionInput(rows: readonly { role: string; text: string }[], currentLessons: string): string {
  return [
    `<current-lessons>${currentLessons}</current-lessons>`,
    `Rewrite the lessons from this JSON transcript:\n${JSON.stringify(rows)}`,
  ].join('\n')
}

/**
 * Clip text to a UTF-8 budget at a character boundary, so the result is
 * always valid UTF-8 without a trailing replacement character.
 * @param value - the string to clip.
 * @param maxBytes - maximum UTF-8 bytes to retain.
 * @returns the longest leading-characters prefix within budget.
 */
export function clipToBytes(value: string, maxBytes: number): string {
  return truncateUtf8(value, maxBytes)
}
