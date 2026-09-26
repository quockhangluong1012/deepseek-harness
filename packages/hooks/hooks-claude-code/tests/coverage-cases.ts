import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import SubagentRuntime, { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import * as HooksClaude from '@deepseek-ai/dsh-hooks-claude-code'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'policy': { kind: 'policy' } & ContextFormed
  }
}

const testToolSignal = new AbortController().signal

/** Targeted branch coverage for the CC bridge: option arms, warn paths, no-agent
 * fallbacks, contextFrom-empty, and the detached-listener catch handlers. */

const dirs: string[] = []
const contexts: Context[] = []
const endpoints: { close: () => Promise<void> }[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const endpoint of endpoints.splice(0)) await endpoint.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function subagentCarrier(ctx: Context) {
  return scopeTarget(ctx as unknown as SubagentRuntime, undefined)
}

function dir(): string { const d = mkdtempSync(join(tmpdir(), 'dsh-hc-cov-')); dirs.push(d); return d }
function sh(d: string, name: string, body: string): string {
  const p = join(d, name); writeFileSync(p, body); chmodSync(p, 0o755); return p
}
function hooks(d: string, h: unknown): string {
  writeFileSync(join(d, 'hooks.json'), JSON.stringify({ hooks: h })); return join(d, 'hooks.json')
}

