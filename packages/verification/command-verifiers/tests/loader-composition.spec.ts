// Proves the seam end to end and not as a hand-built context: a test-only
// cordis.yml booted through the real Loader mounts the command verifiers beside
// the kernel and a real bash executor, and the kernel's own completion gate
// then passes a criterion whose command exited 0, fails one whose command
// exited 3, fails one that overran its declared timeout, and decides a diff
// criterion from the changed scopes it was handed. The same composition boots
// the target map the shipped bundles declare, so the row a profile applies is
// the one these cases decide through the gate.
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompletionDecision, CriterionResult } from '@deepseek-ai/dsh-agent-kernel'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as BashLocal from '@deepseek-ai/dsh-bash-local'
import * as AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import * as CommandVerifiers from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot one test-only cordis.yml: the loop prerequisites, the kernel carrying the
 * acceptance criteria under test, a real bash executor rooted at the temporary
 * workspace, and this plugin carrying the verifier targets.
 * @param acceptance - YAML lines declaring the kernel's `acceptance` criteria.
 * @param verifiers - YAML lines declaring the verifier targets.
 * @param options - `scripts` gives the temporary workspace the package.json its
 * commands resolve; `shell: false` mounts no executor, as a deployment that
 * declares only `diff` criteria composes.
 * @returns the booted context.
 */
async function boot(
  acceptance: readonly string[],
  verifiers: readonly string[],
  options: { readonly scripts?: Record<string, string>; readonly shell?: boolean } = {},
): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-command-verifiers-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-kernel'",
    '  config:',
    '    acceptance:',
    ...acceptance,
    ...options.shell === false
      ? []
      : [
        "- name: '@deepseek-ai/dsh-subprocess-local'",
        "- name: '@deepseek-ai/dsh-bash-local'",
        '  config:',
        `    cwd: ${root.replaceAll('\\', '/')}`,
      ],
    "- name: '@deepseek-ai/dsh-command-verifiers'",
    '  config:',
    '    verifiers:',
    ...verifiers,
    '',
  ].join('\n'))

  if (options.scripts !== undefined) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'command-verifier-workspace', private: true, scripts: options.scripts }, null, 2))
  }

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-kernel', AgentKernel],
    ['@deepseek-ai/dsh-subprocess-local', SubprocessLocal],
    ['@deepseek-ai/dsh-bash-local', BashLocal],
    ['@deepseek-ai/dsh-command-verifiers', CommandVerifiers],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/**
 * Register a directly constructed Agent so the kernel has a session to attach a
 * task to.
 * @param ctx - the booted context.
 * @returns the registered Agent.
 */
