/**
 * Model-facing evolution-memory brief rendering within an explicit byte
 * budget. Pure: file content is materialized by the caller.
 * @module @deepseek-ai/dsh-evolution-memory-context/render
 */

import { truncateUtf8 } from '@deepseek-ai/dsh-evolution-memory'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * Escape scope-authored text so it cannot close the plugin-owned frame.
 * @param value - user- or repository-controlled text.
 * @returns text with every literal close tag rewritten.
 */
export function escapeFrameBody(value: string): string {
  return value.replaceAll(SYSTEM_REMINDER_CLOSE, '<\\/system-reminder>')
}

/**
 * UTF-8 byte length of one string.
 * @param value - the string to measure.
 * @returns its UTF-8 byte length.
 */
export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** One materialized context item ready for rendering. */
export interface MaterializedContext {
  label: string
  content: string
}

/** Capacity numbers rendered on the brief header. */
export interface BriefUsage {
  usedBytes: number
  capacityBytes: number
}

/** Mutable draft the budget stages shrink until the brief fits. */
interface BriefDraft {
  instructions: string
  lessons: string
  profile: string
  context: readonly MaterializedContext[]
  droppedItems: number
  lessonsFrom: number
  lessonsTo: number
  profileFrom: number
  profileTo: number
  instructionsFrom: number
  instructionsTo: number
}

/**
 * Render the complete brief including its frame. Empty sections are omitted.
 * Under pressure trailing context items drop first, then lessons truncate,
 * then the profile truncates with lessons already gone, then instructions
 * truncate last with lessons and profile already gone. One notice line names
 * every drop and truncation.
 * @param input - scope title, path, usage, documents, and materialized context.
 * @param maxBytes - cap on the complete emitted text including the frame.
 * @returns bounded brief text, or empty string when every section is empty.
 */
export function renderEvolutionBrief(
  input: {
    title: string
    path: string
    usage: BriefUsage
    instructions: string
    lessons: string
    profile: string
    context: readonly MaterializedContext[]
  },
  maxBytes: number,
): string {
  if (input.instructions.length === 0
    && input.lessons.length === 0
    && input.profile.length === 0
    && input.context.length === 0) return ''
  const percent = Math.floor(input.usage.usedBytes * 100 / input.usage.capacityBytes)
  const header = `# Workspace memory: ${input.title}\nDirectory: ${input.path}\nMemory usage: ${input.usage.usedBytes}/${input.usage.capacityBytes} (${percent}%)`
  const draft: BriefDraft = {
    instructions: input.instructions,
    lessons: input.lessons,
    profile: input.profile,
    context: input.context,
    droppedItems: 0,
    lessonsFrom: byteLength(input.lessons),
    lessonsTo: byteLength(input.lessons),
    profileFrom: byteLength(input.profile),
    profileTo: byteLength(input.profile),
    instructionsFrom: byteLength(input.instructions),
    instructionsTo: byteLength(input.instructions),
  }
  const framed = buildBrief(header, draft, maxBytes)
  if (byteLength(framed) <= maxBytes) return framed

  // Drop trailing context items first.
  for (let keep = input.context.length - 1; keep >= 0; keep -= 1) {
    draft.context = input.context.slice(0, keep)
    draft.droppedItems = input.context.length - keep
    const text = buildBrief(header, draft, maxBytes)
    if (byteLength(text) <= maxBytes) return text
  }
  draft.context = []
  draft.droppedItems = input.context.length

  // Then truncate lessons, keeping profile and instructions intact.
  if (input.lessons.length > 0) {
    const truncated = truncateField(header, draft, maxBytes, 'lessons')
    if (truncated !== undefined) return truncated
  }

  // Then drop lessons and truncate the profile.
  draft.lessons = ''
  draft.lessonsTo = 0
  if (input.profile.length > 0) {
    const truncated = truncateField(header, draft, maxBytes, 'profile')
    if (truncated !== undefined) return truncated
  }

  // Then drop the profile and truncate instructions last.
  draft.profile = ''
  draft.profileTo = 0
  if (input.instructions.length > 0) {
    const truncated = truncateField(header, draft, maxBytes, 'instructions')
    if (truncated !== undefined) return truncated
  }

  // Even the notice alone exceeds the budget: hard-truncate it.
  const framedFallback = [
    SYSTEM_REMINDER_OPEN,
    escapeFrameBody(noticeFor(draft, maxBytes)),
    SYSTEM_REMINDER_CLOSE,
  ].join('\n')
  if (byteLength(framedFallback) <= maxBytes) return framedFallback
  return truncateUtf8(framedFallback, maxBytes)
}

