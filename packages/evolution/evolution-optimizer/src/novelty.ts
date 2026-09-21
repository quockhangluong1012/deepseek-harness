/**
 * Novelty of one candidate body: how much of its instructions is material the
 * starting body does not already carry. Measured on instruction lines only —
 * frontmatter and fences are routing and format, not behavior, so a candidate
 * that only rewords its description is not novel. Compared order-insensitively
 * and with case and spacing normalized, so a rearrangement of existing
 * instructions is not novelty, while a rule the skill never stated is. Pure,
 * so specs drive the arithmetic without a run.
 * @module @deepseek-ai/dsh-evolution-optimizer/novelty
 */

/**
 * The distinct instruction lines one body is made of: a leading frontmatter
 * block dropped, blank lines dropped, each line trimmed, its internal
 * whitespace collapsed, and its case folded, so reformatting cannot pass for
 * new material. Frontmatter is routing metadata every candidate restates, so
 * counting it would dilute the share with lines no candidate authored.
 * @param body - complete SKILL.md body.
 * @returns the distinct normalized lines.
 */
function instructionLines(body: string): Set<string> {
  const lines = body.split('\n')
  const closing = lines[0]?.trim() === '---'
    ? lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    : -1
  const seen = new Set<string>()
  for (const raw of lines.slice(closing + 1)) {
    const line = raw.toLowerCase().replace(/\s+/g, ' ').trim()
    if (line.length > 0) seen.add(line)
  }
  return seen
}

/**
 * Share of one candidate's distinct instruction lines that the reference body
 * does not contain, in 0..1. Zero means the candidate only reorders or
 * reformats what was already there; one means every line is new material. A
 * body with no instruction lines reports zero: it states nothing to be novel
 * about.
 * @param body - candidate SKILL.md body.
 * @param reference - body the run started from.
 * @returns the novel share of the candidate's lines.
 */
export function noveltyOf(body: string, reference: string): number {
  const candidate = instructionLines(body)
  if (candidate.size === 0) return 0
  const known = instructionLines(reference)
  let fresh = 0
  for (const line of candidate) {
    if (!known.has(line)) fresh += 1
  }
  return fresh / candidate.size
}
