import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import Lsp, { LspProviderId, type LspProvider, type LspProviderQuery, type LspQueryResult } from '@deepseek-ai/dsh-lsp'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import * as LspPostEditDiagnostics from '../src/index.ts'

/** A scripted provider recording queries; `respond` yields the result or throws. */
function stubProvider(
  respond: (request: LspProviderQuery) => LspQueryResult,
  extensionToLanguage: Record<string, string> = { '.ts': 'typescript' },
): LspProvider & { seen: LspProviderQuery[] } {
  const seen: LspProviderQuery[] = []
  return {
    id: LspProviderId('stub'),
    extensionToLanguage,
    seen,
    query(request) {
      seen.push(request)
      return Promise.resolve(respond(request))
    },
  }
}

/** Register fixture `edit` and `write` tools whose result is configurable per test. */
function registerFixtureTools(ctx: Context, isError = false): void {
  for (const name of ['edit', 'write']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: 'fixture',
      parameters: { file_path: { type: 'string', required: true } },
      async execute() {
        if (isError) throw new Error('fixture failure')
        return [{ type: 'text', text: 'ok' }]
      },
    }))
  }
}

/** Mount the real tool stack, a stub LSP provider, and the plugin under test. */
async function mount(
  provider?: LspProvider,
  config: LspPostEditDiagnostics.Config = {},
  isError = false,
): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Lsp)
  if (provider) (ctx.lsp as Lsp).registerProvider(provider)
  registerFixtureTools(ctx, isError)
  await ctx.plugin(LspPostEditDiagnostics, config)
  return { ctx }
}

let seq = 0
const testToolSignal = new AbortController().signal
const workspaceRoot = resolve('/virtual/workspace')

function call(ctx: Context, name: string, filePath: string, cwd: string | null = workspaceRoot) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: `c-${++seq}` as never,
    name,
    arguments: { file_path: filePath },
    ...cwd !== null ? { agent: { session: { header: { cwd } } } as never } : {},
  })
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

/** A real loop adapter that requests one edit, then records the next assembled request. */
class PostEditDiagnosticsAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private readonly script: StreamChunk[][]

  constructor() {
    super()
    const id = ToolCallId('edit-call')
    const args = JSON.stringify({ file_path: 'a.ts' })
    this.script = [
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id, name: 'edit', argumentsDelta: args },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'edit', arguments: args } },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'done' },
        { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
        { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
    ]
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const chunks = this.script.shift()
    if (chunks === undefined) throw new Error('post-edit diagnostics test adapter exhausted its script')
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

const oneDiagnostic: LspQueryResult = {
  kind: 'diagnostics',
  diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 'error', message: 'boom' }],
}
const noDiagnostics: LspQueryResult = { kind: 'diagnostics', diagnostics: [] }

