/**
 * Model-facing workspace-memory brief rendering within an explicit byte
 * budget. Pure: file content is materialized by the caller.
 * @module @deepseek-ai/dsh-workspace-memory-context/render
 */

import type { WorkspaceContextItem } from '@deepseek-ai/dsh-workspace-memory/types'

const SYSTEM_REMINDER_OPEN = '<system-reminder>'
const SYSTEM_REMINDER_CLOSE = '</system-reminder>'

/**
 * Escape workspace-authored text so it cannot close the plugin-owned frame.
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

/**
 * Truncate to a UTF-8 boundary, backing up over continuation bytes.
 * @param value - the string to truncate.
 * @param maxBytes - maximum UTF-8 bytes to retain.
 * @returns the truncated prefix.
 */
export function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (bytes.readUInt8(end) & 0xc0) === 0x80) {
    end -= 1
  }
  return bytes.subarray(0, end).toString('utf8')
}

/** One materialized context item ready for rendering. */
export interface MaterializedContext {
  label: string
  content: string
}

/**
 * Render the complete brief including its frame. Empty sections are omitted.
 * Under pressure trailing context items drop first, then memory truncates,
 * then instructions truncate last. A notice line names what was dropped or
 * truncated.
 * @param input - workspace title, instructions, memory, and materialized context.
 * @param maxBytes - cap on the complete emitted text including the frame.
 * @returns bounded brief text, or empty string when every section is empty.
 */
export function renderWorkspaceMemoryBrief(
  input: {
    title: string
    path: string
    instructions: string
    memory: string
    context: readonly MaterializedContext[]
  },
  maxBytes: number,
): string {
  const hasInstructions = input.instructions.length > 0
  const hasMemory = input.memory.length > 0
  const hasContext = input.context.length > 0
  if (!hasInstructions && !hasMemory && !hasContext) return ''

  const header = `# Workspace memory: ${input.title}\nDirectory: ${input.path}`
  const build = (
    instructions: string,
    memory: string,
    context: readonly MaterializedContext[],
    notice: string,
  ): string => {
    const parts: string[] = [header]
    if (instructions.length > 0) parts.push(`## Instructions\n${instructions}`)
    if (memory.length > 0) parts.push(`## Memory\n${memory}`)
    for (const item of context) parts.push(`## Context: ${item.label}\n${item.content}`)
    if (notice.length > 0) parts.push(notice)
    const body = escapeFrameBody(parts.join('\n\n'))
    return [SYSTEM_REMINDER_OPEN, body, SYSTEM_REMINDER_CLOSE].join('\n')
  }

  const full = build(input.instructions, input.memory, input.context, '')
  if (byteLength(full) <= maxBytes) return full

  // Drop trailing context items first.
  for (let keep = input.context.length - 1; keep >= 0; keep -= 1) {
    const kept = input.context.slice(0, keep)
    const dropped = input.context.length - kept.length
    const notice = `Workspace memory budget ${maxBytes} bytes: omitted ${dropped} context item${dropped === 1 ? '' : 's'}.`
    const text = build(input.instructions, input.memory, kept, notice)
    if (byteLength(text) <= maxBytes) return text
  }
  const contextGone = input.context.length > 0
    ? `Workspace memory budget ${maxBytes} bytes: omitted ${input.context.length} context item${input.context.length === 1 ? '' : 's'}.`
    : ''

  // Then truncate memory, keeping instructions intact.
  if (hasMemory) {
    const truncated = truncateToFit(
      input.memory,
      (memory, notice) => build(input.instructions, memory, [], combineNotice(contextGone, notice)),
      maxBytes,
      'memory',
      maxBytes,
    )
    if (truncated !== undefined) return truncated
  }

  // Then truncate instructions last.
  if (hasInstructions) {
    const truncated = truncateToFit(
      input.instructions,
      (instructions, notice) => build(instructions, '', [], combineNotice(contextGone, notice)),
      maxBytes,
      'instructions',
      maxBytes,
    )
    if (truncated !== undefined) return truncated
  }

  // Even the notice alone exceeds the budget: hard-truncate it.
  const fallback = combineNotice(contextGone, `Workspace memory budget ${maxBytes} bytes: content omitted.`)
  const framed = [SYSTEM_REMINDER_OPEN, escapeFrameBody(fallback), SYSTEM_REMINDER_CLOSE].join('\n')
  if (byteLength(framed) <= maxBytes) return framed
  return truncateUtf8(framed, maxBytes)
}

function combineNotice(first: string, second: string): string {
  if (first.length === 0) return second
  return `${first} ${second}`
}

function truncateToFit(
  value: string,
  render: (truncated: string, notice: string) => string,
  maxBytes: number,
  field: string,
  budget: number,
): string | undefined {
  const originalBytes = byteLength(value)
  let low = 0
  let high = originalBytes
  let best: string | undefined
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = truncateUtf8(value, mid)
    const includedBytes = byteLength(candidate)
    const notice = `Workspace memory budget ${budget} bytes: truncated ${field} from ${originalBytes} to ${includedBytes} bytes.`
    const text = render(candidate, notice)
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

export type { WorkspaceContextItem }
