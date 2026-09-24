// Proves the kernel's configuration is real composition and not a constant: a
// cordis.yml booted through the real Loader selects the enforcement mode and the
// permission document, and an invalid document fails the load instead of
// silently admitting every action.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineContentToolFixture, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AgentKernel from '@deepseek-ai/dsh-agent-kernel'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Register a directly constructed Agent so the kernel has a session to attach to. */
async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('kernel-loader-agent')
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
 * Boot a cordis.yml carrying the kernel's config block through the real Loader.
 * @param configLines - YAML lines nested under the kernel entry's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-kernel-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-kernel'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

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

/** The permission document that allows every action. */
const ALLOW_ALL = [
  '    policy:',
  '      defaults:',
  '        effect: allow',
  '      rules: []',
]

describe('agent-kernel real Loader composition through cordis.yml', () => {
  it('admits a declared action in enforce mode and records the durable decision', async () => {
    const ctx = await boot(['    mode: enforce', ...ALLOW_ALL])
    const owner = await agent(ctx)
    ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'probe',
      parameters: {},
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    }))
    ctx.agentKernel.capabilities.register({ tool: 'probe', capabilities: ['fs.read'], resources: () => '**' })

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
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-call'),
      name: 'probe',
      arguments: {},
      agent: owner,
    })

    expect(result.isError).toBe(false)
    const types = owner.session.snapshotEvents().map(event => event.type)
    expect(types).toContain('task/created')
    expect(types).toContain('action/decided')
    expect(types).toContain('action/committed')
    expect(types).not.toContain('action/authorized')
  }, 30_000)

  it('refuses an undeclared tool in enforce mode and leaves its action uncommitted as a failure', async () => {
    const ctx = await boot(['    mode: enforce', ...ALLOW_ALL])
    const owner = await agent(ctx)
    ctx.tools.register(defineContentToolFixture({
      name: 'undeclared',
      description: 'undeclared',
      parameters: {},
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    }))

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
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('loader-denied'),
      name: 'undeclared',
      arguments: {},
      agent: owner,
    })

    expect(result.isError).toBe(true)
    const events = owner.session.snapshotEvents()
    expect(events.find(event => event.type === 'action/decided')).toBeDefined()
    expect(events.find(event => event.type === 'action/committed')?.data).toMatchObject({ outcome: 'denied' })
  }, 30_000)

  it('fails plugin activation for an empty resource selector', async () => {
    const ctx = await boot([
      '    policy:',
      '      defaults:',
      '        effect: allow',
      '      rules:',
      '        - action: read',
      '          resource: ""',
      '          effect: allow',
    ])
    const entry = [...ctx.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-agent-kernel')
    expect(entry).toBeDefined()
    const message = await entry?.fiber?.await().then(
      () => undefined,
      (error: unknown) => error instanceof Error ? error.message : String(error),
    )
    expect(message).toContain('agent-kernel: policy rule 0 declares an empty resource selector')
  }, 30_000)
})
