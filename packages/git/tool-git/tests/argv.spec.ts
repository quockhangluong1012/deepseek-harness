/**
 * Argument builders and card-title rendering: the exact argv each git tool
 * runs, and the single display line derived from it.
 */

import { describe, expect, it } from 'vitest'
import { branchLine, commandLineOf, commitLines, pullRequestLine, worktreeLine } from '../src/argv.ts'

describe('commandLineOf', () => {
  it('keeps short plain arguments verbatim', () => {
    expect(commandLineOf({ executable: 'git', args: ['switch', '--create', 'feature'] }))
      .toBe('git switch --create feature')
  })

  it('quotes an argument carrying whitespace and an empty argument', () => {
    expect(commandLineOf({ executable: 'git', args: ['commit', '--message', 'fix a thing', ''] }))
      .toBe('git commit --message "fix a thing" ""')
  })

  it('escapes control characters so the title stays one line', () => {
    expect(commandLineOf({ executable: 'git', args: ['commit', '--message', 'a\nb'] }))
      .toBe('git commit --message "a\\nb"')
  })

  it('elides a long plain argument', () => {
    expect(commandLineOf({ executable: 'gh', args: ['pr', 'create', '--title', 'x'.repeat(80)] }))
      .toBe(`gh pr create --title ${'x'.repeat(59)}…`)
  })

  it('elides and quotes a long argument carrying whitespace', () => {
    expect(commandLineOf({ executable: 'gh', args: ['pr', 'create', '--title', `start ${'x'.repeat(80)}`] }))
      .toBe(`gh pr create --title "${'start '.concat('x'.repeat(53))}…"`)
  })
})

describe('git tool argv', () => {
  it('stages every change, then commits with the model message', () => {
    expect(commitLines({ message: 'add the reader' })).toEqual([
      { executable: 'git', args: ['add', '--all'] },
      { executable: 'git', args: ['commit', '--message', 'add the reader'] },
    ])
  })

  it('creates a branch or switches to an existing one', () => {
    expect(branchLine({ name: 'feature', create: true })).toEqual({ executable: 'git', args: ['switch', '--create', 'feature'] })
    expect(branchLine({ name: 'main' })).toEqual({ executable: 'git', args: ['switch', 'main'] })
    expect(branchLine({ name: 'main', create: false })).toEqual({ executable: 'git', args: ['switch', 'main'] })
  })

  it('opens a pull request with the body on stdin, adding base and draft when asked', () => {
    expect(pullRequestLine({ title: 'Fix the reader', body: 'body' })).toEqual({
      executable: 'gh',
      args: ['pr', 'create', '--title', 'Fix the reader', '--body-file', '-'],
    })
    expect(pullRequestLine({ title: 'Fix', body: 'body', base: 'release', draft: true })).toEqual({
      executable: 'gh',
      args: ['pr', 'create', '--title', 'Fix', '--body-file', '-', '--base', 'release', '--draft'],
    })
  })

  it('adds a worktree with an optional new branch and start point', () => {
    expect(worktreeLine({ action: 'add', path: 'C:\\wt' }))
      .toEqual({ executable: 'git', args: ['worktree', 'add', 'C:\\wt'] })
    expect(worktreeLine({ action: 'add', path: 'C:\\wt', branch: 'spike', commitish: 'main' }))
      .toEqual({ executable: 'git', args: ['worktree', 'add', 'C:\\wt', '-b', 'spike', 'main'] })
  })

  it('removes a worktree, only forcing when asked', () => {
    expect(worktreeLine({ action: 'remove', path: 'C:\\wt' }))
      .toEqual({ executable: 'git', args: ['worktree', 'remove', 'C:\\wt'] })
    expect(worktreeLine({ action: 'remove', path: 'C:\\wt', force: true }))
      .toEqual({ executable: 'git', args: ['worktree', 'remove', '--force', 'C:\\wt'] })
    expect(worktreeLine({ action: 'remove', path: 'C:\\wt', force: false }))
      .toEqual({ executable: 'git', args: ['worktree', 'remove', 'C:\\wt'] })
  })
})
