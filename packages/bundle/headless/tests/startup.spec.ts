/**
 * The one-shot app's ordinary command-line provider over a real Loader tree:
 * the task, exact Session identity, and output mode become injected runner
 * config, while help and interactive usage errors leave the consumer pending.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { internals as cmdlineInternals, provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import {
  apply,
  HEADLESS_STARTUP_SERVICE,
  type HeadlessStartupValues,
} from '../src/startup.ts'
import { internals as startupInternals } from '../src/startup-internals.ts'

/** What one boot of the fixture tree observed. */
interface Observed {
  exits: number[]
  out: string
  err: string
  runnerConfig?: unknown
}

const disposers: (() => Promise<void>)[] = []

/** The real process facts captured before any test substitutes them. */
const originalInternals = { ...startupInternals }

/** Fixture tree roots, removed after their booted tree has been disposed. */
const tempDirs: string[] = []

/** Write one file outside the fixture tree and register its directory for cleanup. */
function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-schema-'))
  tempDirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, content)
  return path
}

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cmdlineInternals.stdout = process.stdout
  cmdlineInternals.stderr = process.stderr
  startupInternals.stdinIsTty = () => process.stdin.isTTY
  startupInternals.stdout = process.stdout
})

/**
 * Mount the real provider over a runner stand-in.
 * @param args - the invocation's inner arguments.
 * @param options - process facts the provider reads.
 * @returns the resolved service value and observed runner/process effects.
 */
async function bootStartup(
  args: string[],
  options: { stdinIsTty?: boolean } = {},
): Promise<{ task: HeadlessStartupValues | undefined; observed: Observed }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-headless-startup-'))
  tempDirs.push(dir)
  const observed: Observed = { exits: [], out: '', err: '' }
  writeFileSync(join(dir, 'row.mjs'), 'export function apply(_ctx, config) { globalThis.__headlessStartupObserved.runnerConfig = config }\n')
  // Loader imports through Node's resolver, so this fixture delegates to the
  // source-plane plugin already imported by the test.
  writeFileSync(join(dir, 'startup.mjs'), `
export const name = 'headless-startup'
export const inject = ['cmdlineArgs']
export const apply = ctx => globalThis.__headlessStartupApply(ctx)
`)
  const rowUrl = pathToFileURL(join(dir, 'row.mjs')).href
  writeFileSync(join(dir, 'cordis.yml'), [
    '- id: headless-runner',
    `  name: ${rowUrl}`,
    `  inject: [${HEADLESS_STARTUP_SERVICE}]`,
    '  config:',
    '    task: !!js ctx.headlessStartup.task',
    '    sessionId: !!js ctx.headlessStartup.sessionId',
    '    json: !!js ctx.headlessStartup.json',
    '    continueLatest: !!js ctx.headlessStartup.continueLatest',
    '    model: !!js ctx.headlessStartup.model',
    '    permissionMode: !!js ctx.headlessStartup.permissionMode',
    '    maxTurns: !!js ctx.headlessStartup.maxTurns',
    '    systemPrompt: !!js ctx.headlessStartup.systemPrompt',
    '    allowedTools: !!js ctx.headlessStartup.allowedTools',
    '    outputSchema: !!js ctx.headlessStartup.outputSchema',
    '- id: headless-startup',
    `  name: ${pathToFileURL(join(dir, 'startup.mjs')).href}`,
    '',
  ].join('\n'))
  const observing = { write: (chunk: string) => { observed.out += chunk; return true } }
  // Commander's own output keeps landing in `out` so existing assertions see
  // the full transcript, while `err` isolates what stderr actually carried.
  const observingErr = {
    write: (chunk: string) => {
      observed.out += chunk
      observed.err += chunk
      return true
    },
  }
  cmdlineInternals.stdout = observing
  cmdlineInternals.stderr = observingErr
  startupInternals.stdinIsTty = () => options.stdinIsTty === true
  startupInternals.stdout = observing
  const globals = globalThis as unknown as {
    __headlessStartupApply: typeof apply
    __headlessStartupObserved: Observed
  }
  globals.__headlessStartupApply = apply
  globals.__headlessStartupObserved = observed

  const ctx = new Context()
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  provideCmdline(ctx, { args, exit: code => void observed.exits.push(code) })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(join(dir, 'cordis.yml')).href } })
  await ctx.loader.await()
  disposers.push(async () => { await ctx.fiber.dispose() })
  return {
    task: ctx.get(HEADLESS_STARTUP_SERVICE) as HeadlessStartupValues | undefined,
    observed,
  }
}

