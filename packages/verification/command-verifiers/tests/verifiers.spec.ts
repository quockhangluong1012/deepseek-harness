/**
 * Configuration resolution, path-scope matching, and the verdicts one command
 * target produces for every way a run can end. The executor is a test double so
 * timeout, abort, and signal outcomes stay deterministic; the real bash
 * executor over a booted cordis.yml is covered in `loader-composition.spec.ts`.
 *
 * @module @deepseek-ai/dsh-command-verifiers/tests/verifiers
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import type { AcceptanceCriterion, ChangeContract, TaskId, VerificationRequest } from '@deepseek-ai/dsh-agent-kernel'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { CollectedOutput, ShellExecRequest, ShellExecSpec, ShellExecution, ShellRunResult, SubprocessOutputReader } from '@deepseek-ai/dsh-shell'
import { apply, name } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { VerifierEntry } from '../src/types.ts'
import { resolveTargets, withinExpectedPaths } from '../src/targets.ts'
import { CommandCriterionVerifier, VERIFIER_ID } from '../src/verifier.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** A stream reader for a handle no test reads incrementally. */
const EMPTY_READER: SubprocessOutputReader = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }

/** A shell executor whose every command settles with one canned result; mounted as `ctx.shell`. */
class StubExecutor extends ShellExecutor {
  readonly commands: string[] = []
  settle: (spec: ShellExecSpec) => ShellRunResult = () => runResult()
  /** When set, {@link execute} throws this value instead of publishing a handle. */
  refuse: unknown
  /** When set, the published handle's `result()` rejects. */
  rejectResult: Error | undefined

  /** @param request - the caller's request; this stub fills no defaults a test asserts on. */
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '.',
      timeoutMs: request.timeoutMs ?? 1_000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /** @param spec - the resolved spec the test's `settle` answers for. */
  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    this.commands.push(spec.command)
    if (this.refuse !== undefined) throw this.refuse
    const result = this.settle(spec)
    const rejection = this.rejectResult
    return {
      status: 'completed',
      exitCode: result.exitCode,
      signal: result.signal,
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      observed: { stdout: EMPTY_READER, stderr: EMPTY_READER },
      kill: () => false,
      result: () => rejection === undefined ? Promise.resolve(result) : Promise.reject(rejection),
    }
  }
}

/** The mounted stub executor and the verifier built over one resolved configuration. */
interface Setup {
  ctx: Context
  executor: StubExecutor
  verifier: CommandCriterionVerifier
}

/** Mount the stub executor and build a verifier over the resolved configuration. */
async function setup(config: Config, settle?: (spec: ShellExecSpec) => ShellRunResult): Promise<Setup> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(StubExecutor)
  const executor = ctx.shell as StubExecutor
  if (settle !== undefined) executor.settle = settle
  return { ctx, executor, verifier: new CommandCriterionVerifier(ctx, resolveTargets(config)) }
}

/** One collected stream. */
function output(text: string, extra: Partial<CollectedOutput> = {}): CollectedOutput {
  return { text, truncated: false, ...extra }
}

/** One foreground result with every independently reported fact explicit. */
function runResult(overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 1_000,
    stdout: output(''),
    stderr: output(''),
    ...overrides,
  }
}

/** One criterion with the given id and family. */
function criterion(id: string, verifier: AcceptanceCriterion['verifier'] = 'test'): AcceptanceCriterion {
  return { id, description: `criterion ${id}`, verifier, required: true }
}

/** One verification request over the given criteria, changed scopes, declared contract, and repository state. */
function request(
  criteria: readonly AcceptanceCriterion[],
  changedScopes: readonly string[] = [],
  changeContract?: ChangeContract,
  repositoryDigest = 'digest-1',
): VerificationRequest {
  return {
    taskId: brandString<TaskId>('task-1'),
    revision: 1,
    criteria,
    changedScopes,
    repositoryDigest,
    ...changeContract === undefined ? {} : { changeContract },
  }
}

/** One declared change contract: the goal every verdict quotes, and no bound until a test declares one. */
function contract(overrides: Partial<ChangeContract> = {}): ChangeContract {
  return {
    goal: 'extract the boundary check',
    expectedFiles: [],
    allowedFiles: [],
    mustPreserve: [],
    forbiddenChanges: [],
    expectedTests: [],
    ...overrides,
  }
}

/** One command entry with the fields every command target needs. */
function entry(overrides: VerifierEntry = {}): VerifierEntry {
  return { command: 'run checks', timeoutMs: 1_000, expectedExitCodes: [0], ...overrides }
}

