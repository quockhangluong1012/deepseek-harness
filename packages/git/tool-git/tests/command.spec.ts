/**
 * Command-layer coverage over a fake subprocess provider: the spawn spec the
 * git tools hand the seam (argv, cwd, stdin, output caps, spill, grace,
 * environment, signal) and every failure path the real provider cannot stage
 * deterministically. The real provider and the real `git` binary are exercised
 * by the integration suite.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime, SubprocessExecutableNotFoundError } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessCollectedOutputs,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { resolveExecutable, runCommand } from '../src/git.ts'
import type { CommandLimits } from '../src/types.ts'

/** The budgets every case runs under. */
const LIMITS: CommandLimits = {
  timeoutMs: 1_000,
  outputMaxBytes: 32,
  spillMaxBytes: 4_096,
  stderrMaxBytes: 16,
  graceMs: 50,
}

/** A subprocess provider whose spawn, resolution, and outcome each follow the case's instructions. */
class FakeSubprocessRuntime extends SubprocessRuntime {
  readonly requests: SubprocessSpawnSpec[] = []
  resolveTo: string | Error = 'C:\\bin\\git.exe'
  outcome: SubprocessOutcome = { exitCode: 0, signal: null }
  failure: 'synchronous' | 'outcome' | undefined
  streams: SubprocessCollectedOutputs = {}
  /** When true, `done` settles only after {@link releaseOutcome}. */
  hold = false
  private release: (() => void) | undefined

  override async resolveExecutable(_command: string): Promise<string> {
    if (this.resolveTo instanceof Error) throw this.resolveTo
    return this.resolveTo
  }

  override async terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return { platform: 'posix' }
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.requests.push(spec)
    if (this.failure === 'synchronous') throw new Error('spawn refused')
    const done = this.hold
      ? new Promise<SubprocessOutcome>((settle) => { this.release = () => { settle(this.outcome) } })
      : this.failure === 'outcome'
        ? Promise.reject(new Error('provider failed'))
        : Promise.resolve(this.outcome)
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: this.streams,
      done,
      terminate() {},
      waitForExit: async () => true,
    }
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<never> {
    return Promise.reject(new Error('terminal spawn is unused by the git tools'))
  }

  /** Settle a held `done` with the configured outcome. */
  releaseOutcome(): void {
    this.release?.()
  }
}

/** One collected stream reader over fixed text. */
const reader = (text: string, lossy = false, spillPath?: string) => ({
  readFrom: () => ({ text, nextOffset: text.length, lossy, ...spillPath === undefined ? {} : { spillPath } }),
})

async function rig(): Promise<{ ctx: Context; fake: FakeSubprocessRuntime }> {
  const ctx = new Context()
  await ctx.plugin(FakeSubprocessRuntime)
  return { ctx, fake: ctx.subprocess as FakeSubprocessRuntime }
}

describe('resolveExecutable', () => {
  it('returns the provider path', async () => {
    const { ctx } = await rig()
    expect(await resolveExecutable(ctx, 'git', new AbortController().signal)).toBe('C:\\bin\\git.exe')
  })

  it('names the missing program for each git tool executable', async () => {
    const { ctx, fake } = await rig()
    fake.resolveTo = new SubprocessExecutableNotFoundError('not found')
    await expect(resolveExecutable(ctx, 'git', new AbortController().signal))
      .rejects.toThrow('git is not available in this execution world; install git, or run the command through a shell tool')
    await expect(resolveExecutable(ctx, 'gh', new AbortController().signal))
      .rejects.toThrow('gh is not available in this execution world; install the GitHub CLI (`gh`) and authenticate it, or open the pull request another way')
  })

  it('rethrows a lookup failure that is not an absence', async () => {
    const { ctx, fake } = await rig()
    fake.resolveTo = new Error('transport is down')
    await expect(resolveExecutable(ctx, 'git', new AbortController().signal)).rejects.toThrow('transport is down')
  })
})