describe('headless command-line provider', () => {
  it('joins the task positional into the runner config', async () => {
    const { task, observed } = await bootStartup(['run', 'the', 'tests'])
    expect(task).toEqual({ task: 'run the tests', sessionId: undefined, json: false })
    expect(observed.runnerConfig).toMatchObject({ task: 'run the tests', json: false })
    expect(observed.exits).toEqual([])
  })

  it('publishes the machine-readable output mode and the exact Session identity', async () => {
    const { task, observed } = await bootStartup(['--json', '--session-id', 'session-exact', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: 'session-exact', json: true })
    expect(observed.runnerConfig).toMatchObject({ task: 'do it', sessionId: 'session-exact', json: true })
  })

  it('keeps the stdin marker as the task so the runner reads the pipe', async () => {
    const { task } = await bootStartup(['-'], { stdinIsTty: false })
    expect(task).toEqual({ task: '-', sessionId: undefined, json: false })
  })

  it('defers an absent task to stdin when stdin is not a terminal', async () => {
    const { task, observed } = await bootStartup([], { stdinIsTty: false })
    expect(task).toEqual({ task: undefined, sessionId: undefined, json: false })
    expect(observed.runnerConfig).toMatchObject({ json: false })
  })

  it.each([{ args: [] as string[] }, { args: ['   '] }])('rejects an interactive invocation with no task ($args)', async ({ args }) => {
    const { task, observed } = await bootStartup(args, { stdinIsTty: true })
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects an explicitly empty Session identity', async () => {
    const { task, observed } = await bootStartup(['--session-id', '', 'do', 'it'])
    expect(observed.out).toContain('--session-id requires a non-empty session id')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('keeps the caller-provided exact Session identity verbatim', async () => {
    const { task } = await bootStartup(['--session-id', ' session-x ', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: ' session-x ', json: false })
  })

  it('rejects a lone stdin marker mixed with other task words', async () => {
    const { task, observed } = await bootStartup(['-', 'do', 'it'])
    expect(observed.out).toContain('`-` must be the only task argument')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('writes the JSON error event for a --json usage error', async () => {
    const { task, observed } = await bootStartup(['--json'], { stdinIsTty: true })
    const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
    expect(first).toEqual({
      type: 'error',
      message: 'a task is required, for example: dsh --profile headless "run the tests"',
    })
    expect(task).toBeUndefined()
    expect(observed.err).toBe('')
    expect(observed.exits).toEqual([1])
  })

  it('writes the JSON error event for an empty Session identity in --json mode', async () => {
    const { observed } = await bootStartup(['--json', '--session-id', '', 'do', 'it'])
    const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
    expect(first.type).toBe('error')
    expect(first.message).toContain('--session-id requires a non-empty session id')
    expect(observed.err).toBe('')
    expect(observed.exits).toEqual([1])
  })

  it('writes the JSON error event for a commander grammar rejection in --json mode', async () => {
    const { task, observed } = await bootStartup(['--json', '--bogus', 'do', 'it'])
    const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
    expect(first).toEqual({ type: 'error', message: "unknown option '--bogus'" })
    expect(task).toBeUndefined()
    expect(observed.err).toBe('')
    expect(observed.exits).toEqual([1])
  })

  it('does not install the JSON error override for a --json option value', async () => {
    const { observed } = await bootStartup(['--session-id', '--json'], { stdinIsTty: true })
    expect(observed.out).toContain('a task is required')
    expect(observed.out).not.toContain('"type":"error"')
    expect(observed.exits).toEqual([1])
  })

  it('does not install the JSON error override for a --json positional after --', async () => {
    const { task, observed } = await bootStartup(['--', '--json'], { stdinIsTty: false })
    expect(task).toEqual({ task: '--json', sessionId: undefined, json: false })
    expect(observed.out).not.toContain('"type":"error"')
  })

  it('rejects a blank positional task instead of reading stdin', async () => {
    const { task, observed } = await bootStartup(['   '], { stdinIsTty: false })
    expect(observed.out).toContain('a task is required')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('reports the real process stdin terminal state by default', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin')
    Object.defineProperty(process, 'stdin', { value: { isTTY: true }, configurable: true })
    try {
      expect(originalInternals.stdinIsTty()).toBe(true)
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'stdin', original)
    }
  })

  it('fails loud without the launcher command line and exit request', () => {
    expect(() => { apply(new Context()) }).toThrow('the launcher must provide ctx.cmdlineArgs and ctx.appExit')
  })

  it('publishes the model override for the runner', async () => {
    const { task, observed } = await bootStartup(['--model', 'deepseek-flash', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: undefined, json: false, model: 'deepseek-flash' })
    expect(observed.runnerConfig).toMatchObject({ model: 'deepseek-flash' })
    expect(observed.exits).toEqual([])
  })

  it.each([[''], ['   '], ['two words']])('rejects an unusable --model value (%s)', async (model) => {
    const { task, observed } = await bootStartup(['--model', model, 'do', 'it'])
    expect(observed.out).toContain('--model')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('publishes the permission preset the run pins', async () => {
    const { task, observed } = await bootStartup(['--permission-mode', 'read-only', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: undefined, json: false, permissionMode: 'read-only' })
    expect(observed.runnerConfig).toMatchObject({ permissionMode: 'read-only' })
  })

  it.each([[''], ['read only'], ['a,b']])('rejects an unusable --permission-mode value (%s)', async (mode) => {
    const { task, observed } = await bootStartup(['--permission-mode', mode, 'do', 'it'])
    expect(observed.out).toContain('--permission-mode')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('publishes the step ceiling as a number', async () => {
    const { task, observed } = await bootStartup(['--max-turns', '3', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: undefined, json: false, maxTurns: 3 })
    expect(observed.runnerConfig).toMatchObject({ maxTurns: 3 })
  })

  it.each([['0'], ['-1'], ['2.5'], ['many'], ['']])('rejects an unusable --max-turns value (%s)', async (turns) => {
    const { task, observed } = await bootStartup(['--max-turns', turns, 'do', 'it'])
    expect(observed.out).toContain('--max-turns')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('publishes the replacement system prompt verbatim', async () => {
    const prompt = 'You are a CI bot.  Mind the gap.'
    const { task, observed } = await bootStartup(['--system-prompt', prompt, 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: undefined, json: false, systemPrompt: prompt })
    expect(observed.runnerConfig).toMatchObject({ systemPrompt: prompt })
  })

  it.each([[''], ['   ']])('rejects a blank --system-prompt (%s)', async (prompt) => {
    const { task, observed } = await bootStartup(['--system-prompt', prompt, 'do', 'it'])
    expect(observed.out).toContain('--system-prompt requires a non-empty value')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('splits, trims, and deduplicates the --allowed-tools list', async () => {
    const { task, observed } = await bootStartup(['--allowed-tools', 'read, edit,read', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: undefined, json: false, allowedTools: ['read', 'edit'] })
    expect(observed.runnerConfig).toMatchObject({ allowedTools: ['read', 'edit'] })
  })

  it.each([['read,,edit'], [''], ['   ']])('rejects an unusable --allowed-tools list (%s)', async (names) => {
    const { task, observed } = await bootStartup(['--allowed-tools', names, 'do', 'it'])
    expect(observed.out).toContain('--allowed-tools')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('reads and publishes the --output-schema file', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] }
    const { task, observed } = await bootStartup(['--output-schema', tempFile('schema.json', JSON.stringify(schema)), 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: undefined, json: false, outputSchema: schema })
    expect(observed.runnerConfig).toMatchObject({ outputSchema: schema })
  })

  it('rejects a --output-schema path that cannot be read', async () => {
    const { task, observed } = await bootStartup(['--output-schema', join(tmpdir(), 'dsh-headless-absent-schema.json'), 'do', 'it'])
    expect(observed.out).toContain('cannot read --output-schema file')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects a --output-schema file that is not JSON', async () => {
    const { task, observed } = await bootStartup(['--output-schema', tempFile('schema.txt', '{ not json'), 'do', 'it'])
    expect(observed.out).toContain('is not valid JSON')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('rejects a --output-schema file that is not an object-rooted schema', async () => {
    const { task, observed } = await bootStartup(['--output-schema', tempFile('array.json', '{"type":"array"}'), 'do', 'it'])
    expect(observed.out).toContain('schema.type must be "object"')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('adopts the exact Session identity --resume names', async () => {
    const { task, observed } = await bootStartup(['--resume', 'session-recorded', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: 'session-recorded', json: false })
    expect(observed.runnerConfig).toMatchObject({ sessionId: 'session-recorded' })
  })

  it('asks the runner for the newest Session in this directory with --continue', async () => {
    const { task, observed } = await bootStartup(['--continue', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: undefined, json: false, continueLatest: true })
    expect(observed.runnerConfig).toMatchObject({ continueLatest: true })
  })

  it.each([
    { args: ['--session-id', 'session-x', '--resume', 'session-y'] },
    { args: ['--session-id', 'session-x', '--continue'] },
    { args: ['--resume', 'session-y', '--continue'] },
  ])('rejects two Session selectors at once ($args)', async ({ args }) => {
    const { task, observed } = await bootStartup([...args, 'do', 'it'])
    expect(observed.out).toContain('mutually exclusive')
    expect(task).toBeUndefined()
    expect(observed.exits).toEqual([1])
  })

  it('writes the JSON error event for an invalid run-flag value in --json mode', async () => {
    const { observed } = await bootStartup(['--json', '--max-turns', '0', 'do', 'it'])
    const first = JSON.parse(observed.out.trim().split('\n')[0] ?? '{}') as { type: string; message: string }
    expect(first.type).toBe('error')
    expect(first.message).toContain('--max-turns requires a whole number of at least 1')
    expect(observed.err).toBe('')
    expect(observed.exits).toEqual([1])
  })

  it('does not install the JSON error override for a --json option value of a run flag', async () => {
    const { task, observed } = await bootStartup(['--system-prompt', '--json', 'do', 'it'])
    expect(task).toEqual({ task: 'do it', sessionId: undefined, json: false, systemPrompt: '--json' })
    expect(observed.out).not.toContain('"type":"error"')
  })

  it('prints its own help and leaves the runner pending', async () => {
    const { task, observed } = await bootStartup(['--help'])
    expect(observed.out).toContain('dsh --profile headless')
    expect(observed.out).toContain('the answer goes to stdout and diagnostics to stderr')
    expect(observed.out).toContain('--session-id')
    expect(task).toBeUndefined()
    expect(observed.runnerConfig).toBeUndefined()
    expect(observed.exits).toEqual([0])
  })
})