describe('configuration resolution', () => {
  it('composes the command line and copies the accepted exit codes', () => {
    const targets = resolveTargets({ verifiers: { build: entry({ command: 'pnpm run', args: ['build', '--filter x'], cwd: 'packages/x', expectedExitCodes: [0, 3] }) } })
    expect(targets.get('build')).toEqual({
      kind: 'command',
      claim: 'build',
      command: 'pnpm run build --filter x',
      cwd: 'packages/x',
      timeoutMs: 1_000,
      expectedExitCodes: [0, 3],
    })
  })

  it('resolves a scope target from its expected paths', () => {
    const targets = resolveTargets({ verifiers: { diff: { expectedPaths: ['src/**'] } } })
    expect(targets.get('diff')).toEqual({ kind: 'scopes', claim: 'diff', expectedPaths: ['src/**'] })
  })

  it('resolves a contract target from its claim alone', () => {
    const targets = resolveTargets({ verifiers: { 'change-boundary': { contract: true } } })
    expect(targets.get('change-boundary')).toEqual({ kind: 'contract', claim: 'change-boundary' })
  })

  it('refuses a deployment that declares no target at all', () => {
    expect(() => resolveTargets({})).toThrow(/verifiers must declare at least one target/)
    expect(() => resolveTargets({ verifiers: {} })).toThrow(/at least one target/)
  })

  it('refuses a target that could never decide a criterion', () => {
    const cases: readonly [VerifierEntry, RegExp][] = [
      [{}, /declares neither a command, a non-empty expectedPaths, nor contract: true/],
      [{ contract: false }, /declares neither a command, a non-empty expectedPaths, nor contract: true/],
      [{ contract: true, command: 'run checks', timeoutMs: 1_000, expectedExitCodes: [0] }, /declares command beside contract/],
      [{ contract: true, args: ['x'] }, /declares args beside contract/],
      [{ contract: true, cwd: 'x' }, /declares cwd beside contract/],
      [{ contract: true, timeoutMs: 5 }, /declares timeoutMs beside contract/],
      [{ contract: true, expectedExitCodes: [0] }, /declares expectedExitCodes beside contract/],
      [{ contract: true, expectedPaths: ['src/**'] }, /declares expectedPaths beside contract/],
      [{ command: 'x', expectedPaths: ['src/**'] }, /declares command and expectedPaths together/],
      [entry({ command: '   ' }), /declares an empty command/],
      [entry({ cwd: '  ' }), /declares an empty cwd/],
      [{ command: 'run checks', expectedExitCodes: [0] }, /needs a positive integer timeoutMs/],
      [entry({ timeoutMs: 0 }), /needs a positive integer timeoutMs/],
      [entry({ timeoutMs: 1.5 }), /needs a positive integer timeoutMs/],
      [{ command: 'run checks', timeoutMs: 1_000 }, /needs a non-empty expectedExitCodes list of integers/],
      [entry({ expectedExitCodes: [] }), /expectedExitCodes list of integers/],
      [entry({ expectedExitCodes: [0, 1.5] }), /expectedExitCodes list of integers/],
      [{ expectedPaths: [] }, /declares neither a command, a non-empty expectedPaths, nor contract: true/],
      [{ expectedPaths: ['  '] }, /at least one non-empty expectedPaths glob/],
      [{ expectedPaths: ['src/**'], timeoutMs: 5 }, /declares timeoutMs beside expectedPaths/],
      [{ expectedPaths: ['src/**'], args: ['x'] }, /declares args beside expectedPaths/],
      [{ expectedPaths: ['src/**'], cwd: 'x' }, /declares cwd beside expectedPaths/],
      [{ expectedPaths: ['src/**'], expectedExitCodes: [0] }, /declares expectedExitCodes beside expectedPaths/],
    ]
    for (const [declared, message] of cases) {
      expect(() => resolveTargets({ verifiers: { check: declared } }), JSON.stringify(declared)).toThrow(message)
    }
    expect(() => resolveTargets({ verifiers: { '  ': entry() } })).toThrow(/declares an empty claim/)
  })
})

describe('expected path matching', () => {
  it('matches the declared globs and normalizes Windows separators', () => {
    expect(withinExpectedPaths('src/a/b.ts', ['src/**'])).toBe(true)
    expect(withinExpectedPaths('src\\a\\b.ts', ['src/**'])).toBe(true)
    expect(withinExpectedPaths('src/a/b.ts', ['src/*'])).toBe(false)
    expect(withinExpectedPaths('src/.hidden.ts', ['src/**'])).toBe(true)
    expect(withinExpectedPaths('test/a.ts', ['src/**'])).toBe(false)
  })
})

