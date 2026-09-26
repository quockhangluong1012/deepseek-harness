/**
 * Model-facing git tools: commit the current change set, switch or create a
 * branch, open a pull request through `gh`, and create or remove worktrees.
 *
 * Every command runs through `ctx.subprocess` as an argv vector — never a
 * shell, so no quoting rule and no shell dialect stands between the model and
 * git. The subprocess seam owns executable lookup, the credential scrub,
 * bounded collection with spill files, and managed-range termination. The
 * tools own schemas, argument preconditions, cwd resolution, and rendering.
 *
 * @module @deepseek-ai/dsh-tool-git
 */

import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecution } from '@deepseek-ai/dsh-tools'
import { COMMAND_OUTPUT_PROPERTIES, renderCommand } from './output.ts'
import { commandLineOf, branchLine, commitLines, pullRequestLine, worktreeLine } from './argv.ts'
import { runCommand, resolveExecutable } from './git.ts'
import { presentCommandCall, presentCommandResult } from './presentation.ts'
import type { CommandLimits, CommandLine, CommandOutcome } from './types.ts'

export const name = 'tool-git'
export const inject = ['tools', 'subprocess']

/** Configuration for the git tool family. */
export interface Config {
  /**
   * Cooperative deadline in milliseconds for one git or gh command, declared as
   * the tools' `timeoutMs` for `@deepseek-ai/dsh-tool-call-timeout-policy` to enforce.
   */
  timeoutMs?: number
  /** Retained in-memory stdout tail in bytes; overflow keeps the tail and spills the complete stream. */
  outputMaxBytes?: number
  /** Whole-stream spill-file cap in bytes for a truncated stdout or stderr stream. */
  spillMaxBytes?: number
  /** Retained in-memory stderr tail in bytes. */
  stderrMaxBytes?: number
  /** Milliseconds between starting termination and force-killing a command that will not exit. */
  graceMs?: number
}

/** Default cooperative deadline for one git or gh command (the `timeoutMs` config). */
const DEFAULT_TIMEOUT_MS = 60_000
/** Default in-memory stdout tail (the `outputMaxBytes` config). */
const DEFAULT_OUTPUT_MAX_BYTES = 64_000
/** Default whole-stream spill cap (the `spillMaxBytes` config). */
const DEFAULT_SPILL_MAX_BYTES = 8 * 1024 * 1024
/** Default in-memory stderr tail (the `stderrMaxBytes` config). */
const DEFAULT_STDERR_MAX_BYTES = 16 * 1024
/** Default termination grace period (the `graceMs` config). */
const DEFAULT_GRACE_MS = 2_000

/** Runtime configuration schema for the git tool plugin. */
export const Config: z<Config> = z.object({
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  outputMaxBytes: z.number().default(DEFAULT_OUTPUT_MAX_BYTES),
  spillMaxBytes: z.number().default(DEFAULT_SPILL_MAX_BYTES),
  stderrMaxBytes: z.number().default(DEFAULT_STDERR_MAX_BYTES),
  graceMs: z.number().default(DEFAULT_GRACE_MS),
})

/** Apply the configuration defaults and reject a budget no command could run under. */
function resolveLimits(config: Config): CommandLimits {
  const limits: CommandLimits = {
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    outputMaxBytes: config.outputMaxBytes ?? DEFAULT_OUTPUT_MAX_BYTES,
    spillMaxBytes: config.spillMaxBytes ?? DEFAULT_SPILL_MAX_BYTES,
    stderrMaxBytes: config.stderrMaxBytes ?? DEFAULT_STDERR_MAX_BYTES,
    graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
  }
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`tool-git: ${field} must be a positive integer, got ${JSON.stringify(value)}`)
    }
  }
  return limits
}

/** Reject an empty or whitespace-only free-text argument the schema cannot express. */
function assertNonEmptyText(field: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`invalid ${field}: expected a non-empty string`)
}

