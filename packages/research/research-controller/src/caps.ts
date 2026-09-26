/**
 * Configured caps on the text a caller hands the research controller. Every
 * cap is a validated `Config` field; an over-cap field is refused with the
 * field name, its measured size, and the cap, before anything is recorded.
 * @module @deepseek-ai/dsh-research-controller/src/caps
 */

import { ResearchError } from './errors.ts'

/**
 * Refuse one text field over its configured UTF-8 byte cap.
 * @param field - field name as the caller and the model see it.
 * @param text - the supplied text.
 * @param maxBytes - the configured cap.
 * @throws ResearchError `stage-input-invalid` naming the field and both sizes.
 */
export function assertBytesWithin(field: string, text: string, maxBytes: number): void {
  const bytes = new TextEncoder().encode(text).length
  if (bytes > maxBytes) {
    throw new ResearchError(
      'stage-input-invalid',
      `research: ${field} is ${String(bytes)} bytes, over the configured ${String(maxBytes)}-byte cap`,
    )
  }
}

/**
 * Refuse one list over its configured item cap.
 * @param field - field name as the caller and the model see it.
 * @param count - number of items supplied.
 * @param maxItems - the configured cap.
 * @throws ResearchError `stage-input-invalid` naming the field and both counts.
 */
export function assertCountWithin(field: string, count: number, maxItems: number): void {
  if (count > maxItems) {
    throw new ResearchError(
      'stage-input-invalid',
      `research: ${field} holds ${String(count)} items, over the configured cap of ${String(maxItems)}`,
    )
  }
}

/**
 * Refuse one field a caller left empty.
 * @param field - field name as the caller and the model see it.
 * @param value - the text supplied.
 * @throws ResearchError `stage-input-invalid` naming the field.
 */
export function assertNotBlank(field: string, value: string): void {
  if (value.trim().length === 0) {
    throw new ResearchError('stage-input-invalid', `research: ${field} is empty`)
  }
}
