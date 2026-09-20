// Proves the compiler's configuration is real composition and not a constant: a
// cordis.yml booted through the real Loader selects the mode and the token
// ceiling, and an unknown mode fails the load instead of silently recording
// without a ceiling.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as AgentContext from '@deepseek-ai/dsh-agent-context'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Register a directly constructed Agent so the compiler has a session to record against. */
function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('context-loader-agent')
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
  ctx.agents.register(value)
  return value
}

/**
 * Boot a cordis.yml carrying the compiler's config block through the real Loader.
 * @param configLines - YAML lines nested under the compiler entry's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-context-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-context'",
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
    ['@deepseek-ai/dsh-agent-context', AgentContext],
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

describe('agent-context real Loader composition through cordis.yml', () => {
  it('records a placement and leaves the assembly untouched with no configuration', async () => {
    const ctx = await boot([])
    const owner = agent(ctx)
    ctx.systemPrompt.section({ name: 'tool:read', order: 1100, text: 'Read a file.' })

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(owner))
    const record = owner.session.snapshotEvents().find(event => event.type === 'context/compiled')?.data

    expect(assembly.sections.map(section => section.name)).toContain('tool:read')
    expect(record).toMatchObject({ maxTokens: null, compilerVersion: 'agent-context/1' })
  }, 30_000)

  it('applies the configured ceiling and mode to the assembly', async () => {
    const ctx = await boot(['    mode: apply', '    maxContextTokens: 20'])
    const owner = agent(ctx)
    ctx.systemPrompt.section({ name: 'tool:big', order: 1100, text: 'x'.repeat(400) })

    const assembly = await ctx.systemPrompt.assemble(assembleContextFor(owner))
    const record = owner.session.snapshotEvents().find(event => event.type === 'context/compiled')?.data

    expect(assembly.sections.map(section => section.name)).toEqual(['harness:identity'])
    expect(record).toMatchObject({ maxTokens: 20, omitted: [{ id: 'tool:big', reason: 'budget' }] })
  }, 30_000)

  it('fails loading when the mode is not a placement mode', async () => {
    // Stringified rather than matched against the rejection: the Loader wraps
    // the schema error in a Cordis error that vitest cannot pretty-print.
    const failure = await boot(['    mode: enforce']).then(() => '', (error: unknown) => String(error))
    expect(failure).toContain('@deepseek-ai/dsh-agent-context')
    expect(failure).toMatch(/mode/i)
  }, 30_000)
})