async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('command-verifiers-agent')
  const value: Agent = {
    id,
    options: {},
    session: ctx.sessions.create(id),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

/**
 * Open the task contract the kernel verifies.
 * @param ctx - the booted context.
 * @param owner - the agent whose session records the task.
 * @returns the agent, after its contract exists.
 */
async function intake(ctx: Context, owner: Agent): Promise<Agent> {
  await ctx.waterfall(
    'agent/pre-step',
    {
      agent: owner,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  return owner
}

/** One acceptance criterion, as the kernel's `acceptance` list declares it. */
function criterion(id: string, verifier: string): readonly string[] {
  return [
    `      - id: ${id}`,
    `        description: ${id}`,
    `        verifier: ${verifier}`,
    '        required: true',
  ]
}

/** Every durable payload of one event type in a session, in log order. */
function eventsOf<T extends keyof SessionEventMap>(owner: Agent, type: T): SessionEventMap[T][] {
  return owner.session.snapshotEvents()
    .filter((event): event is SessionEvent<T> => event.type === type)
    .map(event => event.data)
}

/** The criterion result the kernel's most recent verification recorded. */
function recorded(owner: Agent, criterionId: string): CriterionResult | undefined {
  return eventsOf(owner, 'verification/result').at(-1)?.criterionResults.find(result => result.criterionId === criterionId)
}

/** The bundles whose patch mounts this plugin. */
const BUNDLES = ['agent-governance', 'web-app']

/** One bundle's patch row for this plugin: the config a profile mounts, and the manifest it resolves through. */
interface BundleRow {
  readonly dependencies: Readonly<Record<string, string>>
  readonly verifiers: Readonly<Record<string, {
    readonly command: string
    readonly timeoutMs: number
    readonly expectedExitCodes: readonly number[]
  }>>
}

/** One inserted patch row, as much of it as this suite reads. */
interface InsertedRow {
  readonly id?: string
  readonly name?: string
  readonly config?: { readonly verifiers?: BundleRow['verifiers'] }
}

/** One patch file, as much of it as this suite reads. */
interface PatchEntry {
  readonly insert?: readonly InsertedRow[]
}

/**
 * Read one bundle's patch and manifest: the verifier row it inserts, and the
 * dependencies the row's specifier must resolve through.
 * @param bundle - the bundle directory name.
 * @returns the row's verifier targets and the manifest dependencies.
 */
function bundleRow(bundle: string): BundleRow {
  const dir = fileURLToPath(new URL(`../../../bundle/${bundle}/`, import.meta.url))
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies?: Readonly<Record<string, string>> }
  const entries = yaml.load(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8'), { schema: entryListSchema }) as readonly PatchEntry[]
  const row = entries.flatMap(entry => entry.insert ?? []).find(entry => entry.name === '@deepseek-ai/dsh-command-verifiers')
  expect(row, `${bundle} mounts no command verifier`).toBeDefined()
  return { dependencies: manifest.dependencies ?? {}, verifiers: row!.config?.verifiers ?? {} }
}

/**
 * The bundle's target map as the YAML lines the booted `cordis.yml` declares
 * under its own `verifiers:` key.
 * @param verifiers - the targets the bundle row declares.
 * @returns the indented YAML lines.
 */
function verifierLines(verifiers: BundleRow['verifiers']): string[] {
  return yaml.dump(verifiers, { indent: 2 }).trimEnd().split('\n').map(line => `      ${line}`)
}

/** Every claim the shipped rows cover, in the family order the gate runs them. */
const CLAIMS = ['typecheck', 'lint', 'test']

describe('command verifiers in real Loader composition', () => {
  it('passes a criterion whose configured command exits with an accepted code', async () => {
    const ctx = await boot(
      criterion('fast-check', 'test'),
      [
        '      fast-check:',
        "        command: 'true'",
        '        timeoutMs: 20000',
        '        expectedExitCodes: [0]',
      ],
    )
    const owner = await intake(ctx, await agent(ctx))

    const decision: CompletionDecision | undefined = await ctx.agentKernel.verify(owner)
    expect(decision).toEqual({ allowed: true, reasons: [] })
    expect(recorded(owner, 'fast-check')).toMatchObject({
      status: 'pass',
      evidence: ['.'],
      detail: 'exit code 0 (expected exit 0)',
    })
    expect(eventsOf(owner, 'verification/result').at(-1)?.commands).toEqual(['true'])
  }, 30_000)

  it('fails a criterion whose command exits outside the accepted codes', async () => {
    const ctx = await boot(
      criterion('broken-check', 'build'),
      [
        '      broken-check:',
        "        command: 'echo boom >&2; exit 3'",
        '        timeoutMs: 20000',
        '        expectedExitCodes: [0, 2]',
      ],
    )
    const owner = await intake(ctx, await agent(ctx))

    const decision = await ctx.agentKernel.verify(owner)
    expect(decision?.allowed).toBe(false)
    expect(decision?.reasons).toContain('required criterion "broken-check" is fail')
    expect(recorded(owner, 'broken-check')).toMatchObject({ status: 'fail' })
    const detail = recorded(owner, 'broken-check')?.detail ?? ''
    expect(detail).toContain('exit code 3 (expected exit 0 or 2)')
    expect(detail).toContain('stderr:\nboom')
  }, 30_000)

  it('fails a criterion whose command overruns its timeout instead of hanging', async () => {
    const ctx = await boot(
      criterion('slow-check', 'build'),
      [
        '      slow-check:',
        "        command: 'while true; do :; done'",
        '        timeoutMs: 400',
        '        expectedExitCodes: [0]',
      ],
    )
    const owner = await intake(ctx, await agent(ctx))

    const started = Date.now()
    const decision = await ctx.agentKernel.verify(owner)
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(decision?.allowed).toBe(false)
    expect(recorded(owner, 'slow-check')).toMatchObject({ status: 'fail' })
    expect(recorded(owner, 'slow-check')?.detail).toContain('timed out after 400ms (expected exit 0)')
  }, 30_000)

  it('decides a diff criterion from the changed scopes the kernel was handed', async () => {
    const ctx = await boot(
      criterion('scope-check', 'diff'),
      ['      scope-check:', "        expectedPaths: ['src/**']"],
    )
    const owner = await intake(ctx, await agent(ctx))

    const inside = await ctx.agentKernel.verify(owner, ['src/a.ts'])
    expect(inside?.allowed).toBe(true)
    expect(recorded(owner, 'scope-check')).toMatchObject({
      status: 'pass',
      evidence: ['src/a.ts'],
      detail: 'every changed scope matches the expected paths (src/**)',
    })

    const outside = await ctx.agentKernel.verify(owner, ['handbook/b.md'])
    expect(outside?.allowed).toBe(false)
    expect(outside?.reasons).toContain('required criterion "scope-check" is fail')
    expect(recorded(owner, 'scope-check')).toMatchObject({
      status: 'fail',
      evidence: ['handbook/b.md'],
      detail: 'changed outside the expected paths (src/**): handbook/b.md',
    })
  }, 30_000)

  it('fails the load for a target that could never decide a criterion', async () => {
    const ctx = await boot(criterion('fast-check', 'test'), ['      fast-check:', '        expectedPaths: []'])
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-command-verifiers')
    expect(entry).toBeDefined()
    const message = await entry?.fiber?.await().then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error.message : String(error),
    )
    expect(message).toContain('command-verifiers: target "fast-check" declares neither a command nor a non-empty expectedPaths')
  }, 30_000)
})

describe('the bundle row a profile applies', () => {
  it.each(BUNDLES)('declares %s targets the workspace resolves from its own scripts', (bundle) => {
    const row = bundleRow(bundle)
    const workspace = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> }

    // The Loader resolves this row's specifier through the bundle's own
    // manifest, which is what verify-cordis-config checks for every row.
    expect(row.dependencies).toHaveProperty('@deepseek-ai/dsh-command-verifiers')
    expect(Object.keys(row.verifiers)).toEqual(CLAIMS)
    for (const claim of CLAIMS) {
      expect(row.verifiers[claim]?.command).toBe(`pnpm run ${claim}`)
      expect(workspace.scripts[claim]).toBeDefined()
    }
  })

  it.each(BUNDLES)('registers the %s row, so the gate decides its first claim instead of `unknown`', async (bundle) => {
    const row = bundleRow(bundle)
    // No executor is mounted, so the claim is visible as the verdict this
    // plugin derives rather than as the `unknown` an unclaimed criterion gets.
    const ctx = await boot(
      CLAIMS.flatMap(claim => criterion(claim, claim === 'test' ? 'test' : 'build')),
      verifierLines(row.verifiers),
      { shell: false },
    )
    const owner = await intake(ctx, await agent(ctx))

    const decision = await ctx.agentKernel.verify(owner)
    expect(decision?.allowed).toBe(false)
    expect(recorded(owner, 'typecheck')).toMatchObject({
      status: 'fail',
      detail: 'no shell executor is mounted, so "pnpm run typecheck" did not run',
    })
  }, 30_000)

  it.each(BUNDLES)('completes a task whose criteria the %s commands all pass', async (bundle) => {
    const row = bundleRow(bundle)
    const ctx = await boot(
      CLAIMS.flatMap(claim => criterion(claim, claim === 'test' ? 'test' : 'build')),
      verifierLines(row.verifiers),
      {
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
        },
      },
    )
    const owner = await intake(ctx, await agent(ctx))

    const decision: CompletionDecision | undefined = await ctx.agentKernel.verify(owner)
    expect(decision).toEqual({ allowed: true, reasons: [] })
    expect(CLAIMS.map(claim => recorded(owner, claim)?.status)).toEqual(['pass', 'pass', 'pass'])
    expect([...(eventsOf(owner, 'verification/result').at(-1)?.commands ?? [])].sort())
      .toEqual(['pnpm run lint', 'pnpm run test', 'pnpm run typecheck'])
  }, 60_000)

  it.each(BUNDLES)('fails the %s row on the workspace result and runs no later claim', async (bundle) => {
    const row = bundleRow(bundle)
    const ctx = await boot(
      CLAIMS.flatMap(claim => criterion(claim, claim === 'test' ? 'test' : 'build')),
      verifierLines(row.verifiers),
      {
        scripts: {
          typecheck: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(3)"',
          test: 'node -e "process.exit(0)"',
        },
      },
    )
    const owner = await intake(ctx, await agent(ctx))

    const decision = await ctx.agentKernel.verify(owner)
    expect(decision?.allowed).toBe(false)
    expect(decision?.reasons).toContain('required criterion "lint" is fail')
    expect(recorded(owner, 'typecheck')).toMatchObject({ status: 'pass' })
    expect(recorded(owner, 'lint')).toMatchObject({ status: 'fail' })
    expect(recorded(owner, 'lint')?.detail).toContain('exit code 3 (expected exit 0)')
    // The gate stops at the first failed required criterion, so the family it
    // orders after `build` never ran and reports no result.
    expect(recorded(owner, 'test')).toMatchObject({ status: 'unknown' })
  }, 60_000)
})
