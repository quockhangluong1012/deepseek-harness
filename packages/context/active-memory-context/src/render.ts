/**
 * Model-facing active-memory brief rendering within an explicit byte budget.
 * Pure: no service access, no I/O.
 * @module @deepseek-ai/dsh-active-memory-context/render
 */

import type { SemanticSessionSearchHit } from '@deepseek-ai/dsh-session-query'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * Escape hit-authored text so it cannot close the plugin-owned frame. Past
 * session content is not repository-controlled, so this mirrors the same
 * defense `dsh-evolution-memory-context` applies to its own frame.
 * @param value - text drawn from a past session's snippet.
 * @returns text with every literal close tag rewritten.
 */
export function escapeFrameBody(value: string): string {
  return value.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

/**
 * Render hits best-first, one numbered line per hit, dropping the weakest
 * (trailing) hits until the framed text fits `maxBytes`. Hits already come
 * back score-descending from the search call, so trailing is always weakest.
 * @param hits - relevance-filtered semantic hits, best match first.
 * @param maxBytes - cap on the complete emitted text including the frame.
 * @returns the framed brief, or undefined when not even one hit fits.
 */
export function renderActiveMemoryBrief(
  hits: readonly SemanticSessionSearchHit[],
  maxBytes: number,
): string | undefined {
  for (let kept = hits.length; kept > 0; kept -= 1) {
    const candidate = buildText(hits.slice(0, kept))
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) return candidate
  }
  return undefined
}

function buildText(hits: readonly SemanticSessionSearchHit[]): string {
  const lines = hits.map((hit, index) => {
    const when = new Date(hit.bestMatch.time).toISOString()
    const similarity = hit.score.toFixed(2)
    return `${index + 1}. [session ${hit.header.id} @ ${when}, similarity ${similarity}] ${escapeFrameBody(hit.bestMatch.snippet)}`
  })
  return [
    SYSTEM_REMINDER_OPEN,
    'Relevant memory found in earlier sessions in this scope:',
    ...lines,
    SYSTEM_REMINDER_CLOSE,
  ].join('\n')
}