describe('lsp-post-edit-diagnostics', () => {
  it('appends diagnostics to a successful edit result', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider)
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.isError).toBe(false)
    expect(provider.seen[0]).toEqual({ operation: 'diagnostics', filePath: 'a.ts', workspaceRoot, languageId: 'typescript' })
    expect(result.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'text', text: 'Diagnostics for a.ts:\n1:1 error: boom' },
    ])
    expect(result.additionalContexts).toBeUndefined()
  })

  it('appends diagnostics to a successful write result', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider)
    const result = await call(ctx, 'write', 'a.ts')
    expect(result.content).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'text', text: 'Diagnostics for a.ts:\n1:1 error: boom' },
    ])
  })

  it('leaves a clean file result unchanged', async () => {
    const { ctx } = await mount(stubProvider(() => noDiagnostics))
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(result.additionalContexts).toBeUndefined()
  })

  it('does not query for tools other than edit and write', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider)
    ctx.tools.register(defineContentToolFixture({
      name: 'inspect',
      description: 'fixture',
      parameters: { file_path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))
    const result = await call(ctx, 'inspect', 'a.ts')
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }])
    expect(provider.seen).toHaveLength(0)
  })

  it('never enriches a failed edit', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider, {}, true)
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.isError).toBe(true)
    expect(result.additionalContexts).toBeUndefined()
    expect(provider.seen).toHaveLength(0)
  })

  it('adds no context without a session cwd', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider)
    const result = await call(ctx, 'edit', 'a.ts', null)
    expect(result.additionalContexts).toBeUndefined()
    expect(provider.seen).toHaveLength(0)
  })

  it('swallows a provider failure (no route for the extension) without failing the edit', async () => {
    const provider = stubProvider(() => oneDiagnostic, { '.py': 'python' })
    const { ctx } = await mount(provider)
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.isError).toBe(false)
    expect(result.additionalContexts).toBeUndefined()
  })


  it('composes with an earlier listener that already attached context', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Lsp)
    ;(ctx.lsp as Lsp).registerProvider(provider)
    registerFixtureTools(ctx)
    ctx.on('tools/post-execute', async (_exec, _result, next): Promise<PostToolDecision> => {
      const decision = await next()
      return decision.kind === 'accept'
        ? {
          ...decision,
          additionalContexts: [
            ...decision.additionalContexts ?? [],
            createUserMessage({ content: [{ type: 'text', text: 'earlier' }], source: { kind: 'user' } }),
          ],
        }
        : decision
    }, { prepend: true })
    await ctx.plugin(LspPostEditDiagnostics)
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.content.at(-1)).toEqual({ type: 'text', text: 'Diagnostics for a.ts:\n1:1 error: boom' })
    expect(result.additionalContexts).toHaveLength(1)
  })

  it('preserves structured results and carries diagnostics separately', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider)
    ctx.on('tools/post-execute', async (_exec, _result, next): Promise<PostToolDecision> => {
      const decision = await next()
      return decision.kind === 'accept'
        ? { kind: 'accept', value: [{ type: 'text', text: 'replacement' }] }
        : decision
    })
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.content).toEqual([{ type: 'text', text: 'replacement' }])
    expect(result.additionalContexts?.[0]?.content).toMatchObject([{
      type: 'text',
      text: expect.stringContaining('Diagnostics for a.ts:\n1:1 error: boom'),
    }])
  })


  it('rejects a non-positive maxResultChars at load', async () => {
    await expect(mount(stubProvider(() => oneDiagnostic), { maxResultChars: 0 })).rejects.toThrow(/maxResultChars/)
  })
})

describe('model-visible diagnostics integration', () => {
  it('appends diagnostics to the tool result in the next model request and Session log', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const adapter = new PostEditDiagnosticsAdapter()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' } })
    await ctx.plugin(Lsp)
    ;(ctx.lsp as Lsp).registerProvider(provider)
    registerFixtureTools(ctx)
    await ctx.plugin(LspPostEditDiagnostics)
    ctx.llm.registerAdapter(['mock'], adapter)
    const harness = await mountAgentLoopTestHarness(ctx)
    const agent = await harness.create(
      SessionId('post-edit-diagnostics'),
      { provider: 'mock', model: 'mock' },
      { cwd: workspaceRoot },
    )

    try {
      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'edit the file' }], source: { kind: 'user' } }))
      await idle

      expect(provider.seen).toMatchObject([{ operation: 'diagnostics', filePath: 'a.ts', workspaceRoot }])
      expect(adapter.requests).toHaveLength(2)
      const nextRequest = adapter.requests[1]
      expect(nextRequest).toBeDefined()
      const toolResult = nextRequest?.messages.find(message =>
        message.role === 'tool'
        && message.content.some(block => block.type === 'text' && block.text === 'ok')
        && message.content.some(block => block.type === 'text' && block.text.includes('Diagnostics for a.ts:\n1:1 error: boom')),
      )
      expect(toolResult).toBeDefined()

      const logged = agent.session.snapshotEvents().find(event =>
        event.type === 'tool/result'
        && event.data.message.content.some(block => block.type === 'text' && block.text.includes('Diagnostics for a.ts:\n1:1 error: boom')))
      expect(logged?.type).toBe('tool/result')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
