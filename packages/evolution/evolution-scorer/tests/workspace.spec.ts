import { describe, expect, it } from 'vitest'
import type { WorkspaceSnapshotEntry } from '@deepseek-ai/dsh-session-snapshot'
import { diffWorkspace } from '../src/workspace.ts'

const text = (path: string, content: string): WorkspaceSnapshotEntry => ({ path, kind: 'text', content })
const link = (path: string, target: string): WorkspaceSnapshotEntry => ({ path, kind: 'symlink', target })
const directory = (path: string): WorkspaceSnapshotEntry => ({ path, kind: 'empty-directory' })

describe('diffWorkspace', () => {
  it('reports no change when every entry matches, including non-text kinds', () => {
    const entries: WorkspaceSnapshotEntry[] = [
      text('a.txt', 'same'),
      { path: 'blob.bin', kind: 'binary', base64: 'AAEC' },
      link('link', '../target'),
      directory('empty'),
    ]
    expect(diffWorkspace(entries, [...entries])).toEqual([])
  })

  it('names added, removed, and changed paths in path order', () => {
    const changes = diffWorkspace(
      [
        text('a.txt', 'same'),
        text('changed.txt', 'before'),
        text('gone.txt', 'removed'),
        link('link', '../target'),
      ],
      [
        text('a.txt', 'same'),
        text('added.txt', 'new'),
        text('changed.txt', 'after'),
        link('link', '../other-target'),
        directory('new-empty'),
      ],
    )
    expect(changes).toEqual([
      { path: 'added.txt', kind: 'added' },
      { path: 'changed.txt', kind: 'changed' },
      { path: 'gone.txt', kind: 'removed' },
      { path: 'link', kind: 'changed' },
      { path: 'new-empty', kind: 'added' },
    ])
  })

  it('treats a different entry kind at the same path as a change', () => {
    const changes = diffWorkspace(
      [directory('thing')],
      [{ path: 'thing', kind: 'binary', base64: 'AAEC' }],
    )
    expect(changes).toEqual([{ path: 'thing', kind: 'changed' }])
  })
})
