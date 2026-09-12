/**
 * Workspace comparison for scored runs: which paths an attempt's final state
 * added, removed, or changed relative to the expected capture. Both sides come
 * from the snapshot harness's workspace reader, so a comparison is a pure
 * entry-list diff with no filesystem access of its own.
 * @module @deepseek-ai/dsh-evolution-scorer/workspace
 */

import type { WorkspaceSnapshotEntry } from '@deepseek-ai/dsh-session-snapshot'
import type { WorkspaceChange } from './types.ts'

/**
 * Render one captured entry to the value a comparison compares. The entry kinds
 * are a closed union, so a differing `kind` necessarily renders differently.
 * @param entry - captured workspace entry.
 * @returns a string that is equal exactly when two entries describe the same state.
 */
function entryValue(entry: WorkspaceSnapshotEntry): string {
  switch (entry.kind) {
    case 'text': return `text:${entry.content}`
    case 'binary': return `binary:${entry.base64}`
    case 'symlink': return `symlink:${entry.target}`
    case 'empty-directory': return 'empty-directory'
  }
}

/**
 * Compare an expected workspace capture with an actual one.
 * @param expected - expected entries, from `captureExpectedWorkspaceSnapshot` or a prior attempt's initial state.
 * @param actual - entries captured after the run settled.
 * @returns the changed paths sorted by path, empty when the two sides match.
 */
export function diffWorkspace(
  expected: readonly WorkspaceSnapshotEntry[],
  actual: readonly WorkspaceSnapshotEntry[],
): WorkspaceChange[] {
  const before = new Map(expected.map(entry => [entry.path, entryValue(entry)]))
  const after = new Map(actual.map(entry => [entry.path, entryValue(entry)]))
  const changes: WorkspaceChange[] = []
  for (const [path, value] of before) {
    const next = after.get(path)
    if (next === undefined) changes.push({ path, kind: 'removed' })
    else if (next !== value) changes.push({ path, kind: 'changed' })
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changes.push({ path, kind: 'added' })
  }
  return changes.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
}
