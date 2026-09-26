/**
 * Literal matching and line-ending handling shared by the batch mutators.
 *
 * `ctx.fs` owns literal matching only inside the provider's `editText` critical
 * section, so a call that must resolve every edit before writing any of them
 * matches on this side. The rules are `dsh-fs-local`'s `applyLiteralEdit`:
 * both literals and the content are LF-normalized, an empty search never
 * matches, and a multi-match without `replaceAll` is ambiguous rather than a
 * repeated replace. This module owns the match only; each tool owns its
 * model-facing failure text.
 * @module @deepseek-ai/dsh-tool-fs/src/literal-edit
 */

/** A file's line-ending style, detected before LF normalization. */
export type LineEndings = 'LF' | 'CRLF'

/** Verdict of matching one literal replacement against LF-normalized content. */
export type LiteralEditMatch =
  | { readonly kind: 'applied'; readonly content: string; readonly replacements: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous'; readonly replacements: number }

/**
 * Collapse CRLF to LF — the canonical in-memory form matching and the diff
 * basis share, so a CRLF file's unchanged lines never read as changed.
 * @param content - text in any line-ending style.
 * @returns the same text with every CRLF pair collapsed to LF.
 */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/**
 * Detect a text's dominant line-ending style.
 * @param content - raw file text.
 * @returns `CRLF` when CRLF pairs outnumber bare LF, else `LF` (including text with neither).
 */
export function detectLineEndings(content: string): LineEndings {
  const crlf = countOccurrences(content, '\r\n')
  return crlf > countOccurrences(content, '\n') - crlf ? 'CRLF' : 'LF'
}

/**
 * Convert LF-normalized content back to a detected style for write-back.
 * @param content - LF-normalized text.
 * @param lineEndings - the style {@link detectLineEndings} reported for the original text.
 * @returns `content` unchanged for `LF`; otherwise CRLF text, re-normalized first so an existing pair is never doubled.
 */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/** Count non-overlapping occurrences of `needle` in `content`. */
function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Match one literal replacement without touching the filesystem. Both literals
 * are LF-normalized before matching, so a CRLF spelled in the arguments still
 * matches LF-normalized content.
 * @param content - the current content, already LF-normalized.
 * @param oldString - the literal text to find; an empty value reports `missing`.
 * @param newString - the literal replacement.
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @returns the applied content, or the missing/ambiguous verdict with its match count.
 */
export function matchLiteralEdit(content: string, oldString: string, newString: string, replaceAll: boolean): LiteralEditMatch {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) return { kind: 'missing' }
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) return { kind: 'missing' }
  if (!replaceAll && replacements > 1) return { kind: 'ambiguous', replacements }
  return { kind: 'applied', content: content.split(oldNorm).join(normalizeLineEndings(newString)), replacements }
}
