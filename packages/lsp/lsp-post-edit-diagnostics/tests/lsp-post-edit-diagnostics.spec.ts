import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import Lsp, { LspProviderId, type LspProvider, type LspProviderQuery, type LspQueryResult } from '@deepseek-ai/dsh-lsp'
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

const oneDiagnostic: LspQueryResult = {
  kind: 'diagnostics',
  diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 'error', message: 'boom' }],
}
const noDiagnostics: LspQueryResult = { kind: 'diagnostics', diagnostics: [] }

describe('lsp-post-edit-diagnostics', () => {
  it('attaches diagnostics as additional context after a successful edit', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider)
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.isError).toBe(false)
    expect(provider.seen[0]).toEqual({ operation: 'diagnostics', filePath: 'a.ts', workspaceRoot, languageId: 'typescript' })
    expect(result.additionalContexts).toHaveLength(1)
    const text = result.additionalContexts?.[0]?.content[0]
    expect(text).toMatchObject({ type: 'text', text: expect.stringContaining('Diagnostics for a.ts:') })
    expect(text).toMatchObject({ text: expect.stringContaining('1:1 error: boom') })
  })

  it('attaches diagnostics after a successful write, the other default tool', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider)
    const result = await call(ctx, 'write', 'a.ts')
    expect(result.additionalContexts).toHaveLength(1)
  })

  it('adds no context when the file has no diagnostics', async () => {
    const { ctx } = await mount(stubProvider(() => noDiagnostics))
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.additionalContexts).toBeUndefined()
  })

  it('adds no context for a tool outside the configured set', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    // "write" is a default tool name, but this test excludes it via config.
    const { ctx: scopedCtx } = await mount(provider, { toolNames: ['edit'] })
    const result = await call(scopedCtx, 'write', 'a.ts')
    expect(result.additionalContexts).toBeUndefined()
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

  it('honors a configured custom tool-name set', async () => {
    const provider = stubProvider(() => oneDiagnostic)
    const { ctx } = await mount(provider, { toolNames: ['edit'] })
    const editResult = await call(ctx, 'edit', 'a.ts')
    const writeResult = await call(ctx, 'write', 'a.ts')
    expect(editResult.additionalContexts).toHaveLength(1)
    expect(writeResult.additionalContexts).toBeUndefined()
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
        ? { ...decision, additionalContexts: [...decision.additionalContexts ?? [], { role: 'user', id: 'x', createdAt: 0, content: [{ type: 'text', text: 'earlier' }], source: { kind: 'user' } } as never] }
        : decision
    }, { prepend: true })
    await ctx.plugin(LspPostEditDiagnostics)
    const result = await call(ctx, 'edit', 'a.ts')
    expect(result.additionalContexts).toHaveLength(2)
  })

  it('rejects an empty toolNames array at load', async () => {
    await expect(mount(stubProvider(() => oneDiagnostic), { toolNames: [] })).rejects.toThrow(/toolNames/)
  })

  it('rejects a non-positive maxResultChars at load', async () => {
    await expect(mount(stubProvider(() => oneDiagnostic), { maxResultChars: 0 })).rejects.toThrow(/maxResultChars/)
  })
})