/**
 * Reject a branch name git would read as an option or never accept as a ref.
 * The argument reaches git as one argv element, so only refname syntax and a
 * leading dash need rejecting here; any other rule is git's to report.
 */
function assertBranchName(value: string): void {
  if (value.startsWith('-') || value.length === 0 || /[\s~^:?*[\\]/.test(value) || value.includes('..')) {
    throw new Error(`invalid branch name: ${JSON.stringify(value)}`)
  }
}

/** Resolve the command's working directory: an explicit repository path, else the calling session's. */
function repositoryDirectory(repo: string | undefined, sessionCwd: string | undefined): string {
  const base = sessionCwd ?? process.cwd()
  if (repo === undefined) return base
  return isAbsolute(repo) ? repo : resolve(base, repo)
}

/** The one output declaration every git tool registers. */
function commandOutput() {
  return {
    schema: { type: 'object', additionalProperties: false, properties: { ...COMMAND_OUTPUT_PROPERTIES } },
    render: (_args: unknown, value: CommandOutcome) => [
      { type: 'text' as const, text: renderCommand(value) },
    ],
  } as const
}

/**
 * Register the four git tools. Load this plugin wherever the agent should
 * commit, branch, open pull requests, or manage worktrees without going
 * through a raw shell command.
 * @param ctx - context with the tool registry and the subprocess capability.
 * @param config - validated command budgets.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const limits = resolveLimits(config)

  /** Run one command line in the resolved repository directory. */
  const run = async (exec: ToolExecution, line: CommandLine, cwd: string, stdin?: string): Promise<CommandOutcome> =>
    runCommand(ctx, {
      executable: await resolveExecutable(ctx, line.executable, exec.signal),
      args: line.args,
      cwd,
      ...stdin === undefined ? {} : { stdin },
      limits,
      signal: exec.signal,
    })

  const commit: ToolDefinition = defineTool({
    name: 'git_commit',
    description:
      'Stage every change in the repository (`git add --all`) and commit it with your message for the change set. '
      + 'The message becomes the commit message; write it in the imperative mood and describe the change, not the files. '
      + 'A repository with nothing to commit exits nonzero and the reported output says so. '
      + 'Requires a git repository at the resolved directory and a configured git identity (`user.name` and `user.email`).',
    parameters: {
      message: { type: 'string', required: true, description: 'Commit message describing the change set.' },
      repo: { type: 'string', description: 'Repository directory. Defaults to the session working directory; a relative path is resolved against it.' },
    },
    timeoutMs: limits.timeoutMs,
    output: commandOutput(),
    async execute(args, exec) {
      assertNonEmptyText('message', args.message)
      const cwd = repositoryDirectory(args.repo, exec.agent?.session.header.cwd)
      const [stage, commitLine] = commitLines(args)
      const staged = await run(exec, stage, cwd)
      if (staged.exitCode !== 0 || staged.signal !== null) return staged
      return await run(exec, commitLine, cwd)
    },
    presentCall: args => presentCommandCall(commandLineOf(commitLines(args)[1]), args.repo),
    presentResult: (_args, result) => presentCommandResult(result),
  })

  const branch: ToolDefinition = defineTool({
    name: 'git_branch',
    description:
      'Switch to a git branch, or create it first. With `create: true` the branch is created at the current commit and checked out; '
      + 'without it the branch must already exist. The reported output names the resulting branch. '
      + 'Requires a git repository at the resolved directory; a dirty working tree may block the switch.',
    parameters: {
      name: { type: 'string', required: true, description: 'Branch name to switch to or create.' },
      create: { type: 'boolean', description: 'Create the branch at the current commit before switching to it (default false).' },
      repo: { type: 'string', description: 'Repository directory. Defaults to the session working directory; a relative path is resolved against it.' },
    },
    timeoutMs: limits.timeoutMs,
    output: commandOutput(),
    async execute(args, exec) {
      assertBranchName(args.name)
      const cwd = repositoryDirectory(args.repo, exec.agent?.session.header.cwd)
      return await run(exec, branchLine(args), cwd)
    },
    presentCall: args => presentCommandCall(commandLineOf(branchLine(args)), args.repo),
    presentResult: (_args, result) => presentCommandResult(result),
  })

  const pullRequest: ToolDefinition = defineTool({
    name: 'git_pr',
    description:
      'Open a GitHub pull request for the current branch with `gh pr create`. '
      + 'The body is passed on stdin, so it may contain any text. Returns the pull request URL on success. '
      + 'Requires the GitHub CLI (`gh`), authenticated for the repository remote; the harness never forwards an ambient `GH_TOKEN`.',
    parameters: {
      title: { type: 'string', required: true, description: 'Pull request title.' },
      body: { type: 'string', required: true, description: 'Pull request description, in markdown. Required so no interactive editor opens.' },
      base: { type: 'string', description: 'Branch the pull request targets; defaults to the repository default branch.' },
      draft: { type: 'boolean', description: 'Open the pull request as a draft (default false).' },
      repo: { type: 'string', description: 'Repository directory. Defaults to the session working directory; a relative path is resolved against it.' },
    },
    timeoutMs: limits.timeoutMs,
    output: commandOutput(),
    async execute(args, exec) {
      assertNonEmptyText('title', args.title)
      assertNonEmptyText('body', args.body)
      if (args.base !== undefined) assertBranchName(args.base)
      const cwd = repositoryDirectory(args.repo, exec.agent?.session.header.cwd)
      return await run(exec, pullRequestLine(args), cwd, args.body)
    },
    presentCall: args => presentCommandCall(commandLineOf(pullRequestLine(args)), args.repo),
    presentResult: (_args, result) => presentCommandResult(result),
  })

  const worktree: ToolDefinition = defineTool({
    name: 'git_worktree',
    description:
      'Create or remove a git worktree. `add` checks out a second working tree at `path`, optionally creating `branch` and starting from `commitish`, '
      + 'so parallel work proceeds without disturbing this checkout. '
      + '`remove` deletes the worktree directory and its entry in the repository metadata; it refuses a worktree with modifications unless '
      + '`force: true` is passed, and `force: true` DISCARDS those uncommitted modifications. With `add`, `path` has no effect on the current working tree.',
    parameters: {
      action: { type: 'string', required: true, enum: ['add', 'remove'], description: '`add` creates a worktree; `remove` deletes one.' },
      path: {
        type: 'string',
        required: true,
        description: 'Directory of the worktree: where `add` checks it out, or the existing worktree `remove` deletes. A relative path is resolved against the resolved repository directory.',
      },
      branch: { type: 'string', description: 'With `add`, create this new branch checked out in the new worktree.' },
      commitish: { type: 'string', description: 'With `add`, the commit or branch the new worktree starts from; defaults to HEAD.' },
      force: { type: 'boolean', description: 'With `remove`, discard uncommitted modifications in the worktree (default false, which refuses instead).' },
      repo: { type: 'string', description: 'Repository directory. Defaults to the session working directory; a relative path is resolved against it.' },
    },
    timeoutMs: limits.timeoutMs,
    output: commandOutput(),
    async execute(args, exec) {
      assertNonEmptyText('path', args.path)
      if (args.branch !== undefined) assertBranchName(args.branch)
      const cwd = repositoryDirectory(args.repo, exec.agent?.session.header.cwd)
      const line = worktreeLine({ ...args, path: isAbsolute(args.path) ? args.path : resolve(cwd, args.path) })
      return await run(exec, line, cwd)
    },
    presentCall: args => presentCommandCall(commandLineOf(worktreeLine(args)), args.repo),
    presentResult: (_args, result) => presentCommandResult(result),
  })

  ctx.tools.register(commit)
  ctx.tools.register(branch)
  ctx.tools.register(pullRequest)
  ctx.tools.register(worktree)
}