/**
 * Assemble one framed brief from the header and the current draft. The
 * notice line appears only once something was dropped or truncated.
 * @param header - title, directory, and usage lines.
 * @param draft - current field values and budget accounting.
 * @param maxBytes - budget named by the notice.
 * @returns the framed text.
 */
function buildBrief(header: string, draft: BriefDraft, maxBytes: number): string {
  const parts: string[] = [header]
  if (draft.instructions.length > 0) parts.push(`## Instructions\n${draft.instructions}`)
  if (draft.lessons.length > 0) parts.push(`## Lessons\n${draft.lessons}`)
  if (draft.profile.length > 0) parts.push(`## User profile\n${draft.profile}`)
  for (const item of draft.context) parts.push(`## Context: ${item.label}\n${item.content}`)
  const notice = noticeFor(draft, maxBytes)
  if (notice.length > 0) parts.push(notice)
  const body = escapeFrameBody(parts.join('\n\n'))
  return [SYSTEM_REMINDER_OPEN, body, SYSTEM_REMINDER_CLOSE].join('\n')
}

/**
 * Render the single notice line naming every drop and truncation so far.
 * @param draft - current budget accounting.
 * @param maxBytes - budget named by the notice.
 * @returns the notice line, or empty string when nothing was cut.
 */
function noticeFor(draft: BriefDraft, maxBytes: number): string {
  const clauses: string[] = []
  if (draft.droppedItems > 0) {
    clauses.push(`omitted ${draft.droppedItems} context item${draft.droppedItems === 1 ? '' : 's'}`)
  }
  if (draft.lessonsTo < draft.lessonsFrom) {
    clauses.push(`truncated lessons from ${draft.lessonsFrom} to ${draft.lessonsTo} bytes`)
  }
  if (draft.profileTo < draft.profileFrom) {
    clauses.push(`truncated profile from ${draft.profileFrom} to ${draft.profileTo} bytes`)
  }
  if (draft.instructionsTo < draft.instructionsFrom) {
    clauses.push(`truncated instructions from ${draft.instructionsFrom} to ${draft.instructionsTo} bytes`)
  }
  if (clauses.length === 0) return ''
  return `Evolution memory budget ${maxBytes} bytes: ${clauses.join('; ')}.`
}

/**
 * Binary-search the longest prefix of one draft field that fits the budget.
 * @param header - title, directory, and usage lines.
 * @param draft - draft mutated in place to the winning prefix.
 * @param maxBytes - cap on the complete brief.
 * @param field - which draft field to shrink.
 * @returns fitting brief text, or undefined when even the empty field overflows.
 */
function truncateField(
  header: string,
  draft: BriefDraft,
  maxBytes: number,
  field: 'lessons' | 'profile' | 'instructions',
): string | undefined {
  const full = field === 'lessons' ? draft.lessons : field === 'profile' ? draft.profile : draft.instructions
  const originalBytes = byteLength(full)
  let low = 0
  let high = originalBytes
  let best: string | undefined
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = truncateUtf8(full, mid)
    if (field === 'lessons') {
      draft.lessons = candidate
      draft.lessonsTo = byteLength(candidate)
    } else if (field === 'profile') {
      draft.profile = candidate
      draft.profileTo = byteLength(candidate)
    } else {
      draft.instructions = candidate
      draft.instructionsTo = byteLength(candidate)
    }
    const text = buildBrief(header, draft, maxBytes)
    if (byteLength(text) <= maxBytes) {
      best = text
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

/**
 * Render one unavailable file item as a single line; the step proceeds.
 * @param label - item label.
 * @param path - item path.
 * @returns the degradation line.
 */
export function unavailableFileLine(label: string, path: string): string {
  return `Context "${label}" is unavailable (${path}).`
}