describe('criterion claims', () => {
  it('claims a criterion by its own id before its family', async () => {
    const { verifier } = await setup({ verifiers: { 'unit-tests': entry(), test: entry() } })
    expect(verifier.supports(criterion('unit-tests'))).toBe(true)
    expect(verifier.supports(criterion('other', 'test'))).toBe(true)
    expect(verifier.supports(criterion('other', 'build'))).toBe(false)
  })

  it('answers nothing for a criterion it does not claim', async () => {
    const { verifier } = await setup({ verifiers: { build: entry() } })
    expect(await verifier.verify(request([criterion('x', 'research')]), criterion('x', 'research'))).toBeUndefined()
  })

  it('claims no criterion for a deployment that declares no contract target', async () => {
    const { verifier } = await setup({ verifiers: { build: entry() } })
    const boundary = criterion('change-boundary', 'diff')
    expect(verifier.supports(boundary)).toBe(false)
    expect(await verifier.verify(request([boundary], ['handbook/readme.md'], contract()), boundary)).toBeUndefined()
  })

  it('identifies itself with a stable id', async () => {
    const { verifier } = await setup({ verifiers: { build: entry() } })
    expect(verifier.id).toBe(VERIFIER_ID)
  })
})

describe('command verdicts', () => {
  it('passes on an accepted exit code and records the command', async () => {
    const { verifier, executor } = await setup({ verifiers: { build: entry({ command: 'pnpm', args: ['build'], cwd: 'packages/x', expectedExitCodes: [0, 3] }) } }, () => runResult({ exitCode: 3 }))
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict).toEqual({
      result: {
        criterionId: 'build',
        status: 'pass',
        evidence: ['packages/x'],
        detail: 'exit code 3 (expected exit 0 or 3)',
      },
      commands: ['pnpm build'],
    })
    expect(executor.commands).toEqual(['pnpm build'])
  })

  it('names the executor working directory when the target declares no cwd', async () => {
    const { verifier } = await setup({ verifiers: { build: entry() } })
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict?.result.evidence).toEqual(['.'])
  })

  it('fails on an exit code the target does not accept, with the output tail', async () => {
    const { verifier } = await setup({ verifiers: { build: entry() } }, () => runResult({
      exitCode: 1,
      stdout: output('boom'),
      stderr: output('error: no'),
    }))
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.detail).toBe('exit code 1 (expected exit 0)\nstdout:\nboom\nstderr:\nerror: no')
  })

  it('fails a run that timed out even when it exited with an accepted code', async () => {
    const { verifier } = await setup({ verifiers: { build: entry() } }, () => runResult({ timedOut: true, exitCode: 0, timeoutMs: 250 }))
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.detail).toBe('timed out after 250ms (expected exit 0)')
  })

  it('fails a run the caller aborted', async () => {
    const { verifier } = await setup({ verifiers: { build: entry() } }, () => runResult({ aborted: true }))
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict?.result.detail).toBe('aborted before it finished (expected exit 0)')
  })

  it('fails a run killed by a signal, naming the signal it knows', async () => {
    const killed = await setup({ verifiers: { build: entry() } }, () => runResult({ exitCode: null, signal: 'SIGKILL' }))
    const named = await killed.verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(named?.result.detail).toBe('killed by signal SIGKILL (expected exit 0)')

    const unknown = await setup({ verifiers: { build: entry() } }, () => runResult({ exitCode: null }))
    const unnamed = await unknown.verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(unnamed?.result.detail).toBe('killed by signal unknown (expected exit 0)')
  })

  it('points at the spill file holding a truncated tail', async () => {
    const { verifier } = await setup({ verifiers: { build: entry() } }, () => runResult({
      stdout: output('tail', { truncated: true, spillPath: '/spill/out' }),
      stderr: output('tail', { truncated: true }),
    }))
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict?.result.detail).toBe('exit code 0 (expected exit 0)\nstdout:\ntail\nstdout truncated; complete stream at /spill/out\nstderr:\ntail\nstderr truncated; complete stream at no spill file')
  })

  it('fails a criterion when no shell executor is mounted', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const verifier = new CommandCriterionVerifier(ctx, resolveTargets({ verifiers: { build: entry() } }))
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict).toEqual({
      result: {
        criterionId: 'build',
        status: 'fail',
        evidence: ['.'],
        detail: 'no shell executor is mounted, so "run checks" did not run',
      },
    })
  })

  it('fails a criterion whose command cannot start, naming the failure', async () => {
    const { executor, verifier } = await setup({ verifiers: { build: entry() } })
    executor.refuse = new Error('bash-local: workdir is unusable')
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.detail).toBe('"run checks" could not run: bash-local: workdir is unusable')
  })

  it('fails a criterion whose foreground result rejects', async () => {
    const { executor, verifier } = await setup({ verifiers: { build: entry() } })
    executor.rejectResult = new Error('the process never started')
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.detail).toBe('"run checks" could not run: the process never started')
  })

  it('fails a criterion whose failure is not an Error', async () => {
    const { executor, verifier } = await setup({ verifiers: { build: entry() } })
    executor.refuse = 'no shell'
    const verdict = await verifier.verify(request([criterion('build', 'build')]), criterion('build', 'build'))
    expect(verdict?.result.detail).toBe('"run checks" could not run: no shell')
  })
})

