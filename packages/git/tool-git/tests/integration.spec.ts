/**
 * Integration tests: the REAL local subprocess provider and the REAL `git`
 * binary against a temporary repository created here and removed here. Each
 * spec owns its directory and every worktree it creates, so the suite runs
 * beside other forked workers. These verify the world — arguments reach git
 * verbatim (no shell), the repository state actually changes, and bounded
 * output recovers through a spill file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolGit from '@deepseek-ai/dsh-tool-git'

// Windows process startup makes each real git invocation cost about a second.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const testToolSignal = new AbortController().signal

let dir: string
let worktree: string
let ctx: Context

/** The fixture workspace as the calling session's working directory. */
const agent = () => ({ session: { header: { id: 'session-git', cwd: dir } } })

let callCounter = 0
function call(name: string, args: unknown, cwd: string = dir) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    agent: { session: { header: { id: 'session-git', cwd } } } as never,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Run fixture git through the same seam the tools use, failing loud on a nonzero exit. */
async function git(args: readonly string[], cwd: string = dir): Promise<string> {
  const executable = await ctx.subprocess.resolveExecutable('git')
  const handle = ctx.subprocess.spawn({
    argv: [executable, ...args],
    cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1 << 20 } },
    graceMs: 2_000,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  if (outcome.exitCode !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${stderr}`)
  return stdout
}

/** Boot one composition over the temporary repository. */
async function boot(ctxToUse: Context, config: ToolGit.Config = {}): Promise<void> {
  await ctxToUse.plugin(SystemPrompt)
  await ctxToUse.plugin(ToolRuntime)
  await ctxToUse.plugin(LocalSubprocessRuntime)
  await ctxToUse.plugin(ToolGit, config)
}

describe('git tools over the real subprocess provider', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-git-'))
    worktree = `${dir}-worktree`
    ctx = new Context()
    await boot(ctx)
    await git(['init', '-q', '-b', 'main'])
    // Fixture identity written directly: the suite under test owns no config command.
    await appendFile(join(dir, '.git', 'config'), '[user]\n\tname = Tool Git Test\n\temail = tool-git@example.test\n')
    await writeFile(join(dir, 'a.txt'), 'one\n')
    await git(['add', '--all'])
    await git(['commit', '-q', '-m', 'initial'])
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
    await rm(worktree, { recursive: true, force: true })
  })

  describe('git_commit', () => {
    it('stages untouched and new files and commits them with the model message', async () => {
      await writeFile(join(dir, 'b.txt'), 'two\n')
      await writeFile(join(dir, 'a.txt'), 'one changed\n')
      const result = await call('git_commit', { message: 'Add b and change a', repo: dir })
      expect(result.isError).toBe(false)
      expect((await git(['log', '-1', '--format=%s'])).trim()).toBe('Add b and change a')
      expect(await git(['status', '--porcelain'])).toBe('')
    })

    it('passes a multi-line message with quotes verbatim', async () => {
      await writeFile(join(dir, 'b.txt'), 'two\n')
      const message = 'Fix "the reader"\n\nExplain the change.'
      expect((await call('git_commit', { message })).isError).toBe(false)
      expect((await git(['log', '-1', '--format=%B'])).trimEnd()).toBe(message)
    })

    it('reports an unchanged repository as a nonzero exit, not an error', async () => {
      const result = await call('git_commit', { message: 'nothing to do' })
      expect(result.isError).toBe(false)
      expect(text(result)).toContain('[exit code: 1]')
      expect(text(result)).toContain('nothing to commit')
    })

    it('rejects an empty message before spawning', async () => {
      const result = await call('git_commit', { message: '   ' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('invalid message: expected a non-empty string')
    })

    it('reports an argument git cannot accept as a start failure', async () => {
      const result = await call('git_commit', { message: 'a\u0000b' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('git could not start')
    })

    it('resolves a relative repository against the session working directory', async () => {
      await writeFile(join(dir, 'b.txt'), 'two\n')
      expect((await call('git_commit', { message: 'Relative repo', repo: '.' }, dir)).isError).toBe(false)
      expect((await git(['log', '-1', '--format=%s'])).trim()).toBe('Relative repo')
    })
  })

  describe('git_branch', () => {
    it('creates and switches to a new branch', async () => {
      const result = await call('git_branch', { name: 'feature', create: true })
      expect(result.isError).toBe(false)
      expect((await git(['branch', '--show-current'])).trim()).toBe('feature')
    })

    it('switches to an existing branch', async () => {
      await git(['switch', '-q', '-c', 'other'])
      await git(['switch', '-q', 'main'])
      expect((await call('git_branch', { name: 'other' })).isError).toBe(false)
      expect((await git(['branch', '--show-current'])).trim()).toBe('other')
    })

    it('rejects a branch name that would be read as an option', async () => {
      const result = await call('git_branch', { name: '--force' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('invalid branch name: "--force"')
    })
  })

  describe('git_worktree', () => {
    it('creates a worktree on a new branch and removes it again', async () => {
      const added = await call('git_worktree', { action: 'add', path: worktree, branch: 'spike' })
      expect(added.isError).toBe(false)
      expect(existsSync(join(worktree, 'a.txt'))).toBe(true)
      expect((await git(['-C', worktree, 'branch', '--show-current'])).trim()).toBe('spike')

      const removed = await call('git_worktree', { action: 'remove', path: worktree })
      expect(removed.isError).toBe(false)
      expect(existsSync(worktree)).toBe(false)
    })

    it('refuses a dirty worktree without force, then discards it with force', async () => {
      expect((await call('git_worktree', { action: 'add', path: worktree })).isError).toBe(false)
      await writeFile(join(worktree, 'dirty.txt'), 'unsaved\n')

      const refused = await call('git_worktree', { action: 'remove', path: worktree })
      expect(refused.isError).toBe(false)
      expect(text(refused)).toContain('use --force to delete it')
      expect(existsSync(worktree)).toBe(true)

      expect((await call('git_worktree', { action: 'remove', path: worktree, force: true })).isError).toBe(false)
      expect(existsSync(worktree)).toBe(false)
    })

    it('rejects an empty path before spawning', async () => {
      const result = await call('git_worktree', { action: 'add', path: ' ' })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('invalid path: expected a non-empty string')
    })
  })

  describe('git_pr', () => {
    it('reports the GitHub CLI as unavailable instead of failing opaquely', async () => {
      const emptyPath = join(dir, 'empty-path')
      await mkdir(emptyPath, { recursive: true })
      const previous = process.env.PATH
      process.env.PATH = emptyPath
      try {
        const result = await call('git_pr', { title: 'A pull request', body: 'Body text' })
        expect(result.isError).toBe(true)
        expect(text(result)).toContain('gh is not available in this execution world')
      } finally {
        process.env.PATH = previous
      }
    })
  })

  describe('cancellation and bounded output', () => {
    it('reports a cancelled call as aborted', async () => {
      const result = await ctx.tools.execute({
        signal: AbortSignal.abort(),
        callId: ToolCallId('call-aborted'),
        name: 'git_commit',
        arguments: { message: 'never runs' },
        agent: agent() as never,
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('aborted')
    })

    it('truncates stdout to the configured tail and recovers the complete stream from the spill file', async () => {
      const bounded = new Context()
      await boot(bounded, { outputMaxBytes: 8 })

      await writeFile(join(dir, 'b.txt'), 'two\n')
      const result = await bounded.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('call-bounded'),
        name: 'git_commit',
        arguments: { message: 'Bounded output' },
        agent: agent() as never,
      })
      const rendered = text(result)
      expect(result.isError).toBe(false)
      const recovery = /\[output truncated; full output: ([^\]]+)\]/.exec(rendered)
      expect(recovery).not.toBeNull()
      expect(existsSync(recovery![1]!)).toBe(true)
      expect((await git(['log', '-1', '--format=%s'])).trim()).toBe('Bounded output')
      await bounded.fiber.dispose()
    })
  })
})
