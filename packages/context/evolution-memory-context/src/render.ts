/**
 * Model-facing evolution-memory brief rendering within an explicit byte
 * budget. Pure: file content is materialized by the caller.
 * @module @deepseek-ai/dsh-evolution-memory-context/render
 */

import { truncateUtf8 } from '@deepseek-ai/dsh-evolution-memory'
import type { LessonArtifact } from '@deepseek-ai/dsh-evolution-memory'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'

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
  droppedLessons: number
  profileFrom: number
  profileTo: number
  instructionsFrom: number
  instructionsTo: number
}

/** The framed model-facing text alongside the same-bytes named sections it was assembled from. */
interface ComputedBrief {
  text: string
  sections: ContextSnapshotSection[]
}

/**
 * Render the complete brief including its frame. Empty sections are omitted.
 * Under pressure trailing context items drop first, then the weakest lesson
 * artifacts drop (strongest first, whole artifacts only — a lesson is never
 * truncated mid-statement), then the profile truncates with lessons already
 * gone, then instructions truncate last with lessons and profile already
 * gone. One notice line names every drop and truncation.
 * @param input - scope title, path, usage, documents, and materialized context.
 * @param maxBytes - cap on the complete emitted text including the frame.
 * @returns bounded brief text, or empty string when every section is empty.
 */
export function renderEvolutionBrief(
  input: EvolutionBriefInput,
  maxBytes: number,
): string {
  return computeEvolutionBrief(input, maxBytes).text
}

/**
 * The same brief, kept as the named parts it was assembled from — one entry
 * per non-empty document/context item, in the order {@link renderEvolutionBrief}
 * joins them, plus a leading `Overview` entry for the header line. A consumer
 * that presents the brief (rather than sending it to the model) uses these to
 * show Instructions/Lessons/Profile/Context as distinct parts instead of one
 * undifferentiated block, without re-splitting the joined text.
 * @param input - scope title, path, usage, documents, and materialized context.
 * @param maxBytes - cap on the complete emitted text including the frame.
 * @returns one section per non-empty part actually included in the text, or
 * an empty array when every section is empty.
 */
export function evolutionBriefSections(
  input: EvolutionBriefInput,
  maxBytes: number,
): ContextSnapshotSection[] {
  return computeEvolutionBrief(input, maxBytes).sections
}

/** Shared input shape for {@link renderEvolutionBrief} and {@link evolutionBriefSections}. */
interface EvolutionBriefInput {
  title: string
  path: string
  usage: BriefUsage
  instructions: string
  lessons: readonly LessonArtifact[]
  profile: string
  context: readonly MaterializedContext[]
}

/**
 * Order artifacts strongest-first: confidence descending, ties broken by
 * ascending `id` so equal-confidence artifacts render deterministically.
 * @param artifacts - the scope's artifacts.
 * @returns a new array in strongest-first order.
 */
function orderedLessons(artifacts: readonly LessonArtifact[]): LessonArtifact[] {
  return [...artifacts].sort((left, right) =>
    right.confidence - left.confidence || (left.id < right.id ? -1 : 1))
}

/**
 * Render the lines for the first `kept` artifacts of a strongest-first order.
 * @param ordered - artifacts already in strongest-first order.
 * @param kept - how many leading artifacts to render.
 * @returns the joined lesson lines, or the empty string when none are kept.
 */
function lessonLines(ordered: readonly LessonArtifact[], kept: number): string {
  return ordered.slice(0, kept)
    .map(artifact => `- ${artifact.statement} (confidence: ${artifact.confidence.toFixed(2)})`)
    .join('\n')
}

/**
 * Render lesson artifacts best-first, dropping the lowest-confidence ones
 * until the block fits its byte budget. Artifacts are never truncated
 * mid-statement: when not even one fits, the block is empty rather than a
 * partial line.
 * @param artifacts - the scope's artifacts.
 * @param maxBytes - byte budget for the rendered block.
 * @returns the rendered lines and how many artifacts were dropped.
 */
export function renderLessonLines(
  artifacts: readonly LessonArtifact[],
  maxBytes: number,
): { text: string; dropped: number } {
  const ordered = orderedLessons(artifacts)
  for (let kept = ordered.length; kept > 0; kept -= 1) {
    const text = lessonLines(ordered, kept)
    if (byteLength(text) <= maxBytes) return { text, dropped: ordered.length - kept }
  }
  return { text: '', dropped: ordered.length }
}