describe('scope verdicts', () => {
  it('passes when every changed scope is inside the expected paths', async () => {
    const { verifier } = await setup({ verifiers: { diff: { expectedPaths: ['src/**'] } } })
    const verdict = await verifier.verify(
      request([criterion('diff', 'diff')], ['src/a.ts', 'src/nested/b.ts']),
      criterion('diff', 'diff'),
    )
    expect(verdict).toEqual({
      result: {
        criterionId: 'diff',
        status: 'pass',
        evidence: ['src/a.ts', 'src/nested/b.ts'],
        detail: 'every changed scope matches the expected paths (src/**)',
      },
    })
  })

  it('fails and names only the scopes outside the expected paths', async () => {
    const { verifier } = await setup({ verifiers: { diff: { expectedPaths: ['src/**'] } } })
    const verdict = await verifier.verify(
      request([criterion('diff', 'diff')], ['src/a.ts', 'handbook/b.md', 'README.md']),
      criterion('diff', 'diff'),
    )
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.evidence).toEqual(['handbook/b.md', 'README.md'])
    expect(verdict?.result.detail).toBe('changed outside the expected paths (src/**): handbook/b.md, README.md')
  })

  it('passes a scope criterion when the task changed nothing', async () => {
    const { verifier } = await setup({ verifiers: { diff: { expectedPaths: ['src/**'] } } })
    const verdict = await verifier.verify(request([criterion('diff', 'diff')]), criterion('diff', 'diff'))
    expect(verdict?.result.status).toBe('pass')
    expect(verdict?.result.evidence).toEqual([])
    expect(verdict?.result.detail).toBe('the task changed no scope, which the expected paths (src/**) admit')
  })
})

describe('contract verdicts', () => {
  /** The verifier of a deployment that holds the `change-boundary` criterion to the task's own contract. */
  async function boundaryVerifier(): Promise<CommandCriterionVerifier> {
    const { verifier } = await setup({ verifiers: { 'change-boundary': { contract: true } } })
    return verifier
  }

  it('passes a change that stayed inside the declared contract', async () => {
    const verifier = await boundaryVerifier()
    const declared = contract({
      expectedFiles: ['src/a.ts'],
      allowedFiles: ['src/**'],
      expectedTests: ['src/a.spec.ts'],
    })
    const verdict = await verifier.verify(
      request([criterion('change-boundary', 'diff')], ['src/a.ts', 'src/a.spec.ts', 'src\\nested\\b.ts'], declared),
      criterion('change-boundary', 'diff'),
    )
    expect(verdict).toEqual({
      result: {
        criterionId: 'change-boundary',
        status: 'pass',
        evidence: ['src/a.ts', 'src/a.spec.ts', 'src/nested/b.ts'],
        detail: 'every changed scope stayed inside the change contract "extract the boundary check"',
      },
    })
  })

  it('fails a change that touched a forbidden path, naming the path and the bound', async () => {
    const verifier = await boundaryVerifier()
    const declared = contract({ forbiddenChanges: ['handbook/api/**'] })
    const verdict = await verifier.verify(
      request([criterion('change-boundary', 'diff')], ['src/a.ts', 'handbook/api/reference.md', 'handbook/api/x.md'], declared),
      criterion('change-boundary', 'diff'),
    )
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.evidence).toEqual(['handbook/api/reference.md', 'handbook/api/x.md'])
    expect(verdict?.result.detail).toBe('changed a forbidden path (handbook/api/**): handbook/api/reference.md, handbook/api/x.md')
  })

  it('fails a change that modified a path the contract must preserve', async () => {
    const verifier = await boundaryVerifier()
    const declared = contract({ mustPreserve: ['packages/api/src/public.ts'] })
    const verdict = await verifier.verify(
      request([criterion('change-boundary', 'diff')], ['packages/api/src/public.ts'], declared),
      criterion('change-boundary', 'diff'),
    )
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.evidence).toEqual(['packages/api/src/public.ts'])
    expect(verdict?.result.detail).toBe('changed a path the contract must preserve (packages/api/src/public.ts): packages/api/src/public.ts')
  })

  it('reports every broken bound in one verdict', async () => {
    const verifier = await boundaryVerifier()
    const declared = contract({
      expectedFiles: ['src/a.ts'],
      allowedFiles: ['src/**'],
      expectedTests: ['src/a.spec.ts'],
    })
    const verdict = await verifier.verify(
      request([criterion('change-boundary', 'diff')], ['handbook/guide.md'], declared),
      criterion('change-boundary', 'diff'),
    )
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.evidence).toEqual(['handbook/guide.md'])
    expect(verdict?.result.detail).toBe(
      'changed none of the expected files (src/a.ts): src/a.ts'
      + '; changed none of the expected tests (src/a.spec.ts): src/a.spec.ts'
      + '; changed outside the allowed files (src/**): handbook/guide.md',
    )
  })

  it('passes a contract that declares no bound, which admits every changed scope', async () => {
    const verifier = await boundaryVerifier()
    const verdict = await verifier.verify(
      request([criterion('change-boundary', 'diff')], ['anything/at/all.ts'], contract()),
      criterion('change-boundary', 'diff'),
    )
    expect(verdict?.result.status).toBe('pass')
    expect(verdict?.result.detail).toBe('the change contract "extract the boundary check" declares no bound, which every changed scope admits')
  })

  it('fails a claimed criterion whose task declared no contract', async () => {
    const verifier = await boundaryVerifier()
    const verdict = await verifier.verify(
      request([criterion('change-boundary', 'diff')], ['src/a.ts']),
      criterion('change-boundary', 'diff'),
    )
    expect(verdict?.result.status).toBe('fail')
    expect(verdict?.result.evidence).toEqual([])
    expect(verdict?.result.detail).toBe('the target "change-boundary" decides this criterion by the change contract, and the task declared none')
  })
})

