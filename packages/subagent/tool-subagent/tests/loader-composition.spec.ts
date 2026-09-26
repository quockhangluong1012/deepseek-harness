/**
 * Real Loader composition: a delegation naming a file-defined agent starts the
 * child with that definition's tools and route, and an unknown name fails loud
 * with the available agents.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as llmPlugin from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as sessionPlugin from '@deepseek-ai/dsh-session'
import * as systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'
import * as toolsPlugin from '@deepseek-ai/dsh-tools'
import * as sessionProjectionPlugin from '@deepseek-ai/dsh-session-projection'
import * as subagentPlugin from '@deepseek-ai/dsh-subagent'
import * as toolPlugin from '../src/index.ts'
import * as recordingProvider from './fixtures/recording-provider.ts'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { text } from './harness.ts'

/** The fixture project root, whose `.dsh/agents` directory defines the reviewed agents. */
const fixtureProject = fileURLToPath(new URL('./fixtures/project', import.meta.url))

/** The fixture agent directory the composition searches. */
const fixtureAgentsRoot = join(fixtureProject, '.dsh/agents')

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  recordingProvider.recordedStarts.length = 0
})

/** Boot the test-only composition through the real Loader. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'tool-subagent-agents-'))
  const composition = await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, composition.replace('{{agentsRoot}}', fixtureAgentsRoot.replaceAll('\\', '/')))
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules: Record<string, unknown> = {
    '@deepseek-ai/dsh-llm': llmPlugin,
    '@deepseek-ai/dsh-session': sessionPlugin,
    '@deepseek-ai/dsh-system-prompt': systemPromptPlugin,
    '@deepseek-ai/dsh-tools': toolsPlugin,
    '@deepseek-ai/dsh-session-projection': sessionProjectionPlugin,
    '@deepseek-ai/dsh-subagent': subagentPlugin,
    '@deepseek-ai/dsh-tool-subagent': toolPlugin,
    './fixtures/recording-provider.ts': recordingProvider,
  }
  // The client module host assigns Loader internals the same way; only `import` is exercised here.
  ctx.loader.internal = {
    version: 'v2',
    import: async (specifier: string): Promise<unknown> => {
      if (!Object.hasOwn(modules, specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules[specifier]
    },
  } as never
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  ctx.llm.registerAdapter(['alpha'], new MockAdapter([]))
  return ctx
}

/** One calling Agent whose Session carries the fixture project as its working directory. */
function callingAgent(ctx: Context): Agent {
  const session = ctx.sessions.create(SessionId('file-agent-parent'), { meta: { cwd: fixtureProject } })
  return { id: session.id, session, status: 'idle', ctx } as Agent
}

/** Execute the registered delegation tool for one calling Agent. */
function delegate(ctx: Context, agent: Agent, args: Record<string, unknown>) {
  return ctx.tools.execute({
    name: 'subagent',
    callId: ToolCallId(`file-agent-${String(recordingProvider.recordedStarts.length)}`),
    arguments: args,
    agent,
    signal: new AbortController().signal,
  })
}

describe('file-defined agents through the Loader', () => {
  it('restricts the delegated child to the definition’s tools and route', async () => {
    const ctx = await boot()
    const agent = callingAgent(ctx)
    const result = await delegate(ctx, agent, {
      description: 'review the diff',
      prompt: 'review the diff',
      agent: 'code-reviewer',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('recorded subagent reply')
    expect(recordingProvider.recordedStarts).toHaveLength(1)
    expect(recordingProvider.recordedStarts[0]?.toolFilter).toEqual({ allow: ['read', 'grep', 'bash'], deny: ['edit'] })
    expect(recordingProvider.recordedStarts[0]?.agentOptions).toEqual({ provider: 'alpha', model: 'reviewer-model' })
  })

  it('exposes an optional agent parameter and delegates unchanged without it', async () => {
    const ctx = await boot()
    const agent = callingAgent(ctx)
    const schema = ctx.tools.schemas(agent).find(entry => entry.name === 'subagent')
    expect(schema?.parameters.properties).toHaveProperty('agent')
    // A call that names no agent succeeds, which is the observable form of
    // "`agent` is absent from the schema's required list".
    const result = await delegate(ctx, agent, { description: 'research', prompt: 'research the topic' })
    expect(result.isError).toBe(false)
    expect(recordingProvider.recordedStarts[0]?.toolFilter).toBeUndefined()
    expect(recordingProvider.recordedStarts[0]?.agentOptions).toBeUndefined()
  })

  it('reports the available agents for an unknown name', async () => {
    const ctx = await boot()
    const agent = callingAgent(ctx)
    const result = await delegate(ctx, agent, {
      description: 'review the diff',
      prompt: 'review the diff',
      agent: 'missing',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('subagent agent "missing" is unknown')
    expect(text(result)).toContain('code-reviewer (Reviews a diff for defects)')
    expect(text(result)).toContain('planner')
    expect(text(result)).toContain(fixtureAgentsRoot.replaceAll('\\', '/'))
    expect(recordingProvider.recordedStarts).toEqual([])
  })
})
