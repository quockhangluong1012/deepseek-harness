// Real Loader composition: the controller is booted from a test-only
// cordis.yml through the real Loader, its two tools become model-visible, a
// research task's run is durable, and the caps the yml configures are the caps
// the tools enforce.
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
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import ResearchController from '@deepseek-ai/dsh-research-controller'
import * as ResearchControllerPlugin from '@deepseek-ai/dsh-research-controller'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The in-memory storage backend plugin the yml mounts as a test-only row. */
const memoryBackend = {
  name: 'test-memory-backend',
  inject: ['storage'],
  apply(ctx: Context) {
    const backend = new MemoryStorageBackend()
    ctx.effect(() => {
      const unregister = ctx.storage.backend.register('memory', backend)
      return async () => {
        unregister()
        await backend.close()
      }
    })
    ctx.provide(storageBackendServiceKey('memory'), backend)
  },
}

/** A registered agent over a real Session, without the loop. */
async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('research-loader')
  const session = Session.create(id)
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

/** Call one registered tool through the real registry pipeline. */
function call(ctx: Context, agent: Agent, args: Record<string, unknown>, callId: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'research_advance',
    arguments: args,
    agent,
  })
}

/** Read one tool result's model-facing text. */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml mounting the controller over a memory storage domain.
 * @param caps - the controller's `config:` lines, as YAML.
 * @returns the booted context.
 */
async function boot(caps: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-research-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@test/memory-backend'",
    "- name: '@deepseek-ai/dsh-storage-domain'",
    "  config: { backend: 'memory' }",
    "- name: '@deepseek-ai/dsh-agent-kernel'",
    "  config: { mode: 'shadow' }",
    "- name: '@deepseek-ai/dsh-research-controller'",
    '  config:',
    ...caps,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-storage', Storage],
    ['@test/memory-backend', memoryBackend],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-agent-kernel', AgentKernel],
    ['@deepseek-ai/dsh-research-controller', ResearchControllerPlugin],
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
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

const CAPS = ['    maxTextBytes: 64', '    maxItems: 2', '    maxRuns: 1']

describe('research controller real Loader composition through cordis.yml', () => {
  it('mounts the controller, makes both tools model-visible, and records a durable run', async () => {
    const ctx = await boot(CAPS)
    expect(ctx.get('research')).toBeInstanceOf(ResearchController)
    const schemas = ctx.tools.schemas()
    expect(schemas.map(schema => schema.name).filter(name => name.startsWith('research_'))).toEqual(['research_advance', 'research_state'])
    expect(schemas.find(schema => schema.name === 'research_advance')?.description)
      .toContain('Epistemic review accepts the run only when every claim is stated in one of the six buckets')
    expect(schemas.find(schema => schema.name === 'research_advance')?.parameters).toMatchObject({
      properties: { stage: { enum: ['question', 'decompose', 'research-plan', 'search', 'source-triage', 'claim-extraction', 'evidence', 'contradiction-search', 'synthesis', 'epistemic-review'] } },
    })

    const owner = await agent(ctx)
    const untasked = await call(ctx, owner, { stage: 'question', items: ['Does clause 4 hold?'] }, 'untasked')
    expect(untasked.isError).toBe(true)
    expect(text(untasked)).toContain('has no kernel task')

    ctx.agentKernel.intake(owner, { objective: 'answer the question', agentProfile: 'default', taskClass: 'research' })
    const started = await call(ctx, owner, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q')
    expect(started.isError).toBe(false)
    expect(text(started)).toContain('(1/10 stages produced)')
    const open = await call(ctx, owner, { stage: 'research-plan', items: ['Read the specification'] }, 'order')
    expect(open.isError).toBe(true)
    expect(text(open)).toContain('is at stage "decompose"')

    const run = ctx.research.state(owner)
    expect(run?.taskClass).toBe('research')
    expect(run?.stages).toHaveLength(10)
    expect(run?.stages[0]?.output).toEqual(['Does clause 4 hold?'])
  }, 30_000)

  it('enforces the caps the yml configures, and fails loud without a stage provider', async () => {
    const ctx = await boot(['    maxTextBytes: 64', '    maxItems: 1', '    maxRuns: 1'])
    const owner = await agent(ctx)
    ctx.agentKernel.intake(owner, { objective: 'answer the question', agentProfile: 'default', taskClass: 'research' })
    expect((await call(ctx, owner, { stage: 'question', items: ['Does clause 4 hold?'] }, 'q')).isError).toBe(false)

    const overCap = await call(ctx, owner, { stage: 'decompose', items: ['Which clause applies?', 'Which revision?'] }, 'd')
    expect(overCap.isError).toBe(true)
    expect(text(overCap)).toContain('holds 2 items, over the configured cap of 1')

    expect((await call(ctx, owner, { stage: 'decompose', items: ['Which clause applies?'] }, 'd2')).isError).toBe(false)
    expect((await call(ctx, owner, { stage: 'research-plan', items: ['Read the specification'] }, 'p')).isError).toBe(false)
    const noProvider = await call(ctx, owner, { stage: 'search' }, 's')
    expect(noProvider.isError).toBe(true)
    expect(text(noProvider)).toContain('no provider is registered for the "search" stage')
  }, 30_000)
})