describe('kernel registration', () => {
  it('contributes its verdict to the kernel gate and is removed when the plugin unloads', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(StubExecutor)
    await ctx.plugin(AgentKernel, {})
    const fiber = await ctx.plugin({ name, apply, inject: ['agentKernel'] }, { verifiers: { build: entry() } })
    const criteria = [criterion('build', 'build')]
    expect(await ctx.agentKernel.verifiers.collect(request(criteria))).toEqual({
      results: [{ criterionId: 'build', status: 'pass', evidence: ['.'], detail: 'exit code 0 (expected exit 0)' }],
      commands: ['run checks'],
    })
    await fiber.dispose()
    // The kernel's criterion cache answers a repository state it already
    // decided, so the unload is observed against a changed one: nothing is
    // registered for it any more.
    expect(await ctx.agentKernel.verifiers.collect(request(criteria, [], undefined, 'digest-after-unload')))
      .toEqual({ results: [], commands: [] })
  })

  it('blocks a required criterion through the kernel gate when the change left the declared contract', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(StubExecutor)
    await ctx.plugin(AgentKernel, {})
    await ctx.plugin({ name, apply, inject: ['agentKernel'] }, { verifiers: { 'change-boundary': { contract: true } } })
    const criteria = [criterion('change-boundary', 'diff')]
    const declared = contract({ allowedFiles: ['src/**'] })
    expect(await ctx.agentKernel.verifiers.collect(request(criteria, ['handbook/guide.md'], declared))).toEqual({
      results: [{
        criterionId: 'change-boundary',
        status: 'fail',
        evidence: ['handbook/guide.md'],
        detail: 'changed outside the allowed files (src/**): handbook/guide.md',
      }],
      commands: [],
    })
  })

  it('blocks a change outside the declared contract through the kernel gate', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    await ctx.plugin(StubExecutor)
    await ctx.plugin(AgentKernel, {})
    await ctx.plugin({ name, apply, inject: ['agentKernel'] }, { verifiers: { 'change-boundary': { contract: true } } })
    const agent = await harness.create(SessionId('contract-agent'), {}, { cwd: process.cwd() })
    ctx.agentKernel.intake(agent, {
      objective: 'extract the boundary check',
      agentProfile: 'default',
      acceptance: [criterion('change-boundary', 'diff')],
      changeContract: contract({ allowedFiles: ['src/**'] }),
    })

    const decision = await ctx.agentKernel.verify(agent, ['handbook/guide.md'])

    expect(decision?.allowed).toBe(false)
    expect(decision?.reasons.join('; ')).toContain('change-boundary')
  })
})
