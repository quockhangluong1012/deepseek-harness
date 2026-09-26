/**
 * The repository map's text form: one header line and one line per ranked
 * symbol, with its related symbols beneath it. Rendering is a pure function of
 * the ranked nodes and the byte bound, and it keeps whole lines only, so a
 * truncated map is always a prefix of the complete one.
 * @module @deepseek-ai/dsh-repo-map/render
 */

import type { RepoMapCounts, RepoMapNode } from './types.ts'

/**
 * Render one ranked map inside a byte bound.
 * @param nodes - the ranked nodes, best first.
 * @param counts - the index totals the header states.
 * @param maxBytes - exclusive UTF-8 byte bound on the complete returned text.
 * @returns the map text, at most `maxBytes` bytes; empty when not even the header fits.
 */
export function renderRepositoryMap(
  nodes: readonly RepoMapNode[],
  counts: RepoMapCounts,
  maxBytes: number,
): string {
  const lines = [
    `Repository map (ranked by relevance to the current task; ${String(counts.symbols)} indexed symbols from ${String(counts.indexed)} files, most relevant first):`,
  ]
  for (const node of nodes) {
    lines.push(`- ${node.symbol.name} [${node.symbol.kind}] ${node.symbol.path}:${String(node.symbol.line)}`)
    for (const related of node.related) {
      lines.push(`  -> ${related.name} [${related.kind}] ${related.path}:${String(related.line)}`)
    }
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