describe('runCommand', () => {
  it('spawns the argv vector with bounded collected output, the command environment, and no stdin', async () => {
    const { ctx, fake } = await rig()
    fake.streams = {
      stdout: reader('committed\n', true, 'C:\\spill\\out.txt'),
      stderr: reader('warning\n'),
    }
    const signal = new AbortController().signal
    const outcome = await runCommand(ctx, {
      executable: 'C:\\bin\\git.exe',
      args: ['commit', '--message', 'hello'],
      cwd: 'C:\\work',
      limits: LIMITS,
      signal,
    })

    expect(outcome).toEqual({
      exitCode: 0,
      signal: null,
      stdout: { text: 'committed\n', truncated: true, spillPath: 'C:\\spill\\out.txt' },
      stderr: { text: 'warning\n', truncated: false },
    })
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({
      argv: ['C:\\bin\\git.exe', 'commit', '--message', 'hello'],
      cwd: 'C:\\work',
      graceMs: 50,
      signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 32, spill: { maxBytes: 4_096 } },
        stderr: { maxBytes: 16, spill: { maxBytes: 4_096 } },
      },
    })
    expect(fake.requests[0]?.env).toMatchObject({
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      GH_PROMPT_DISABLED: '1',
      LC_ALL: 'C',
    })
  })

  it('passes a stdin payload and reports a signal ending', async () => {
    const { ctx, fake } = await rig()
    fake.outcome = { exitCode: null, signal: 'SIGTERM' }
    fake.streams = { stdout: reader(''), stderr: reader('') }
    const outcome = await runCommand(ctx, {
      executable: 'C:\\bin\\gh.exe',
      args: ['pr', 'create'],
      cwd: 'C:\\work',
      stdin: 'body text',
      limits: LIMITS,
      signal: new AbortController().signal,
    })
    expect(fake.requests[0]?.stdio.stdin).toEqual({ data: 'body text' })
    expect(outcome).toMatchObject({ exitCode: null, signal: 'SIGTERM' })
  })

  it('refuses to spawn under an already-aborted signal', async () => {
    const { ctx, fake } = await rig()
    await expect(runCommand(ctx, {
      executable: 'git',
      args: ['status'],
      cwd: 'C:\\work',
      limits: LIMITS,
      signal: AbortSignal.abort(),
    })).rejects.toThrow('tool call aborted')
    expect(fake.requests).toHaveLength(0)
  })

  it('reports a synchronous spawn refusal with the program name', async () => {
    const { ctx, fake } = await rig()
    fake.failure = 'synchronous'
    await expect(runCommand(ctx, {
      executable: 'C:\\bin\\git.exe',
      args: ['status'],
      cwd: 'C:\\work',
      limits: LIMITS,
      signal: new AbortController().signal,
    })).rejects.toThrow('git could not start: spawn refused')
  })

  it('reports a provider failure that never yields an outcome', async () => {
    const { ctx, fake } = await rig()
    fake.failure = 'outcome'
    await expect(runCommand(ctx, {
      executable: 'C:\\bin\\gh.exe',
      args: ['pr', 'create'],
      cwd: 'C:\\work',
      limits: LIMITS,
      signal: new AbortController().signal,
    })).rejects.toThrow('gh did not report an outcome: provider failed')
  })

  it('treats a signal aborted while the outcome is pending as a cancelled call', async () => {
    const { ctx, fake } = await rig()
    fake.hold = true
    const controller = new AbortController()
    const pending = runCommand(ctx, {
      executable: 'git',
      args: ['status'],
      cwd: 'C:\\work',
      limits: LIMITS,
      signal: controller.signal,
    })
    controller.abort()
    fake.releaseOutcome()
    await expect(pending).rejects.toThrow('tool call aborted')
  })

  it('refuses to read an outcome without collected streams', async () => {
    const { ctx } = await rig()
    await expect(runCommand(ctx, {
      executable: 'git',
      args: ['status'],
      cwd: 'C:\\work',
      limits: LIMITS,
      signal: new AbortController().signal,
    })).rejects.toThrow('git produced no collected output stream')
  })
})