function computeEvolutionBrief(input: EvolutionBriefInput, maxBytes: number): ComputedBrief {
  if (input.instructions.length === 0
    && input.lessons.length === 0
    && input.profile.length === 0
    && input.context.length === 0) return { text: '', sections: [] }
  const percent = Math.floor(input.usage.usedBytes * 100 / input.usage.capacityBytes)
  const header = `# Workspace memory: ${input.title}\nDirectory: ${input.path}\nMemory usage: ${input.usage.usedBytes}/${input.usage.capacityBytes} (${percent}%)`
  const ordered = orderedLessons(input.lessons)
  const draft: BriefDraft = {
    instructions: input.instructions,
    lessons: lessonLines(ordered, ordered.length),
    profile: input.profile,
    context: input.context,
    droppedItems: 0,
    droppedLessons: 0,
    profileFrom: byteLength(input.profile),
    profileTo: byteLength(input.profile),
    instructionsFrom: byteLength(input.instructions),
    instructionsTo: byteLength(input.instructions),
  }
  const built = buildBrief(header, draft, maxBytes)
  if (byteLength(built.text) <= maxBytes) return built

  // Drop trailing context items first.
  for (let keep = input.context.length - 1; keep >= 0; keep -= 1) {
    draft.context = input.context.slice(0, keep)
    draft.droppedItems = input.context.length - keep
    const candidate = buildBrief(header, draft, maxBytes)
    if (byteLength(candidate.text) <= maxBytes) return candidate
  }
  draft.context = []
  draft.droppedItems = input.context.length

  // Then drop the weakest lessons — the trailing artifacts in strongest-first
  // order — until the block fits, keeping profile and instructions intact.
  // Reaching `kept = 0` leaves an empty lessons block rather than a truncated
  // one, which is what the brief renders when no artifact fits.
  for (let kept = ordered.length - 1; kept >= 0; kept -= 1) {
    draft.lessons = lessonLines(ordered, kept)
    draft.droppedLessons = ordered.length - kept
    const candidate = buildBrief(header, draft, maxBytes)
    if (byteLength(candidate.text) <= maxBytes) return candidate
  }

  // Then truncate the profile.
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

  // Even the notice alone exceeds the budget: hard-truncate it. The header is
  // not part of this fallback text (buildBrief above already proved it alone
  // does not fit), so no Overview section rides alongside it either.
  const notice = noticeFor(draft, maxBytes)
  const framedFallback = [
    SYSTEM_REMINDER_OPEN,
    escapeFrameBody(notice),
    SYSTEM_REMINDER_CLOSE,
  ].join('\n')
  if (byteLength(framedFallback) <= maxBytes) {
    /* v8 ignore next -- reaching this fallback means some section overflowed, and every
     * overflow path records a drop or a truncation in the notice; all four sections empty
     * returns earlier, so the notice is never empty here. */
    return { text: framedFallback, sections: notice.length > 0 ? [{ name: 'Notice', text: notice }] : [] }
  }
  // Hard-truncated below the notice's own byte length: no section can carry
  // the same bytes as the delivered text, so this falls back to opaque
  // presentation rather than showing a structured section that overstates it.
  return { text: truncateUtf8(framedFallback, maxBytes), sections: [] }
}

/**
 * Assemble one framed brief from the header and the current draft, alongside
 * the same-bytes named sections it was assembled from. The notice line
 * appears only once something was dropped or truncated.
 * @param header - title, directory, and usage lines.
 * @param draft - current field values and budget accounting.
 * @param maxBytes - budget named by the notice.
 * @returns the framed text and its named sections.
 */
function buildBrief(header: string, draft: BriefDraft, maxBytes: number): ComputedBrief {
  const parts: string[] = [header]
  const sections: ContextSnapshotSection[] = [{ name: 'Overview', text: header }]
  if (draft.instructions.length > 0) {
    parts.push(`## Instructions\n${draft.instructions}`)
    sections.push({ name: 'Instructions', text: draft.instructions })
  }
  if (draft.lessons.length > 0) {
    parts.push(`## Lessons\n${draft.lessons}`)
    sections.push({ name: 'Lessons', text: draft.lessons })
  }
  if (draft.profile.length > 0) {
    parts.push(`## User profile\n${draft.profile}`)
    sections.push({ name: 'User profile', text: draft.profile })
  }
  for (const item of draft.context) {
    parts.push(`## Context: ${item.label}\n${item.content}`)
    sections.push({ name: `Context: ${item.label}`, text: item.content })
  }
  const notice = noticeFor(draft, maxBytes)
  if (notice.length > 0) {
    parts.push(notice)
    sections.push({ name: 'Notice', text: notice })
  }
  const body = escapeFrameBody(parts.join('\n\n'))
  return { text: [SYSTEM_REMINDER_OPEN, body, SYSTEM_REMINDER_CLOSE].join('\n'), sections }
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
  if (draft.droppedLessons > 0) {
    clauses.push(`omitted ${draft.droppedLessons} lesson artifact${draft.droppedLessons === 1 ? '' : 's'}`)
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
 * @returns the fitting brief, or undefined when even the empty field overflows.
 */
function truncateField(
  header: string,
  draft: BriefDraft,
  maxBytes: number,
  field: 'profile' | 'instructions',
): ComputedBrief | undefined {
  const full = field === 'profile' ? draft.profile : draft.instructions
  const originalBytes = byteLength(full)
  let low = 0
  let high = originalBytes
  // Captured at the winning trial, not read back off `draft`: the loop keeps
  // probing past a success to find a longer fitting prefix, so `draft` may
  // hold a later, failed candidate by the time the loop exits.
  let best: ComputedBrief | undefined
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = truncateUtf8(full, mid)
    if (field === 'profile') {
      draft.profile = candidate
      draft.profileTo = byteLength(candidate)
    } else {
      draft.instructions = candidate
      draft.instructionsTo = byteLength(candidate)
    }
    const built = buildBrief(header, draft, maxBytes)
    if (byteLength(built.text) <= maxBytes) {
      best = built
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