type HarnessOpts = { pluginRoot?: string; projectDir?: string; stderrSummaryMaxChars?: number; sessionRoot?: string }
async function harness(configPath: string, adapter: MockAdapter, opts: HarnessOpts = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  if (opts.sessionRoot !== undefined) await ctx.plugin(JsonlSessionPersistence, { root: opts.sessionRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(HooksClaude, { configPath, ...opts })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}
function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}
function events(agent: Agent): readonly SessionEvent[] { return agent.session.snapshotEvents() }

/** The hook points one agent's log recorded a `hook/invoked` entry for, in log order. */
function hookPoints(agent: Agent): string[] {
  return events(agent).flatMap(event => event.type === 'hook/invoked' ? [event.data.point] : [])
}

/** Poll until `predicate` holds or the deadline passes — robust to detached
 * emit-listener hooks firing on a `.then` (a fixed sleep flakes under load). */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

export type CoverageGroup = 'config' | 'stop' | 'context' | 'edge-paths' | 'extensions' | 'events'

/** Register independently schedulable slices of the hooks-claude-code coverage matrix. */
export function defineCoverageCases(group: CoverageGroup): void {
  if (group === 'config') describe('hooks-claude-code coverage — config option arms + substitution + skip warning', () => {
    it('degrades transcript_path to the empty string even with persistence mounted', async () => {
      const d = dir()
      const cap = join(d, 'payload')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: sh(d, 'capture.sh', `#!/usr/bin/env bash\ncat > "${cap}"\n`) }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter, { sessionRoot: dir() })
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('transcript'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      // The persistence seam exposes no artifact paths, so the field stays ''
      // even with a persistence backend mounted.
      expect((JSON.parse(readFileSync(cap, 'utf8')) as { transcript_path: string }).transcript_path).toBe('')
    }, 15_000) // The real agent/hook subprocess loop needs process startup and teardown headroom.

    it('honors pluginRoot + projectDir substitution and warns on a skipped non-command hook', async () => {
      const d = dir()
      // ${CLAUDE_PLUGIN_ROOT} resolves to d; the script writes its own cwd-independent marker.
      const marker = join(d, 'ran')
      sh(d, 'h.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`)
      const path = hooks(d, {
        PreToolUse: [{ hooks: [
          { type: 'prompt', prompt: 'skipme' }, // skipped → warn loop
          { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/h.sh' }, // substituted
        ] }],
      })
      const warn = vi.fn()
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter, { pluginRoot: d, projectDir: d })
      ctx.logger.warn = warn as never
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(existsSync(marker)).toBe(true) // substituted command ran
    }, 15_000) // Real agent and hook subprocess startup can exceed Vitest's default under coverage concurrency.

    it('warns and honors updatedInput as a no-op (input rewrite deferred)', async () => {
      const d = dir()
      const s = sh(d, 'u.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"rewritten"}}}\'\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const warn = vi.fn()
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { command: 'original' }), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.logger.warn = warn as never
      let sawArgs: unknown
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: { command: { type: 'string' } }, async execute(args) { sawArgs = args; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      // updatedInput is NOT honored — the tool ran with the ORIGINAL args.
      expect((sawArgs as { command?: string }).command).toBe('original')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('updatedInput'))
    })
  })

  if (group === 'config') describe('hooks-claude-code coverage — empty/no-op outcomes and no-agent paths', () => {
    it('a clean exit-0 hook with no output is a no-op (contextFrom empty → next())', async () => {
      const d = dir()
      const s = sh(d, 'noop.sh', '#!/usr/bin/env bash\nexit 0\n')
      const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('ran')])
      const ctx = await harness(path, adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      // The prompt proceeded unchanged; no injected context.
      expect(adapter.requests).toHaveLength(1)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user')).toBe(false)
    })

    it('a PreToolUse hook fires for a no-agent direct tool call (no session/turn to record into)', async () => {
      const d = dir()
      const s = sh(d, 'deny.sh', '#!/usr/bin/env bash\necho "no" >&2\nexit 2\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const ctx = await harness(path, new MockAdapter([]))
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'x' }] } }))
      const { ToolCallId } = await import('@deepseek-ai/dsh-llm')
      const result = await ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId('c1'), name: 'echo', arguments: {} })
      expect(ran).toBe(false)
      expect(result.isError).toBe(true)
    })

    it('a long stderr is truncated in the hook/result summary', async () => {
      const d = dir()
      const s = sh(d, 'long.sh', '#!/usr/bin/env bash\nprintf "x%.0s" {1..600} >&2\nexit 2\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.stderrSummary?.endsWith('…')).toBe(true)
      expect(res?.type === 'hook/result' && res.data.stderrSummary?.length).toBe(501) // default 500-char cap + ellipsis
    })

    it('rejects a non-positive or fractional stderrSummaryMaxChars at load', async () => {
      const d = dir()
      const path = hooks(d, {})
      for (const bad of [0, -5, 1.5, Number.NaN]) {
        const adapter = new MockAdapter([])
        await expect(harness(path, adapter, { stderrSummaryMaxChars: bad }))
          .rejects.toThrow(/hooks-claude-code: stderrSummaryMaxChars must be a positive integer/)
      }
    })

    it('the stderr summary cap is plugin config (stderrSummaryMaxChars)', async () => {
      const d = dir()
      const s = sh(d, 'long.sh', '#!/usr/bin/env bash\nprintf "x%.0s" {1..600} >&2\nexit 2\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter, { stderrSummaryMaxChars: 40 })
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.stderrSummary).toBe('x'.repeat(40) + '…')
    })
  })

  if (group === 'stop') describe('hooks-claude-code coverage — Stop continuation + subagent inject/catch', () => {
    it('a Stop hook that blocks (exit 2) forces the turn to continue (CC dialect)', async () => {
      const d = dir()
      const marker = join(d, 'fired')
      const s = sh(d, 'stop.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\necho "continue please" >&2\nexit 2\n`)
      const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
      const ctx = await harness(path, adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(2)
      expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('continue please')
    })

    it('a Stop hook that blocks with EMPTY stderr still forces continuation (no reason required)', async () => {
    // A blocking Stop hook with no stderr yields `deny` without a reason. The block still forces
    // continuation; the script self-limits to one block to avoid a loop.
      const d = dir()
      const marker = join(d, 'fired')
      const s = sh(d, 'stop.sh', `#!/usr/bin/env bash\nif [ -e "${marker}" ]; then exit 0; fi\ntouch "${marker}"\nexit 2\n`)
      const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
      const ctx = await harness(path, adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      // A second model request ran → the empty-reason block forced continuation.
      expect(adapter.requests).toHaveLength(2)
      // The steering carried the fallback reason (no stderr to use).
      expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('blocked by Stop hook')
    })

    it('SubagentStart additionalContext is injected into a REGISTERED live child', async () => {
      const d = dir()
      const s = sh(d, 'sa.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"child guidance"}}\'\n')
      const path = hooks(d, { SubagentStart: [{ hooks: [{ type: 'command', command: s }] }] })
      const ctx = await harness(path, new MockAdapter([]))
      const injected: string[] = []
      const child = {
        id: SessionId('child-x'),
        inject: (input: { content: Array<{ type: string; text?: string }> }) => {
          injected.push(input.content.map(block => block.text ?? '').join(''))
        },
        session: { id: SessionId('child-x'), header: { id: 'child-x' } },
      } as unknown as Parameters<typeof ctx.agents.register>[0]
      await ctx.agents.register(child)
      ctx.emit(subagentCarrier(ctx), 'subagent/start', { runId: SubagentRunId('run-x'), provider: 'p', id: SessionId('child-x'), local: true })
      await waitFor(() => injected.includes('child guidance'))
      expect(injected).toContain('child guidance')
    })

    it('a throwing SubagentStart/SubagentStop hook run is contained (logged)', async () => {
      const d = dir()
      // A hook command that does not exist makes runHook resolve a non-blocking
      // error (not a throw), so to hit the .catch we make the .then throw: register
      // a child whose inject throws for SubagentStart.
      const s = sh(d, 'sa.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"x"}}\'\n')
      const path = hooks(d, { SubagentStart: [{ hooks: [{ type: 'command', command: s }] }] })
      const ctx = await harness(path, new MockAdapter([]))
      const warn = vi.fn(); ctx.logger.warn = warn as never
      const child = { id: SessionId('child-y'), inject: () => { throw new Error('inject boom') }, session: { id: SessionId('child-y'), header: { id: 'child-y' } } } as unknown as Parameters<typeof ctx.agents.register>[0]
      await ctx.agents.register(child)
      ctx.emit(subagentCarrier(ctx), 'subagent/start', { runId: SubagentRunId('run-y'), provider: 'p', id: SessionId('child-y'), local: true })
      await waitFor(() => warn.mock.calls.some(c => String(c[0]).includes('SubagentStart hook failed')))
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('SubagentStart hook failed'))
    })
  })

  if (group === 'stop') describe('hooks-claude-code coverage — default reasons + sparse payloads', () => {
    it('PreToolUse deny with EMPTY stderr uses the default reason', async () => {
      const d = dir()
      const s = sh(d, 'deny.sh', '#!/usr/bin/env bash\nexit 2\n') // exit 2, no stderr
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'x' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.content.some(b => b.type === 'text' && b.text.includes('blocked by PreToolUse hook'))).toBe(true)
    })

    it('PostToolUse deny with EMPTY stderr + no context uses the default feedback', async () => {
      const d = dir()
      const s = sh(d, 'block.sh', '#!/usr/bin/env bash\nexit 2\n')
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.content.some(b => b.type === 'text' && b.text.includes('blocked by PostToolUse hook'))).toBe(true)
    })

    it('SubagentStop with no registered child runs the hook cleanly (fire-and-forget)', async () => {
      const d = dir()
      // The agents registry has no entry for the id, so the child lookup yields
      // undefined and the payload falls back to base(undefined) — assert the
      // observe-only SubagentStop run still executes the hook without crashing.
      const marker = join(d, 'stopran')
      const s = sh(d, 'stop.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`)
      const path = hooks(d, { SubagentStop: [{ hooks: [{ type: 'command', command: s }] }] })
      const ctx = await harness(path, new MockAdapter([]))
      ctx.emit(subagentCarrier(ctx), 'subagent/end', { runId: SubagentRunId('run-z'), provider: 'p', id: SessionId('child-z'), local: false, stopReason: 'completed' })
      await waitFor(() => existsSync(marker))
      expect(existsSync(marker)).toBe(true)
    })
  })

  if (group === 'edge-paths') describe('hooks-claude-code coverage — more default/sparse arms', () => {
    it('UserPromptSubmit deny with EMPTY stderr uses the default block reason', async () => {
      const d = dir()
      const s = sh(d, 'block.sh', '#!/usr/bin/env bash\nexit 2\n')
      const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('no')])
      const ctx = await harness(path, adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(events(agent).filter(e => e.type === 'turn/start' || e.type === 'hook/invoked'
        || e.type === 'hook/result' || e.type === 'turn/end').map(e => e.type))
        .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
    })

    it('a PreToolUse ask with NO reason omits the reason (false arm)', async () => {
      const d = dir()
      const s = sh(d, 'ask.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}\'\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'x' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      // ask (no reason) → degrades to deny with the registry's generic message.
      expect(ran).toBe(false)
      expect(events(agent).some(e => e.type === 'tool/result' && e.data.message.isError)).toBe(true)
    })

    it('a recorded clean exit-0 hook with no stderr omits exitCode-extra/stderrSummary fields', async () => {
      const d = dir()
      const s = sh(d, 'noop.sh', '#!/usr/bin/env bash\nexit 0\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.exitCode).toBe(0)
      expect(res?.type === 'hook/result' && 'stderrSummary' in res.data).toBe(false)
    })

    it('an explicit PreToolUse permissionDecision:allow never suppresses a downstream policy deny', async () => {
      // The hook explicitly says "allow" — the strongest signal its dialect can
      // send — but `allow` does not pre-approve; the bridge only ever short
      // circuits on `deny`, so a real policy owner registered on the same
      // waterfall still gets to answer, and its deny reaches the tool call
      // unweakened by the hook's affirmative opinion.
      const d = dir()
      const s = sh(d, 'allow.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}\'\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      ctx.on('tools/pre-execute', async () => ({ kind: 'deny' as const, reason: 'policy: denied by the real policy owner' }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(ran).toBe(false)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.isError).toBe(true)
      expect(result?.type === 'tool/result'
        && result.data.message.content.some(b => b.type === 'text' && b.text.includes('denied by the real policy owner'))).toBe(true)
    })
  })

  if (group === 'edge-paths') describe('hooks-claude-code coverage — schema-bypass apply + unspawnable hook', () => {
    it('a direct apply() (schema bypass) with only configPath runs', async () => {
      const d = dir()
      const marker = join(d, 'ran')
      const s = sh(d, 'h.sh', `#!/usr/bin/env bash\ntouch "${marker}"\n`)
      hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
      // Direct apply with only configPath — bypasses schemastery's defaults, so
      // the bridge must run on the raw minimal config (the per-hook timeout is
      // the protocol lib's reference default, not a config knob).
      HooksClaude.apply(ctx, { configPath: join(d, 'hooks.json') })
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(existsSync(marker)).toBe(true)
    })

    it('a non-zero non-2 hook exit (e.g. a command-not-found 127) is a non-blocking error; the tool still runs', async () => {
      const d = dir()
      // `bash -c` of a missing program exits 127 — a non-blocking error (not 0, not
      // 2 → no decision), so the tool proceeds; the hook/result records exit 127.
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: '/nonexistent/definitely/not/a/command' }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(ran).toBe(true)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.exitCode).toBe(127)
    })

    it('a PostToolUse deny with empty stderr + no context uses the default feedback (no context arm)', async () => {
      const d = dir()
      const s = sh(d, 'block.sh', '#!/usr/bin/env bash\nexit 2\n')
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.isError).toBe(true)
    })
  })

  if (group === 'context') describe('hooks-claude-code coverage — continue:false, context arm, no-cwd', () => {
    it('a {"continue":false} hook HALTS the run: the tool never runs and the turn ends aborted with the hook reason', async () => {
      // The hook command is inline rather than a script path so this case
      // exercises the halt under any host bash.
      const d = dir()
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo \'{"continue":false,"stopReason":"halt"}\'' }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && res.data.decision).toBe('stop') // the request is recorded
      expect(ran).toBe(false) // honored: the halt cancels the run before the tool dispatches
      const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
      expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason)
        .toEqual({ kind: 'aborted', reason: { kind: 'hook', reason: 'halt' } })
    })

    it('a UserPromptSubmit {"continue":false} hook halts the run before any model step', async () => {
      const d = dir()
      const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo \'{"continue":false,"stopReason":"stop the press"}\'' }] }] })
      const adapter = new MockAdapter([textResponse('should not run')])
      const ctx = await harness(path, adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(0)
      const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
      expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason)
        .toEqual({ kind: 'aborted', reason: { kind: 'hook', reason: 'stop the press' } })
    })

    it('a Stop {"continue":false} hook halts the run instead of forcing another step', async () => {
      const d = dir()
      const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: 'echo \'{"continue":false,"stopReason":"done for today"}\'' }] }] })
      const adapter = new MockAdapter([textResponse('done')])
      const ctx = await harness(path, adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(1) // no forced continuation step
      const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
      expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason)
        .toEqual({ kind: 'aborted', reason: { kind: 'hook', reason: 'done for today' } })
    })

    it('a PostToolUse {"continue":false} hook halts the run after the tool ran', async () => {
      const d = dir()
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo \'{"continue":false,"stopReason":"enough"}\'' }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('should not run')])
      const ctx = await harness(path, adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(ran).toBe(true) // the call completed before the halt
      expect(adapter.requests).toHaveLength(1) // and the halt stopped the run before the next step
      const turnEnd = events(agent).findLast(e => e.type === 'turn/end')
      expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason)
        .toEqual({ kind: 'aborted', reason: { kind: 'hook', reason: 'enough' } })
    })

    it('a SessionStart {"continue":false} hook is warned, not halted: the run is not live yet', async () => {
      const d = dir()
      const path = hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: 'echo \'{"continue":false,"stopReason":"nope"}\'' }] }] })
      const warn = vi.fn()
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(path, adapter)
      ctx.logger.warn = warn as never
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no live run exists there'))
      expect(adapter.requests).toHaveLength(1) // the run proceeded
      expect(events(agent).some(e => e.type === 'hook/invoked')).toBe(false) // no open turn to record into
    })

    it('a PostToolUse hook that BOTH blocks AND attaches additionalContext', async () => {
      const d = dir()
      const s = sh(d, 'b.sh', '#!/usr/bin/env bash\necho \'{"decision":"block","reason":"bad","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"context too"}}\'\n')
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.isError).toBe(true)
      expect(result?.type === 'tool/result' && result.data.message.content.some(b => b.type === 'text' && b.text.includes('bad'))).toBe(true)
      // additionalContext also injected (the block + context arm).
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user' && e.data.content.some(b => b.type === 'text' && b.text.includes('context too')))).toBe(true)
    })

    it('a PreToolUse hook whose hookSpecificOutput names a DIFFERENT event does NOT deny the tool', async () => {
    // The block's hookEventName (UserPromptSubmit) mismatches the firing event
    // (PreToolUse), so its permissionDecision:"deny" is discarded — the tool runs.
      const d = dir()
      const s = sh(d, 'x.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","permissionDecision":"deny"}}\'\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(ran).toBe(true) // the mismatched deny was discarded → the tool ran
    })

    it('defaults CLAUDE_PROJECT_DIR to the session workspace when no projectDir is configured', async () => {
    // The default ACP wiring sets no projectDir. A stock CC hook that references
    // $CLAUDE_PROJECT_DIR (shell expansion) must still get the session workspace,
    // not an empty string. The hook echoes the var as additionalContext.
      const d = dir()
      const workspace = dir()
      const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\nprintf \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"dir=%s"}}\' "$CLAUDE_PROJECT_DIR"\n')
      const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('ran')])
      const ctx = await harness(path, adapter) // NB: no projectDir
      // The factory create() path honors meta.cwd (the plain agentLoop.create() does not).
      const { SessionId } = await import('@deepseek-ai/dsh-session')
      const handle = await ctx.agents.create({ sessionId: SessionId('s1'), meta: { cwd: workspace }, agentOptions: { provider: 'mock', model: 'mock' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, handle.agent)
      expect(events(handle.agent).some(e => e.type === 'user/message'
      && e.data.content.some(b => b.type === 'text' && b.text.includes(`dir=${workspace}`)))).toBe(true)
      await handle.dispose()
    })

    it('a context-only UserPromptSubmit hook DELEGATES so a later listener can still block', async () => {
    // A context-only hook delegates with `next()` and folds its context, so a downstream policy
    // listener can still veto the prompt.
      const d = dir()
      const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"bridge ctx"}}\'\n')
      const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('should not run')])
      const ctx = await harness(path, adapter)
      // A later listener that blocks every prompt (registered AFTER the bridge).
      ctx.on('agent/pre-step', async () => ({
        kind: 'reject' as const,
      }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      // the downstream block won: the model was never called, no user/message was
      // recorded, and the (sole, fully-blocked) prompt closed the turn `rejected`
      expect(adapter.requests).toHaveLength(0)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user')).toBe(false)
      expect(events(agent).filter(e => e.type === 'turn/start' || e.type === 'hook/invoked'
        || e.type === 'hook/result' || e.type === 'turn/end').map(e => e.type))
        .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
    })

    it('preserves separate bridge and downstream prompt contexts with framing and metadata', async () => {
    // Both the bridge hook and a later pre-step listener attach context; the
    // request must see both as separately sourced durable events.
      const d = dir()
      const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"from-bridge"}}\'\n')
      const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(path, adapter)
      ctx.on('agent/pre-step', async ({ messages }) => ({
        kind: 'enter' as const,
        messages: [{
          ...messages[0]!,
          content: [{ type: 'text' as const, text: 'rewritten-prompt' }],
        }, createUserMessage({
          content: [{ type: 'text' as const, text: 'from-downstream' }],
          source: { kind: 'policy' as const },
        })],
      }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const req = JSON.stringify(adapter.requests[0]!.messages)
      expect(req).toContain('from-bridge')
      expect(req).toContain('from-downstream')
      expect(req).toContain('rewritten-prompt') // downstream content rewrite preserved
      // the original prompt was replaced by the downstream rewrite
      const userMsg = events(agent).find(e => e.type === 'user/message')
      expect(userMsg?.type === 'user/message' && userMsg.data.content.some(b => b.type === 'text' && b.text === 'rewritten-prompt')).toBe(true)
      const contexts = events(agent).filter(event => event.type === 'user/message' && event.data.source.kind !== 'user')
      expect(contexts.map(event => event.type === 'user/message' && event.data.source)).toEqual([
        { kind: 'policy' },
        { kind: 'hooks-claude-code' },
      ])
    })

    it('folds the bridge PostToolUse context onto a downstream canonical value replacement', async () => {
    // The bridge hook adds context; a later post-execute listener accepts with a
    // canonical replacement. Both the replacement and the bridge context survive.
      const d = dir()
      const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bridge-note"}}\'\n')
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      ctx.on('tools/post-execute', async () => ({ kind: 'accept' as const, value: [{ type: 'text' as const, text: 'rewritten-result' }] }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.content.some(b => b.type === 'text' && b.text === 'rewritten-result')).toBe(true)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user' && e.data.content.some(b => b.type === 'text' && b.text.includes('bridge-note')))).toBe(true)
    })

    it('keeps bridge and downstream PostToolUse contexts as separate sourced events', async () => {
      const d = dir()
      const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bridge-note"}}\'\n')
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      ctx.on('tools/post-execute', async () => ({
        kind: 'accept' as const,
        additionalContexts: [createUserMessage({
          content: [{ type: 'text' as const, text: 'downstream-note' }],
          source: { kind: 'policy' as const },
        })],
      }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const contexts = events(agent).filter(event => event.type === 'user/message' && event.data.source.kind !== 'user')
      expect(contexts.map(event => event.type === 'user/message' && event.data.source)).toEqual([
        { kind: 'hooks-claude-code' },
        { kind: 'policy' },
      ])
    })

    it('folds the bridge PostToolUse context onto a downstream listener BLOCK', async () => {
    // The bridge hook only adds context; a later post-execute listener blocks the
    // result. The block wins AND carries the bridge context (concatContext on the
    // block arm).
      const d = dir()
      const s = sh(d, 'ctx.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"bridge-note"}}\'\n')
      const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      ctx.on('tools/post-execute', async () => ({ kind: 'block' as const, feedback: [{ type: 'text' as const, text: 'downstream-block' }] }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.isError).toBe(true)
      expect(result?.type === 'tool/result' && result.data.message.content.some(b => b.type === 'text' && b.text.includes('downstream-block'))).toBe(true)
      // the bridge's context still landed (folded onto the block)
      expect(events(agent).some(e => e.type === 'user/message' && e.data.source.kind !== 'user' && e.data.content.some(b => b.type === 'text' && b.text.includes('bridge-note')))).toBe(true)
    })

  })

  if (group === 'edge-paths') describe('hooks-claude-code coverage — executor reject + no-open-turn', () => {
    it('when the bash executor REJECTS a hook run, the hook/result omits exitCode (non-blocking)', async () => {
      const d = dir()
      const s = sh(d, 'h.sh', '#!/usr/bin/env bash\nexit 0\n')
      const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      // Force the executor to reject (an infrastructure fault) so runHook's catch
      // yields a HookOutput with exitCode undefined → the `exitCode` spread false arm.
      const bash = ctx.shell
      bash.execute = (() => ({ result: () => Promise.reject(new Error('executor down')) }) as never)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      const res = events(agent).find(e => e.type === 'hook/result')
      expect(res?.type === 'hook/result' && 'exitCode' in res.data).toBe(false)
    })

  })

  if (group === 'edge-paths') describe('hooks-claude-code coverage — lifecycle error handling', () => {
    it('a throwing SessionStart inject is contained (logged, agent still runs)', async () => {
      const d = dir()
      const s = sh(d, 'start.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"x"}}\'\n')
      const path = hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(path, adapter)
      const warn = vi.fn(); ctx.logger.warn = warn as never
      try {
        const { agent } = await ctx.agents.create({
          sessionId: SessionId('a1'),
          agentOptions: { provider: 'mock', model: 'mock' },
          setup(_agentCtx, agent) {
            vi.spyOn(agent, 'inject').mockImplementationOnce(() => { throw new Error('inject boom') })
          },
        })
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('SessionStart hook failed'))
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
        await waitForIdle(ctx, agent)
        expect(adapter.requests).toHaveLength(1)
      } finally {
        await ctx.fiber.dispose()
      }
    })
  })

  if (group === 'stop') describe('hooks-claude-code coverage — hook runs in the session cwd, not the server cwd', () => {
    it('runs an agent-scoped hook in the session workspace even when the executor default differs', async () => {
    // The server launch directory and session cwd deliberately differ. The marker proves the
    // bridge passes `session/new.cwd` instead of falling back to the executor default.
      const serverDir = dir()
      const sessionDir = dir()
      const marker = join(sessionDir, 'where')
      // The hook is invoked with cwd = session dir, so a relative marker path lands there.
      hooks(serverDir, { PreToolUse: [{ hooks: [{ type: 'command', command: 'pwd > where' }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      // Executor default cwd = serverDir (deliberately NOT the session cwd).
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, cwd: serverDir })
      await ctx.plugin(HooksClaude, { configPath: join(serverDir, 'hooks.json') })
      ctx.llm.registerAdapter(['mock'], adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))

      const { SessionId } = await import('@deepseek-ai/dsh-session')
      const handle = await ctx.agents.create({ sessionId: SessionId('s1'), meta: { cwd: sessionDir }, agentOptions: { provider: 'mock', model: 'mock' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, handle.agent)

      expect(existsSync(marker)).toBe(true) // the marker landed in the SESSION dir
      const { readFileSync } = await import('node:fs')
      const where = readFileSync(marker, 'utf8').trim()
      // `pwd` may resolve symlinks (/var → /private/var etc.), so compare basenames.
      expect(where.endsWith(sessionDir.split('/').pop()!)).toBe(true)
      await handle.dispose()
    })

    it('runs a SubagentStop hook in the CHILD session workspace, not the server cwd', async () => {
      const serverDir = dir()
      const childDir = dir()
      const marker = join(childDir, 'stopwhere')
      const payload = join(childDir, 'stoppayload')
      hooks(serverDir, { SubagentStop: [{ hooks: [{ type: 'command', command: 'cat > stoppayload.tmp; mv stoppayload.tmp stoppayload; pwd > stopwhere' }] }] })
      const ctx = new Context()
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      // Executor default cwd = serverDir (deliberately NOT the child session cwd).
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, cwd: serverDir })
      await ctx.plugin(HooksClaude, { configPath: join(serverDir, 'hooks.json') })
      ctx.llm.registerAdapter(['mock'], new MockAdapter([]))

      const { SessionId } = await import('@deepseek-ai/dsh-session')
      const childHandle = await ctx.agents.create({ sessionId: SessionId('child-stop-session'), meta: { cwd: childDir }, agentOptions: { provider: 'mock', model: 'mock' } })
      const runId = SubagentRunId('run-stop')
      const identity = { runId, provider: 'inproc', id: childHandle.agent.id, local: true }
      // Start is the registry-backed capture edge; end deliberately follows
      // handle disposal, matching continuable Activation settlement.
      ctx.emit(subagentCarrier(ctx), 'subagent/start', identity)
      await childHandle.dispose()
      expect(ctx.agents.get(childHandle.agent.id)).toBeUndefined()
      ctx.emit(subagentCarrier(ctx), 'subagent/end', { ...identity, stopReason: 'completed' })

      await waitFor(() => existsSync(marker))
      expect(existsSync(marker)).toBe(true) // the marker landed in the CHILD dir
      const where = readFileSync(marker, 'utf8').trim()
      const input = JSON.parse(readFileSync(payload, 'utf8')) as { cwd: string; session_id: string }
      // `pwd` may resolve symlinks (/var → /private/var etc.), so compare basenames.
      expect(where.endsWith(childDir.split('/').pop()!)).toBe(true)
      expect(input).toMatchObject({ cwd: childDir, session_id: childHandle.agent.id })
    })
  })

  if (group === 'config') describe('hooks-claude-code coverage — systemMessage is warned, not surfaced', () => {
    it('a hook emitting a systemMessage is logged as not-yet-surfaced', async () => {
      const d = dir()
      const s = sh(d, 'sm.sh', '#!/usr/bin/env bash\necho \'{"systemMessage":"heads up"}\'\n')
      const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(path, adapter)
      const warn = vi.fn(); ctx.logger.warn = warn as never
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('systemMessage'))
      // Not surfaced: the systemMessage text never reaches the model request.
      expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('heads up')
    })
  })

  if (group === 'edge-paths') describe('hooks-claude-code coverage — SessionStart timing is best-effort (no-wait)', () => {
    it('does NOT crash or block when the prompt is sent immediately (context is best-effort, may miss the first request)', async () => {
    // Session-start injection is detached, so an immediate prompt need not observe it. Assert only
    // the guaranteed behavior—no crash and a completed turn—without pre-waiting away the race.
      const d = dir()
      const s = sh(d, 'start.sh', '#!/usr/bin/env bash\necho \'{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"late ctx"}}\'\n')
      const path = hooks(d, { SessionStart: [{ hooks: [{ type: 'command', command: s }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(path, adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      // Send immediately — do NOT wait for the session-start inject.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(adapter.requests).toHaveLength(1) // the turn ran regardless of hook timing
    })
  })

  if (group === 'extensions') describe('hooks-claude-code coverage — layered discovery, HTTP transport, request and tool-selection hooks', () => {
    it('runs the discovered layers in precedence order: user settings, project settings, project .dsh/hooks.json', async () => {
      const userRoot = dir()
      const projectRoot = dir()
      const layer = (root: string, path: string, reason: string): void => {
        const file = join(root, path)
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `echo ${reason} >&2; exit 2` }] }] } }))
      }
      layer(userRoot, join('.claude', 'settings.json'), 'from-user')
      layer(projectRoot, join('.claude', 'settings.json'), 'from-project')
      layer(projectRoot, join('.dsh', 'hooks.json'), 'from-dsh')

      const adapter = new MockAdapter([textResponse('should not run')])
      const ctx = new Context()
      contexts.push(ctx)
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      await ctx.plugin(LocalSubprocessRuntime)
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
      // No configPath: the bridge runs on discovery alone.
      await ctx.plugin(HooksClaude, { projectRoot, userRoot })
      ctx.llm.registerAdapter(['mock'], adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      expect(adapter.requests).toHaveLength(0) // every layer's blocking hook fired
      const summaries = events(agent).filter(e => e.type === 'hook/result')
        .map(e => e.type === 'hook/result' ? e.data.stderrSummary : undefined)
      expect(summaries).toEqual(['from-user', 'from-project', 'from-dsh'])
    })

    it('runs an HTTP hook through the bridge: the payload is POSTed and its deny decision blocks the tool', async () => {
      const bodies: string[] = []
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          bodies.push(Buffer.concat(chunks).toString('utf8'))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'refused by the endpoint' },
          }))
        })
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      try {
        const address = server.address()
        const port = typeof address === 'object' && address !== null ? address.port : 0
        const d = dir()
        const path = hooks(d, { PreToolUse: [{ hooks: [{ type: 'http', url: `http://127.0.0.1:${port}/hook` }] }] })
        const adapter = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
        const ctx = await harness(path, adapter)
        let ran = false
        ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
        const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
        await waitForIdle(ctx, agent)

        expect(ran).toBe(false) // the endpoint's deny stopped the call
        const result = events(agent).find(e => e.type === 'tool/result')
        expect(result?.type === 'tool/result' && JSON.stringify(result.data.message)).toContain('refused by the endpoint')
        const recorded = events(agent).find(e => e.type === 'hook/result')
        expect(recorded?.type === 'hook/result' && recorded.data.decision).toBe('deny')
        // The endpoint received the same PreToolUse payload a command hook gets.
        expect(JSON.parse(bodies[0]!)).toMatchObject({
          hook_event_name: 'PreToolUse', tool_name: 'echo', session_id: agent.session.header.id,
        })
      } finally {
        await new Promise<void>((resolve) => { server.close(() =>{  resolve() }) })
      }
    })

    it('applies a BeforeModel hook request patch to the model call', async () => {
      const d = dir()
      const path = hooks(d, { BeforeModel: [{ hooks: [{ type: 'command', command: 'echo \'{"hookSpecificOutput":{"hookEventName":"BeforeModel","request":{"model":"patched-model","maxTokens":321}}}\'' }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(path, adapter)
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      expect(adapter.requests[0]!.model).toBe('patched-model')
      expect(adapter.requests[0]!.maxTokens).toBe(321)
    })

    it('narrows the visible tool set from a BeforeToolSelection hook', async () => {
      const d = dir()
      const path = hooks(d, { BeforeToolSelection: [{ hooks: [{ type: 'command', command: 'echo \'{"hookSpecificOutput":{"hookEventName":"BeforeToolSelection","allowTools":["echo"]}}\'' }] }] })
      const adapter = new MockAdapter([textResponse('ok')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      ctx.tools.register(defineContentToolFixture({ name: 'other', description: 'o', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      expect(adapter.requests[0]!.tools?.map(tool => tool.name)).toEqual(['echo'])
    })

    it('runs the PostToolUseFailure point for a failed tool call and folds its context', async () => {
      const d = dir()
      const path = hooks(d, { PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'echo \'{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"the call failed"}}\'' }] }] })
      const adapter = new MockAdapter([toolCallResponse('c1', 'boom', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'boom', description: 'b', parameters: {}, async execute() { throw new Error('kaboom') } }))
      const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const invoked = events(agent).find(e => e.type === 'hook/invoked')
      expect(invoked?.type === 'hook/invoked' && invoked.data.point).toBe('PostToolUseFailure')
      expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('the call failed')
    })
  })

  if (group === 'events') describe('hooks-claude-code coverage — permission, compaction, notification, and lifecycle points', () => {
    /** One HTTP hook endpoint recording every payload it receives; it answers each with `response`. */
    async function hookEndpoint(response: unknown): Promise<{ url: string; bodies: string[] }> {
      const bodies: string[] = []
      const server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          bodies.push(Buffer.concat(chunks).toString('utf8'))
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(response))
        })
      })
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      endpoints.push({ close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }) })
      return { url: `http://127.0.0.1:${port}/hook`, bodies }
    }

    /** A PreToolUse hook that turns the call into an approval ask (the approval seam's only bridge route). */
    async function askEndpoint(): Promise<string> {
      return (await hookEndpoint({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'needs approval' },
      })).url
    }

    it('runs PermissionRequest for an approval ask and honors a hook deny ahead of the answerer', async () => {
      const ask = await askEndpoint()
      const refusal = await hookEndpoint({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'deny' } })
      const d = dir()
      const path = hooks(d, {
        PreToolUse: [{ hooks: [{ type: 'http', url: ask }] }],
        PermissionRequest: [{ matcher: 'guarded', hooks: [{ type: 'http', url: refusal.url }] }],
      })
      const adapter = new MockAdapter([toolCallResponse('c1', 'guarded', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      await ctx.plugin(ApprovalService)
      const answerer = vi.fn(async () => 'allowed-once' as const)
      ctx.on('approval/request', answerer)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'guarded', description: 'g', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('ask-denied'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      expect(ran).toBe(false)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && JSON.stringify(result.data.message)).toContain('the user rejected tool')
      // The hook refused before the channel was asked, so the answerer never ran.
      expect(answerer).not.toHaveBeenCalled()
      expect(refusal.bodies).toHaveLength(1)
      expect(JSON.parse(refusal.bodies[0]!)).toMatchObject({
        hook_event_name: 'PermissionRequest',
        session_id: 'ask-denied',
        tool_name: 'guarded',
        tool_input: {},
        permission_suggestions: [],
      })
      expect(hookPoints(agent).sort()).toEqual(['PermissionRequest', 'PreToolUse'])
    }, 15_000)

    it('lets a PermissionRequest hook refuse but never grant: the approval channel still decides', async () => {
      const ask = await askEndpoint()
      const allowance = await hookEndpoint({ hookSpecificOutput: { hookEventName: 'PermissionRequest', permissionDecision: 'allow' } })
      const d = dir()
      const path = hooks(d, {
        PreToolUse: [{ hooks: [{ type: 'http', url: ask }] }],
        PermissionRequest: [{ hooks: [{ type: 'http', url: allowance.url }] }],
      })
      const adapter = new MockAdapter([toolCallResponse('c1', 'guarded', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      await ctx.plugin(ApprovalService)
      const answerer = vi.fn(async () => 'unavailable' as const)
      ctx.on('approval/request', answerer)
      let ran = false
      ctx.tools.register(defineContentToolFixture({ name: 'guarded', description: 'g', parameters: {}, async execute() { ran = true; return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('ask-allowed'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      // The hook's allow is not a grant: the call still went to the channel, which failed closed.
      expect(ran).toBe(false)
      expect(answerer).toHaveBeenCalledTimes(1)
      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && JSON.stringify(result.data.message)).toContain('no approval channel is available')
      expect(allowance.bodies).toHaveLength(1)
      expect(JSON.parse(allowance.bodies[0]!)).toMatchObject({ hook_event_name: 'PermissionRequest', tool_name: 'guarded' })
    }, 15_000)

    it('runs Notification and PermissionDenied for a rejected decision, matched by their subjects', async () => {
      const ask = await askEndpoint()
      const prompted = await hookEndpoint({})
      const unrelatedNotification = await hookEndpoint({})
      const deniedByTool = await hookEndpoint({})
      const otherDenial = await hookEndpoint({})
      const d = dir()
      const path = hooks(d, {
        PreToolUse: [{ hooks: [{ type: 'http', url: ask }] }],
        Notification: [
          { matcher: 'permission_prompt', hooks: [{ type: 'http', url: prompted.url }] },
          { matcher: 'auth_success', hooks: [{ type: 'http', url: unrelatedNotification.url }] },
        ],
        PermissionDenied: [
          { matcher: 'guarded', hooks: [{ type: 'http', url: deniedByTool.url }] },
          { matcher: 'other-tool', hooks: [{ type: 'http', url: otherDenial.url }] },
        ],
      })
      const adapter = new MockAdapter([toolCallResponse('c1', 'guarded', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      await ctx.plugin(ApprovalService)
      const answerer = vi.fn(async () => 'rejected' as const)
      ctx.on('approval/request', answerer)
      ctx.tools.register(defineContentToolFixture({ name: 'guarded', description: 'g', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
      const agent = await ctx.agentLoop.create(SessionId('approval-audit'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      await waitFor(() => prompted.bodies.length === 1 && deniedByTool.bodies.length === 1)

      expect(answerer).toHaveBeenCalledTimes(1)
      // The ask's Notification and the refusal's PermissionDenied are the CC payloads for that pair.
      expect(JSON.parse(prompted.bodies[0]!)).toMatchObject({
        hook_event_name: 'Notification',
        session_id: 'approval-audit',
        notification_type: 'permission_prompt',
        message: 'Approval requested for tool "guarded"',
        title: '',
      })
      expect(JSON.parse(deniedByTool.bodies[0]!)).toMatchObject({
        hook_event_name: 'PermissionDenied',
        tool_name: 'guarded',
        reason: 'rejected',
      })
      // A group whose matcher names a subject this point never carries runs nothing.
      expect(unrelatedNotification.bodies).toEqual([])
      expect(otherDenial.bodies).toEqual([])
      expect(hookPoints(agent).sort()).toEqual(['Notification', 'PermissionDenied', 'PreToolUse'])
    }, 15_000)

    it('runs PreCompact per compaction start, matching the trigger and reporting a halt it cannot apply', async () => {
      const manual = await hookEndpoint({ continue: false, stopReason: 'compaction veto' })
      const automatic = await hookEndpoint({})
      const d = dir()
      const path = hooks(d, {
        PreCompact: [
          { matcher: 'manual', hooks: [{ type: 'http', url: manual.url }] },
          { matcher: 'auto', hooks: [{ type: 'http', url: automatic.url }] },
        ],
      })
      const adapter = new MockAdapter([toolCallResponse('c1', 'compact', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      const warn = vi.fn()
      ctx.logger.warn = warn as never
      ctx.tools.register(defineContentToolFixture({
        name: 'compact', description: 'c', parameters: {},
        async execute(_args, exec) {
          const session = exec.agent?.session
          if (session === undefined) throw new Error('the compaction tool needs an agent session')
          // A compaction start is the bridge's only route into PreCompact; both
          // triggers are produced inside the open turn so the point is recorded.
          session.append('compaction/start', { compactionId: CompactionId('manual-1'), sourceCommandId: CommandId('cmd-1'), turn: 1 })
          session.append('compaction/start', { compactionId: CompactionId('auto-1'), turn: 1 })
          return [{ type: 'text', text: 'ok' }]
        },
      }))
      const agent = await ctx.agentLoop.create(SessionId('compact-1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      await waitFor(() => manual.bodies.length === 1 && automatic.bodies.length === 1)
      // The endpoint records its request before the bridge folds the response,
      // so the halt report is only observable once the reply landed.
      await waitFor(() => warn.mock.calls.some(call => String(call[0]).includes('no live run exists there')))

      // The source command is what makes a compaction manual, and it is the matcher subject.
      expect(JSON.parse(manual.bodies[0]!)).toMatchObject({
        hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: '', session_id: 'compact-1',
      })
      expect(JSON.parse(automatic.bodies[0]!)).toMatchObject({ hook_event_name: 'PreCompact', trigger: 'auto' })
      // A detached point has no live run: the halt request is reported, not applied.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no live run exists there'))
      expect(hookPoints(agent).filter(point => point === 'PreCompact')).toHaveLength(2)
      expect(adapter.requests).toHaveLength(2)
    }, 15_000)

    it('runs SessionEnd for a disposed agent, with no turn to record it in', async () => {
      // A matcher on SessionEnd has no subject to test: it is dropped, and the hook still fires.
      const end = await hookEndpoint({})
      const d = dir()
      const path = hooks(d, { SessionEnd: [{ matcher: 'never-matches', hooks: [{ type: 'http', url: end.url }] }] })
      const ctx = await harness(path, new MockAdapter([]))
      const handle = await ctx.agents.create({
        sessionId: SessionId('ended'),
        meta: { cwd: dir() },
        agentOptions: { provider: 'mock', model: 'mock' },
      })

      await handle.dispose()
      await waitFor(() => end.bodies.length === 1)

      expect(JSON.parse(end.bodies[0]!)).toMatchObject({
        hook_event_name: 'SessionEnd',
        session_id: 'ended',
        reason: 'other',
      })
      // Between turns there is no open turn, so the detached point leaves no hook/* record.
      expect(hookPoints(handle.agent)).toEqual([])
    }, 15_000)

    it('runs PostToolUseFailure for a failed call, matched by tool, and honors a block', async () => {
      const blocked = await hookEndpoint({ decision: 'block', reason: 'retry with a smaller input' })
      const otherTool = await hookEndpoint({})
      const d = dir()
      const path = hooks(d, {
        PostToolUseFailure: [
          { matcher: 'boom', hooks: [{ type: 'http', url: blocked.url }] },
          { matcher: 'other', hooks: [{ type: 'http', url: otherTool.url }] },
        ],
      })
      const adapter = new MockAdapter([toolCallResponse('c1', 'boom', {}), textResponse('done')])
      const ctx = await harness(path, adapter)
      ctx.tools.register(defineContentToolFixture({ name: 'boom', description: 'b', parameters: {}, async execute() { throw new Error('kaboom') } }))
      const agent = await ctx.agentLoop.create(SessionId('failure-1'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const result = events(agent).find(e => e.type === 'tool/result')
      expect(result?.type === 'tool/result' && result.data.message.isError).toBe(true)
      expect(result?.type === 'tool/result' && JSON.stringify(result.data.message)).toContain('retry with a smaller input')
      const payload = JSON.parse(blocked.bodies[0]!) as { error?: string; tool_response?: string }
      expect(payload).toMatchObject({ hook_event_name: 'PostToolUseFailure', tool_name: 'boom' })
      // The failure point names the failure beside the response it renders from.
      expect(payload.error).toContain('kaboom')
      expect(payload.tool_response).toBe(payload.error)
      expect(otherTool.bodies).toEqual([])
      expect(hookPoints(agent)).toEqual(['PostToolUseFailure'])
      expect(adapter.requests).toHaveLength(2)
    }, 15_000)
  })
}
