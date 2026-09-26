import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import * as fileCommands from '@deepseek-ai/dsh-commands/file-commands'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Minimal global tool: the `allowed-tools` allowlist validates every name against the mounted set. */
function tool(name: string): ToolDefinition {
  return {
    name,
    description: `tool ${name}`,
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value as string }],
    },
    execute: (): Promise<string> => Promise.resolve(name),
  }
}

/** Scripted model route that records what the model-visible prompt actually carried. */
class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** Tool visibility sampled inside the request the command's submission produced. */
  writeVisibleDuringRequest: boolean | undefined

  constructor(private readonly observe: () => boolean) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.writeVisibleDuringRequest = this.observe()
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'deployed' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'deployed' } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Every prompt text the model request carried. */
function requestText(request: GenerateOptions | undefined): string {
  const messages = request?.messages ?? []
  return messages.flatMap(message => message.content
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : ''))
    .join('\n')
}

describe('file-commands real Loader composition', () => {
  it('loads .dsh/commands through cordis.yml and dispatches a file command to the model', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-file-commands-loader-'))
    const commandsDir = join(root, '.dsh/commands')
    await mkdir(commandsDir, { recursive: true })
    await writeFile(join(commandsDir, 'deploy.md'), [
      '---',
      'description: Deploy the service',
      'argument-hint: <environment>',
      'allowed-tools: read',
      'model: mock/deploy',
      '---',
      '',
      'Deploy $ARGUMENTS and report the result.',
      '',
    ].join('\n'))
    await writeFile(join(commandsDir, 'broken.md'), 'No frontmatter here.\n')
    await mkdir(join(root, 'home/.dsh/commands'), { recursive: true })
    await writeFile(join(root, 'home/.dsh/commands/report.md'), '---\ndescription: Report status\n---\nReport the status.\n')
    await mkdir(join(root, '.claude/commands'), { recursive: true })
    await writeFile(join(root, '.claude/commands/deploy.md'), '---\ndescription: shadowed\n---\nshadowed body\n')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@deepseek-ai/dsh-commands/file-commands'",
      '  config:',
      `    projectDshCommands: ${JSON.stringify(commandsDir)}`,
      `    projectClaudeCommands: ${JSON.stringify(join(root, '.claude/commands'))}`,
      `    dshHome: ${JSON.stringify(join(root, 'home/.dsh'))}`,
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    const warn = vi.spyOn(context.logger, 'warn')
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@deepseek-ai/dsh-commands/file-commands', fileCommands],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    // The Loader composition itself recorded one diagnostic per unusable file.
    const diagnostics = warn.mock.calls.map(([line]) => String(line))
    expect(diagnostics).toEqual([
      expect.stringContaining('broken.md ignored: missing YAML frontmatter'),
      expect.stringContaining('deploy.md ignored: "deploy" is already provided by'),
    ])

    await mountAgentLoopTestDependencies(context, { systemPrompt: { personaPrefix: 'You run on {{model}}.' } })
    for (const name of ['read', 'grep', 'write']) context.tools.register(tool(name))
    const harness = await mountAgentLoopTestHarness(context)
    const agent = await harness.create(SessionId('file-command-loader'), { provider: 'mock', model: 'mock' })
    const adapter = new RecordingAdapter(() => context?.tools.get('write', agent) !== undefined)
    context.llm.registerAdapter(['mock'], adapter)
    // The entry-point selection the command's declared model must outrank for
    // the run it starts, and the route a later submission returns to.
    const selection: ModelSelectionRef = { current: { provider: 'mock', model: 'selected' }, assembled: undefined }
    installModelSelection(agent.ctx, selection)

    expect(context.commands.list(agent)).toEqual([
      { name: 'deploy', description: 'Deploy the service', input: { hint: '<environment>' } },
      { name: 'report', description: 'Report status' },
    ])
    expect(context.commands.find(agent, 'deploy')?.model).toBe('mock/deploy')

    const execution = await context.commands.execute(agent, '/deploy staging', [], new AbortController().signal)
    expect(execution?.result).toEqual({
      kind: 'success',
      text: `Submitted /deploy from ${join(commandsDir, 'deploy.md')}`,
    })
    await agent.whenIdle()

    // Model-visible: the submission reached the request as the expanded body.
    expect(adapter.requests).toHaveLength(1)
    expect(requestText(adapter.requests[0])).toContain('Deploy staging and report the result.')
    // Routed: the declared model carried the run, on the agent's own provider,
    // and the prompt that describes the model agrees with the request.
    expect(adapter.requests[0]?.provider).toBe('mock')
    expect(adapter.requests[0]?.model).toBe('mock/deploy')
    expect(requestText(adapter.requests[0])).toContain('You run on mock/deploy.')
    // The allowlist masked the agent for exactly that run.
    expect(adapter.writeVisibleDuringRequest).toBe(false)
    expect(context.tools.get('write', agent)).toBeDefined()

    // Both overrides covered exactly that run: a later submission returns to the
    // entry point's own route.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plain task' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    expect(adapter.requests[1]?.model).toBe('selected')

    // Durable: the lifecycle events and the submitted user message are logged.
    const events = agent.session.snapshotEvents()
    expect(events.find(event => event.type === 'command/run')?.data).toEqual({
      commandId: execution?.commandId,
      name: 'deploy',
      args: ' staging',
      source: { kind: 'user' },
    })
    const userMessage = events.find(event => event.type === 'user/message')
    expect(userMessage?.type === 'user/message' ? userMessage.data.content : []).toEqual([
      { type: 'text', text: 'Deploy staging and report the result.' },
    ])
    expect(events.filter(event => event.type === 'command/done').map(event => event.type)).toEqual(['command/done'])
  })
})
