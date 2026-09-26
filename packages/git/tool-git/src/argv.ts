/**
 * Pure argument builders for the git tool family and the display form of the
 * command line they produce. One builder per tool keeps `execute` and the UI
 * presenter on the same argv, so the card title can never drift from the
 * command that actually ran.
 *
 * @module @deepseek-ai/dsh-tool-git/argv
 */

import type { BranchArgs, CommandLine, CommitArgs, PullRequestArgs, WorktreeArgs } from './types.ts'

/** Longest argument rendered verbatim in a card title before elision. */
const DISPLAY_ARG_MAX_CHARS = 60

/**
 * Render one resolved command line as a single display line: long or
 * whitespace-bearing arguments are elided and quoted so the title stays one
 * line.
 * @param line - the executable and arguments that will run.
 * @returns the command line for a card title.
 */
export function commandLineOf(line: CommandLine): string {
  const displayed = line.args.map((arg) => {
    const oneLine = arg.length <= DISPLAY_ARG_MAX_CHARS ? arg : `${arg.slice(0, DISPLAY_ARG_MAX_CHARS - 1)}…`
    return /[\s"\\]/.test(oneLine) || oneLine.length === 0 ? JSON.stringify(oneLine) : oneLine
  })
  return [line.executable, ...displayed].join(' ')
}

/**
 * Build the `git add --all` + `git commit` sequence for one commit call.
 * @param args - the commit message and optional repository.
 * @returns the two command lines in execution order: staging, then committing.
 */
export function commitLines(args: CommitArgs): readonly [CommandLine, CommandLine] {
  return [
    { executable: 'git', args: ['add', '--all'] },
    { executable: 'git', args: ['commit', '--message', args.message] },
  ]
}

/**
 * Build the branch switch for one call.
 * @param args - the branch name and whether to create it.
 * @returns `git switch --create <name>`, or `git switch <name>` to switch to an existing branch.
 */
export function branchLine(args: BranchArgs): CommandLine {
  return args.create === true
    ? { executable: 'git', args: ['switch', '--create', args.name] }
    : { executable: 'git', args: ['switch', args.name] }
}

/**
 * Build the pull-request creation for one call. The body travels on stdin
 * (`--body-file -`) so no free text is passed as a shell argument.
 * @param args - the title, body, optional base branch, and draft flag.
 * @returns the `gh pr create` command line.
 */
export function pullRequestLine(args: PullRequestArgs): CommandLine {
  return {
    executable: 'gh',
    args: [
      'pr', 'create',
      '--title', args.title,
      '--body-file', '-',
      ...args.base === undefined ? [] : ['--base', args.base],
      ...args.draft === true ? ['--draft'] : [],
    ],
  }
}

/**
 * Build the worktree mutation for one call.
 * @param args - the action, the worktree path, and the branch/commitish/force options it accepts.
 * @returns the `git worktree add` or `git worktree remove` command line.
 */
export function worktreeLine(args: WorktreeArgs): CommandLine {
  if (args.action === 'remove') {
    return {
      executable: 'git',
      args: ['worktree', 'remove', ...args.force === true ? ['--force'] : [], args.path],
    }
  }
  return {
    executable: 'git',
    args: [
      'worktree', 'add', args.path,
      ...args.branch === undefined ? [] : ['-b', args.branch],
      ...args.commitish === undefined ? [] : [args.commitish],
    ],
  }
}
