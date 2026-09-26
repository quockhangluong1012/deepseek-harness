/** Line comparison of two whole-file texts, bounded by a timeout that degrades to whole-file replacement. */
import { structuredPatch } from 'diff'
import type { WorkspaceDiffHunk, WorkspaceHunkDecision } from './types.ts'

/** Context lines around each change, the unified-diff default. */
const CONTEXT_LINES = 3

/** Hunks, whether the timeout degraded them, and the changed-line totals they carry. */
export interface Comparison {
  hunks: WorkspaceDiffHunk[]
  coarse: boolean
  added: number
  deleted: number
}

/**
 * A side's text with every line terminated, so the last line compares by
 * content alone and empty text reads as no lines rather than one empty line.
 */
function terminated(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`
}

/** Content lines of a terminated text; empty text is zero lines. */
function lines(text: string): string[] {
  return text === '' ? [] : text.slice(0, -1).split('\n')
}

/**
 * Compare two texts line by line. A side that is null means the file did not
 * exist. A comparison exceeding `timeoutMs` yields one hunk that deletes every
 * old line and adds every new line.
 * @param before - turn-start text, or null.
 * @param after - turn-end text, or null.
 * @param timeoutMs - milliseconds the line comparison may run.
 * @returns hunks and totals; no hunks when both sides hold the same lines.
 */
export function compareText(before: string | null, after: string | null, timeoutMs: number): Comparison {
  const oldText = terminated(before ?? '')
  const newText = terminated(after ?? '')
  const patch = structuredPatch('', '', oldText, newText, undefined, undefined, { context: CONTEXT_LINES, timeout: timeoutMs })
  let hunks: WorkspaceDiffHunk[]
  let coarse = false
  if (patch === undefined) {
    coarse = true
    const oldLines = lines(oldText)
    const newLines = lines(newText)
    hunks = [{
      oldStart: 1, oldLines: oldLines.length,
      newStart: 1, newLines: newLines.length,
      lines: [...oldLines.map(line => `-${line}`), ...newLines.map(line => `+${line}`)],
    }]
  } else {
    hunks = patch.hunks.map(({ oldStart, oldLines, newStart, newLines, lines: body }) =>
      ({ oldStart, oldLines, newStart, newLines, lines: body }))
  }
  let added = 0
  let deleted = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) deleted += 1
    }
  }
  return { hunks, coarse, added, deleted }
}

/** One file's content after per-hunk decisions. */
export interface DecidedFile {
  /**
   * Whether the file exists after the decisions: absent when the file did not exist before and no
   * hunk is accepted, or when it did not exist after and every hunk is accepted.
   */
  exists: boolean
  /** The resulting content, one line each plus the final newline of the side the last line came from; ignored when `exists` is false. */
  content: string
}

/**
 * Apply one decision per hunk to a whole-file comparison: an accepted hunk
 * contributes its turn-end lines in place of its turn-start ones, a rejected
 * hunk keeps its turn-start lines, and every line no hunk covers survives
 * unchanged. A file that did not exist before exists only while some hunk is
 * accepted; a file that does not exist after exists only while some hunk is
 * rejected.
 * @param before - turn-start text, or null when the file did not exist.
 * @param after - turn-end text, or null when the file does not exist after the turn.
 * @param hunks - the hunks of `compareText(before, after, …)`, in file order.
 * @param decisions - one decision per hunk, in the same order.
 * @returns the resulting existence and content.
 * @throws when `decisions` does not hold exactly one decision per hunk.
 */
export function decidedText(
  before: string | null, after: string | null,
  hunks: readonly WorkspaceDiffHunk[], decisions: readonly WorkspaceHunkDecision[],
): DecidedFile {
  if (decisions.length !== hunks.length) {
    throw new Error(`workspace-changes: ${hunks.length} hunks need exactly ${hunks.length} decisions, got ${decisions.length}`)
  }
  const oldLines = lines(terminated(before ?? ''))
  const content: string[] = []
  let last: string | null = before
  let at = 0
  const keepOld = (until: number): void => {
    for (; at < until; at += 1) {
      content.push(oldLines[at] as string)
      last = before
    }
  }
  hunks.forEach((hunk, position) => {
    const start = hunk.oldStart - 1
    keepOld(start)
    if (decisions[position] === 'accept') {
      for (const line of hunk.lines) {
        if (line.startsWith('-')) continue
        content.push(line.slice(1))
        last = after
      }
    } else keepOld(start + hunk.oldLines)
    at = start + hunk.oldLines
  })
  keepOld(oldLines.length)
  const accepted = decisions.filter(decision => decision === 'accept').length
  const exists = hunks.length === 0 ? after !== null
    : before === null ? accepted > 0
      : after === null ? accepted < hunks.length
        : true
  return { exists, content: content.length === 0 ? '' : `${content.join('\n')}${last !== null && last.endsWith('\n') ? '\n' : ''}` }
}
