/**
 * Types of the git tool family: plugin configuration, tool arguments, and the
 * canonical result of one settled git or gh command. This module declares
 * types only.
 *
 * @module @deepseek-ai/dsh-tool-git/types
 */

/** Per-command budgets after configuration defaults and validation. */
export interface CommandLimits {
  /** Cooperative tool-call deadline passed to the tools and carried by `exec.signal`. */
  timeoutMs: number
  /** In-memory stdout tail cap in bytes. */
  outputMaxBytes: number
  /** Whole-stream spill-file cap in bytes, shared by stdout and stderr. */
  spillMaxBytes: number
  /** In-memory stderr tail cap in bytes. */
  stderrMaxBytes: number
  /** Termination grace period passed to the subprocess provider. */
  graceMs: number
}

/** Arguments of one `git_commit` call. */
export interface CommitArgs {
  /** Commit message; the model generates it from the change set. */
  message: string
  /** Repository directory; defaults to the calling session's working directory. */
  repo?: string
}

/** Arguments of one `git_branch` call. */
export interface BranchArgs {
  /** Branch name to switch to, or to create when `create` is true. */
  name: string
  /** Create the branch instead of switching to an existing one. */
  create?: boolean
  /** Repository directory; defaults to the calling session's working directory. */
  repo?: string
}

/** Arguments of one `git_pr` call. */
export interface PullRequestArgs {
  /** Pull request title. */
  title: string
  /** Pull request description; required so `gh` never opens an interactive editor. */
  body: string
  /** Base branch the pull request targets; `gh` defaults to the repository's default branch. */
  base?: string
  /** Open as a draft pull request. */
  draft?: boolean
  /** Repository directory; defaults to the calling session's working directory. */
  repo?: string
}

/** One worktree mutation: create a worktree, or remove one. */
export type WorktreeAction = 'add' | 'remove'

/** Arguments of one `git_worktree` call. */
export interface WorktreeArgs {
  /** `add` creates a worktree; `remove` deletes one from disk and from the repository's metadata. */
  action: WorktreeAction
  /** Directory of the worktree to create (`add`) or remove (`remove`). */
  path: string
  /** With `add`, create this new branch in the worktree. */
  branch?: string
  /** With `add`, commit or branch the new worktree starts from. */
  commitish?: string
  /** With `remove`, discard a worktree holding modifications; absent leaves them protected. */
  force?: boolean
  /** Repository directory; defaults to the calling session's working directory. */
  repo?: string
}

/** One captured stream: the retained tail, whether bytes were dropped, and the complete-stream spill file. */
export interface StreamOutput {
  /** Stream text — the tail of the stream when `truncated`. */
  text: string
  /** True when bytes were dropped from `text`. */
  truncated: boolean
  /** Path to a file holding the complete stream, present when truncated and available. */
  spillPath?: string
}

/** Canonical value of one settled git or gh command; a nonzero exit is a value, not an error. */
export interface CommandOutcome {
  /** Process exit code; null when the process ended on a signal. */
  exitCode: number | null
  /** Signal that ended the process; null on a normal exit. */
  signal: string | null
  /** Captured stdout. */
  stdout: StreamOutput
  /** Captured stderr. */
  stderr: StreamOutput
}

/** One resolved command line: the executable and its arguments, never shell-interpreted. */
export interface CommandLine {
  /** `git` or `gh`; resolved through the subprocess seam at execution time. */
  executable: 'git' | 'gh'
  /** Arguments in argv order. */
  args: string[]
}
