/** Pure model-facing rendering for the recorded per-turn change tools. */
import type { TurnChangesFile, TurnChangesValue, TurnDiffValue } from './types.ts'

/** `(+added -deleted)` for one file or one turn. */
function counts(added: number, deleted: number): string {
  return `(+${added} -${deleted})`
}

/** One listed file's line: its label, its counts, and why a refused comparison has none. */
function fileLine(file: TurnChangesFile): string {
  const refusal = file.binary === true
    ? ' [binary]'
    : file.oversized === true ? ' [over the size cap]' : ''
  return `  ${file.display} ${counts(file.added, file.deleted)}${refusal}`
}

/**
 * Render one recorded turn's changed-file summary.
 * @param value - the canonical `turn_changes` value.
 * @returns the model-facing text block body.
 */
export function renderSummary(value: TurnChangesValue): string {
  const header = `Turn ${value.turn} changed ${value.total} ${value.total === 1 ? 'file' : 'files'} `
    + `${counts(value.added, value.deleted)} under ${value.cwd}`
  if (value.total === 0) return `${header}.`
  const omitted = value.total - value.files.length
  return [
    `${header}:`,
    ...value.files.map(fileLine),
    ...omitted > 0 ? [`  (listing the first ${value.files.length} of ${value.total})`] : [],
    `Read one file's diff with turn_diff (turn ${value.turn}, path as listed).`,
  ].join('\n')
}

/**
 * Render one listed file's recorded comparison.
 * @param value - the canonical `turn_diff` value.
 * @returns the model-facing text block body.
 */
export function renderDiff(value: TurnDiffValue): string {
  const label = `Turn ${value.turn}, ${value.display}`
  if (value.kind === 'binary') return `${label}: binary content, no line comparison.`
  if (value.kind === 'oversized') return `${label}: over the comparison size cap, no line comparison.`
  const existence = value.before ? value.after ? '' : ' (deleted)'
    : ' (created)'
  const degraded = value.coarse ? ' [comparison timed out; every line shown as replaced]' : ''
  if (value.hunks.length === 0) return `${label}${existence}${degraded}: no line differences.`
  const body = value.hunks.flatMap(hunk => [
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    ...hunk.lines,
  ])
  return [`${label}${existence}${degraded}`, ...body].join('\n')
}
