/**
 * What the progress panel reports, derived only from Client-held facts: the
 * host-computed `todos` projection (the standing checklist) and the
 * `deliverables` Turn data `ui-deliverables` publishes for every Turn that
 * mutated files. Neither is re-derived here — the mutation vocabulary stays
 * with its owner, and this module only orders what those owners published.
 */
import type { ConversationTimelineSnapshot } from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `deliverables` Turn-data merge this module reads.
import type {} from '@deepseek-ai/dsh-client-ui-deliverables/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'

/**
 * Every file the loaded Turns produced, in turn order and then in the order
 * each Turn produced it, once per path: a file written and then edited again
 * is one row, at the position it first appeared.
 * @param timeline - the Chat target's Turn timeline; undefined before it exists.
 * @returns produced paths, or an empty list while nothing was produced.
 */
export function producedPaths(timeline: ConversationTimelineSnapshot | undefined): readonly string[] {
  if (timeline === undefined) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const turn of timeline.turnOrder) {
    const produced = timeline.turns.get(turn)?.data.get('deliverables')?.produced
    if (produced === undefined) continue
    for (const file of produced) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      paths.push(file.path)
    }
  }
  return paths
}

/**
 * Whether one Session has anything for the panel to report: a standing
 * checklist, or at least one produced file.
 * @param todos - the `todos` projection value.
 * @param timeline - the Chat target's Turn timeline; undefined before it exists.
 * @returns whether progress exists.
 */
export function hasProgress(
  todos: readonly TodoItem[] | null | undefined,
  timeline: ConversationTimelineSnapshot | undefined,
): boolean {
  if (todos !== null && todos !== undefined && todos.length > 0) return true
  if (timeline === undefined) return false
  for (const turn of timeline.turnOrder) {
    const produced = timeline.turns.get(turn)?.data.get('deliverables')?.produced
    if (produced !== undefined && produced.length > 0) return true
  }
  return false
}
