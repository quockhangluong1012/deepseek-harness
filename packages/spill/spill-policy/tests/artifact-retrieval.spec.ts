/**
 * Integration proof that artifact retrieval and the tool-result spill policy
 * share one store: an over-budget real tool result still becomes a preview plus
 * a recognized spill notice, `ctx.artifacts` finds and recovers exactly the text
 * the policy spilled, and a summary's byte accounting feeds the shipped notice
 * formatter. The local backend and the policy are the shipped implementations.
 */

import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { extractSpillNotice, formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testToolSignal = new AbortController().signal

/** Flatten a result's text blocks. */
function textOf(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

/** A tool returning `text` verbatim. */
function textTool(name: string, text: string) {
  return defineContentToolFixture({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text }] },
  })
}

/** A minimal exec carrying the session header id the policy reads as the spill owner. */
function exec(name: string, session = 's1'): ToolExecution {
  const agent = { session: { header: { id: SessionId(session) } } }
  return { callId: ToolCallId(`call-${name}`), name, arguments: {}, agent, signal: testToolSignal } as unknown as ToolExecution
}

/** Mount the real local backend and the shipped policy over one isolated root. */
async function setup(maxInlineTokens: number): Promise<{ ctx: Context; root: string }> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-artifact-policy-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 })
  await ctx.plugin(SpillPolicy, { maxInlineTokens })
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  return { ctx, root }
}

describe('retrieval over policy-spilled artifacts', () => {
  it('recovers the full text behind a recognized notice and feeds the notice format a summary', async () => {
    const { ctx } = await setup(64)
    const body = 'HEAD'.repeat(200) + 'TAIL'.repeat(200)
    ctx.tools.register(textTool('big', body))
    const result = await ctx.tools.execute(exec('big'))

    const notice = extractSpillNotice(textOf(result.content))
    expect(notice).toBeDefined()

    const matches = await ctx.artifacts.search({ owner: { sessionId: SessionId('s1') } })
    expect(matches).toHaveLength(1)
    const [first] = matches
    if (first === undefined) throw new Error('the spilled artifact is not searchable')
    const locator = first.locator
    expect(notice).toContain(String(locator))

    const recovered = await ctx.artifacts.read({ locator })
    expect(recovered.text).toBe(body)
    expect(recovered.totalBytes).toBe(Buffer.byteLength(body, 'utf8'))

    const summary = await ctx.artifacts.summarize({ locator, maxBytes: 100 })
    expect(summary.bytes).toBeLessThanOrEqual(100)
    expect(summary.totalBytes).toBe(Buffer.byteLength(body, 'utf8'))
    expect(summary.omittedBytes).toBe(summary.totalBytes - summary.bytes)
    expect(summary.truncated).toBe(true)

    // The summary's exact byte count composes with the shipped notice format.
    const rebuilt = `preview\n\n${formatSpillNotice(
      { kind: 'exact', count: summary.omittedBytes },
      { locator, retrievalHint: 'Use read with offset/limit.' },
    )}`
    expect(extractSpillNotice(rebuilt)).toBe(rebuilt.slice('preview\n\n'.length))
  })

  it('leaves an artifact that already fits the budget whole', async () => {
    const { ctx } = await setup(1000)
    ctx.tools.register(textTool('small', 'tiny'))
    const result = await ctx.tools.execute(exec('small'))

    expect(textOf(result.content)).toBe('tiny')
    expect(await ctx.artifacts.search({ owner: { sessionId: SessionId('s1') } })).toEqual([])
  })
})
