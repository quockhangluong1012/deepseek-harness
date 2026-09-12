import { describe, expect, it } from 'vitest'
import type { ShellExecRequest, ShellExecSpec, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SkillDefinition } from '@deepseek-ai/dsh-skill'
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_SHELL_OUTPUT_CHARS,
  renderSkillBody,
  resolveSkillLoad,
  type SkillLoadRequest,
  type SkillLoadSpec,
} from '../src/load.ts'

function skill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'demo',
    description: 'Demo skill',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-dsh',
    provider: 'filesystem',
    content: 'demo body',
    ...overrides,
  }
}

function resolved(request: SkillLoadRequest): SkillLoadSpec {
  const resolution = resolveSkillLoad(request)
  if (!resolution.ok) throw new Error(`expected a resolved spec: ${resolution.error}`)
  return resolution.spec
}

function runResult(stdout: string, overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 10_000,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

/** A scriptable `ctx.shell` stand-in: records requests and replays queued results. */
function fakeShell(results: ShellRunResult[] = [], error?: Error): {
  with: Pick<ShellExecutor, 'resolve' | 'run'>
  requests: ShellExecRequest[]
  specs: ShellExecSpec[]
} {
  const requests: ShellExecRequest[] = []
  const specs: ShellExecSpec[] = []
  return {
    requests,
    specs,
    with: {
      resolve(request: ShellExecRequest): ShellExecSpec {
        requests.push(request)
        return {
          command: request.command,
          workdir: request.workdir ?? '/work',
          timeoutMs: request.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS,
          stdoutMaxBytes: request.stdoutMaxBytes ?? MAX_SHELL_OUTPUT_CHARS,
          sandboxPolicy: request.sandboxPolicy,
          ...request.env === undefined ? {} : { env: request.env },
        }
      },
      async run(spec: ShellExecSpec): Promise<ShellRunResult> {
        specs.push(spec)
        if (error !== undefined) throw error
        return results.shift() ?? runResult('')
      },
    },
  }
}

describe('resolveSkillLoad', () => {
  it('forwards declared environment variables from the host environment', () => {
    const spec = resolved({
      skill: skill({ requiredEnv: ['DSH_LOAD_TOKEN', 'DSH_LOAD_BASE'] }),
      env: { DSH_LOAD_TOKEN: 's3cret', DSH_LOAD_BASE: 'https://example.test', UNRELATED: 'ignored' },
    })
    expect(spec.env).toEqual({ DSH_LOAD_TOKEN: 's3cret', DSH_LOAD_BASE: 'https://example.test' })
  })

  it('fails the load when a declared environment variable is unset or empty', () => {
    for (const env of [{}, { DSH_LOAD_TOKEN: '' }]) {
      const resolution = resolveSkillLoad({ skill: skill({ requiredEnv: ['DSH_LOAD_TOKEN'] }), env })
      expect(resolution.ok).toBe(false)
      if (resolution.ok) throw new Error('expected a load error')
      expect(resolution.error).toBe(
        'skill "demo" requires environment variable "DSH_LOAD_TOKEN", which the host environment does not set',
      )
    }
  })

  it('injects the deployed configuration value over the skill default', () => {
    const spec = resolved({
      skill: skill({ config: { region: 'eu-west-1', retries: '3' } }),
      skillsConfig: { demo: { region: 'us-east-1' } },
    })
    expect(spec.config).toEqual({ region: 'us-east-1', retries: '3' })
  })

  it('falls back to the skill default when the deployment declares no value', () => {
    const withoutDeployment = resolved({ skill: skill({ config: { region: 'eu-west-1' } }) })
    expect(withoutDeployment.config).toEqual({ region: 'eu-west-1' })

    const blankDeployment = resolved({
      skill: skill({ config: { region: 'eu-west-1' } }),
      skillsConfig: { demo: { region: '   ' }, other: { ignored: 'x' } },
    })
    expect(blankDeployment.config).toEqual({ region: 'eu-west-1' })
  })

  it('fails the load when a declared configuration key has no value', () => {
    const own = resolveSkillLoad({ skill: skill({ config: { region: '' } }) })
    expect(own.ok).toBe(false)
    if (own.ok) throw new Error('expected a load error')
    expect(own.error).toBe(
      'skill "demo" requires configuration "region", which neither skills.config nor the skill\'s own defaults provide',
    )

    const deployed = resolveSkillLoad({ skill: skill(), skillsConfig: { demo: { endpoint: '' } } })
    expect(deployed.ok).toBe(false)
    if (deployed.ok) throw new Error('expected a load error')
    expect(deployed.error).toContain('"endpoint"')
  })

  it('reads configuration and no inline shell from an undeclared metadata object', () => {
    const spec = resolved({ skill: skill({ metadata: { owner: 'tests' } }) })
    expect(spec.config).toEqual({})
    expect(spec.shell).toEqual({ enabled: false, timeoutMs: DEFAULT_SHELL_TIMEOUT_MS })
  })

  it('enables inline shell with the declared timeout', () => {
    const spec = resolved({ skill: skill({ metadata: { shell: true, shellTimeoutMs: 2_500 } }) })
    expect(spec.shell).toEqual({ enabled: true, timeoutMs: 2_500 })
  })

  it('rejects malformed inline shell metadata', () => {
    const malformed: Array<readonly [unknown, string]> = [
      ['yes', 'metadata.shell must be a boolean'],
      [1, 'metadata.shell must be a boolean'],
    ]
    for (const [shell, expected] of malformed) {
      const resolution = resolveSkillLoad({ skill: skill({ metadata: { shell } }) })
      expect(resolution.ok).toBe(false)
      if (resolution.ok) throw new Error('expected a load error')
      expect(resolution.error).toBe(`skill "demo" ${expected}`)
    }
    for (const shellTimeoutMs of ['5000', 0, -1, 1.5]) {
      const resolution = resolveSkillLoad({ skill: skill({ metadata: { shell: true, shellTimeoutMs } }) })
      expect(resolution.ok).toBe(false)
      if (resolution.ok) throw new Error('expected a load error')
      expect(resolution.error).toBe('skill "demo" metadata.shellTimeoutMs must be a positive integer')
    }
  })
})

describe('renderSkillBody', () => {
  it('expands reserved variables and config values, leaving undeclared placeholders verbatim', async () => {
    const spec = resolved({ skill: skill({ content: 'dir=${DSH_SKILL_DIR} session=${DSH_SESSION_ID} region=${region} other=${OTHER} empty=${}', config: { region: 'eu-west-1' } }) })
    const body = await renderSkillBody({
      spec,
      skillDir: '/skills/demo',
      sessionId: 'session-7',
      warn: () => {},
    })
    expect(body).toBe('dir=/skills/demo session=session-7 region=eu-west-1 other=${OTHER} empty=${}')
  })

  it('runs a placeholder as a shell command only when the skill opted in', async () => {
    const inline = resolved({
      skill: skill({ metadata: { shell: true }, content: 'host=${hostname}' }),
    })
    const shell = fakeShell([runResult('build-01\n')])
    expect(await renderSkillBody({ spec: inline, shell: shell.with, warn: () => {} })).toBe('host=build-01')
    expect(shell.requests).toEqual([{
      command: 'hostname',
      timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      stdoutMaxBytes: MAX_SHELL_OUTPUT_CHARS * 4,
      env: {},
    }])

    const refused = fakeShell()
    const plain = resolved({ skill: skill({ content: 'host=${hostname}' }) })
    expect(await renderSkillBody({ spec: plain, shell: refused.with, warn: () => {} })).toBe('host=${hostname}')
    expect(refused.requests).toEqual([])
  })

  it('resolves a config key before treating a placeholder as a command', async () => {
    const spec = resolved({ skill: skill({ metadata: { shell: true }, content: 'region=${region}', config: { region: 'eu-west-1' } }) })
    const shell = fakeShell()
    expect(await renderSkillBody({ spec, shell: shell.with, warn: () => {} })).toBe('region=eu-west-1')
    expect(shell.requests).toEqual([])
  })

  it('runs each distinct command once with the skill environment and working directory', async () => {
    const spec = resolved({
      skill: skill({ metadata: { shell: true }, content: 'a=${pwd} b=${pwd}', requiredEnv: ['DSH_LOAD_TOKEN'], config: { region: 'eu-west-1' } }),
      env: { DSH_LOAD_TOKEN: 's3cret' },
    })
    const shell = fakeShell([runResult('/skills/demo')])
    const signal = new AbortController().signal
    expect(await renderSkillBody({ spec, skillDir: '/skills/demo', signal, shell: shell.with, warn: () => {} })).toBe('a=/skills/demo b=/skills/demo')
    expect(shell.requests).toEqual([{
      command: 'pwd',
      workdir: '/skills/demo',
      timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
      stdoutMaxBytes: MAX_SHELL_OUTPUT_CHARS * 4,
      signal,
      env: { DSH_LOAD_TOKEN: 's3cret', region: 'eu-west-1' },
    }])
  })

  it('caps inline shell output at the documented character budget', async () => {
    const spec = resolved({ skill: skill({ metadata: { shell: true }, content: '${cmd}' }) })
    const shell = fakeShell([runResult(`${'x'.repeat(MAX_SHELL_OUTPUT_CHARS)}tail`)])
    const body = await renderSkillBody({ spec, shell: shell.with, warn: () => {} })
    expect(body).toHaveLength(MAX_SHELL_OUTPUT_CHARS)
    expect(body).toBe('x'.repeat(MAX_SHELL_OUTPUT_CHARS))
  })

  it('does not split a surrogate pair at the character cap', async () => {
    const spec = resolved({ skill: skill({ metadata: { shell: true }, content: '${cmd}' }) })
    const shell = fakeShell([runResult(`${'x'.repeat(MAX_SHELL_OUTPUT_CHARS - 1)}😀tail`)])
    const body = await renderSkillBody({ spec, shell: shell.with, warn: () => {} })
    expect(body).toBe('x'.repeat(MAX_SHELL_OUTPUT_CHARS - 1))
  })

  it('renders every inline shell failure as empty and warns', async () => {
    const failures: readonly [ShellRunResult, string][] = [
      [runResult('partial', { exitCode: 2 }), 'inline shell command failed'],
      [runResult('partial', { exitCode: null, timedOut: true }), 'inline shell command failed'],
      [runResult('partial', { exitCode: null, aborted: true }), 'inline shell command failed'],
    ]
    for (const [result, expected] of failures) {
      const warnings: string[] = []
      const spec = resolved({ skill: skill({ metadata: { shell: true }, content: '[${cmd}]' }) })
      const shell = fakeShell([result])
      expect(await renderSkillBody({ spec, shell: shell.with, warn: message => warnings.push(message) })).toBe('[]')
      expect(warnings).toEqual([`skill "demo" ${expected}: cmd`])
    }

    const rejection = fakeShell([], new Error('executor down'))
    const warnings: string[] = []
    const spec = resolved({ skill: skill({ metadata: { shell: true }, content: '${cmd}' }) })
    expect(await renderSkillBody({ spec, shell: rejection.with, warn: message => warnings.push(message) })).toBe('')
    expect(warnings).toEqual(['skill "demo" inline shell command failed: cmd: Error: executor down'])
  })

  it('warns and renders empty when no shell executor is mounted', async () => {
    const spec = resolved({ skill: skill({ metadata: { shell: true }, content: 'x=${cmd}' }) })
    const warnings: string[] = []
    expect(await renderSkillBody({ spec, warn: message => warnings.push(message) })).toBe('x=')
    expect(warnings).toEqual(['skill "demo" inline shell is unavailable: no shell executor is mounted'])
  })
})
