/**
 * The working set's text form: one header line, then one labelled block per
 * non-empty role. Rendering is a pure function of the set and the byte bound,
 * and it keeps whole lines only, so a truncated set is always a prefix of the
 * complete one.
 * @module @deepseek-ai/dsh-working-set/render
 */

import type { WorkingSet } from './types.ts'

/** The roles in the order the text lists them, with the label each block carries. */
const ROLES: ReadonlyArray<readonly [keyof WorkingSet, string]> = [
  ['primary', 'primary'],
  ['dependencies', 'dependencies'],
  ['tests', 'tests'],
  ['configs', 'configs'],
  ['docs', 'docs'],
]

/**
 * Render one working set inside a byte bound.
 * @param set - the selected files per role.
 * @param maxBytes - exclusive UTF-8 byte bound on the complete returned text.
 * @returns the working-set text, at most `maxBytes` bytes; empty when no role holds a file, or when not even the header fits.
 */
export function renderWorkingSet(set: WorkingSet, maxBytes: number): string {
  const total = set.primary.length + set.dependencies.length + set.tests.length
    + set.configs.length + set.docs.length
  // An empty selection has nothing to say: a header alone would still spend a
  // model-visible message on a step the index could not match.
  if (total === 0) return ''
  const lines = [`Working set (${String(total)} file${total === 1 ? '' : 's'} the current task is expected to touch, ranked against its objective):`]
  for (const [role, label] of ROLES) {
    const files = set[role]
    if (files.length === 0) continue
    lines.push(`${label} (${String(files.length)}):`)
    for (const path of files) lines.push(`- ${path}`)
  }
  const kept: string[] = []
  let bytes = 0
  for (const line of lines) {
    // Each line after the first costs its text plus the joining newline.
    const size = Buffer.byteLength(line, 'utf8') + (kept.length === 0 ? 0 : 1)
    if (bytes + size > maxBytes) break
    kept.push(line)
    bytes += size
  }
  return kept.join('\n')
}
