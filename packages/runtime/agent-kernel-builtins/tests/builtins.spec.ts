/**
 * Built-in declarations: registered once the kernel exists, resolvable for
 * every declared tool, total over every argument shape, and removed on unload.
 *
 * @module @deepseek-ai/dsh-agent-kernel-builtins/tests/builtins
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import type { CapabilityRequest } from '@deepseek-ai/dsh-agent-kernel'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { apply as applyBuiltins, BUILTIN_DECLARATIONS, name } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount the loop prerequisites, the kernel, and the builtins plugin. */
async function mounted(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentKernel, {})
  await ctx.plugin({ name, apply: applyBuiltins, inject: ['agentKernel'] })
  return ctx
}

/** Resolve one declared tool and return its capability requests. */
function resolved(ctx: Context, tool: string, args: unknown): readonly CapabilityRequest[] | undefined {
  return ctx.agentKernel.capabilities.resolve(tool, args)
}

describe('registration', () => {
  it('registers every declaration once the kernel exists', async () => {
    const ctx = await mounted()

    expect(ctx.agentKernel.capabilities.size).toBe(BUILTIN_DECLARATIONS.length)
    for (const declaration of BUILTIN_DECLARATIONS) {
      expect(ctx.agentKernel.capabilities.has(declaration.tool)).toBe(true)
    }
  })

  it('resolves every declaration for empty arguments without throwing', async () => {
    const ctx = await mounted()

    for (const declaration of BUILTIN_DECLARATIONS) {
      const requests = resolved(ctx, declaration.tool, {})
      expect(requests, declaration.tool).toBeDefined()
      expect(requests?.length).toBe(declaration.capabilities.length)
      for (const request of requests ?? []) {
        expect(request.resource.length).toBeGreaterThan(0)
      }
    }
  })

  it('removes exactly its declarations when the plugin unloads', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentKernel, {})
    const fiber = await ctx.plugin({ name, apply: applyBuiltins, inject: ['agentKernel'] })
    expect(ctx.agentKernel.capabilities.has('read')).toBe(true)

    await fiber.dispose()

    expect(ctx.agentKernel.capabilities.size).toBe(0)
  })

  it('registers regardless of mount order', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin({ name, apply: applyBuiltins, inject: ['agentKernel'] })
    expect(ctx.get('agentKernel')).toBeUndefined()

    await ctx.plugin(AgentKernel, {})

    expect(ctx.agentKernel.capabilities.size).toBe(BUILTIN_DECLARATIONS.length)
  })

  it('lets a declared built-in tool run under enforce mode', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentKernel, {
      mode: 'enforce',
      policy: { defaults: { effect: 'allow' }, rules: [] },
    })
    await ctx.plugin({ name, apply: applyBuiltins, inject: ['agentKernel'] })
    ctx.tools.register(defineContentToolFixture({
      name: 'read',
      description: 'fixture read',
      parameters: { file_path: { type: 'string', required: true } },
      async execute() { return [{ type: 'text' as const, text: 'ok' }] },
    }))
    const scope = ctx.plugin(() => {})
    const id = SessionId('agent-builtins-e2e')
    const agent: Agent = {
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
    ctx.agents.register(agent)
    await ctx.waterfall(
      'agent/pre-step',
      {
        agent,
        messages: [createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } })],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('builtins-e2e-call'),
      name: 'read',
      arguments: { file_path: 'src/a.ts' },
      agent,
    })

    expect(result.isError).toBe(false)
    const types = agent.session.snapshotEvents().map(event => event.type)
    expect(types).toContain('action/authorized')
    expect(types).toContain('action/committed')
    expect(types).not.toContain('action/denied')
  })
})

describe('resource projection', () => {
  it('projects file paths for the filesystem tools', async () => {
    const ctx = await mounted()

    expect(resolved(ctx, 'read', { file_path: 'src/a.ts' })).toEqual([{ capability: 'fs.read', resource: 'src/a.ts' }])
    expect(resolved(ctx, 'write', { file_path: 'src/a.ts' })).toEqual([{ capability: 'fs.write', resource: 'src/a.ts' }])
    expect(resolved(ctx, 'edit', { file_path: 'src/a.ts' })).toEqual([{ capability: 'fs.edit', resource: 'src/a.ts' }])
    expect(resolved(ctx, 'read', {})).toEqual([{ capability: 'fs.read', resource: 'read' }])
  })

  it('prefers an explicit directory over the search pattern', async () => {
    const ctx = await mounted()

    expect(resolved(ctx, 'glob', { pattern: '**/*.ts', path: 'src' })).toEqual([{ capability: 'fs.read', resource: 'src' }])
    expect(resolved(ctx, 'grep', { pattern: 'TODO' })).toEqual([{ capability: 'fs.read', resource: 'TODO' }])
  })

  it('declares the editor for reading and editing under one path', async () => {
    const ctx = await mounted()

    const requests = resolved(ctx, 'str_replace_editor', { command: 'view', path: 'src/a.ts' })
    expect(requests?.map(request => request.capability)).toEqual(['fs.read', 'fs.edit'])
    expect(new Set(requests?.map(request => request.resource))).toEqual(new Set(['src/a.ts']))
  })

  it('projects commands, queries, urls, and descriptions', async () => {
    const ctx = await mounted()

    expect(resolved(ctx, 'bash', { command: 'git status' })).toEqual([{ capability: 'process.exec', resource: 'git status' }])
    expect(resolved(ctx, 'pwsh', { command: 'Get-ChildItem' })).toEqual([{ capability: 'process.exec', resource: 'Get-ChildItem' }])
    expect(resolved(ctx, 'web_fetch', { url: 'https://example.com' }))
      .toEqual([{ capability: 'network.read', resource: 'https://example.com' }])
    expect(resolved(ctx, 'web_search', { queries: ['harness', 'kernel'] }))
      .toEqual([{ capability: 'network.read', resource: 'harness kernel' }])
    expect(resolved(ctx, 'web_search', { queries: [] }))
      .toEqual([{ capability: 'network.read', resource: 'web' }])
    expect(resolved(ctx, 'subagent', { description: 'research' }))
      .toEqual([{ capability: 'subagent.spawn', resource: 'research' }])
    expect(resolved(ctx, 'ralph', { objective: 'migrate' }))
      .toEqual([{ capability: 'workflow.start', resource: 'migrate' }])
    expect(resolved(ctx, 'run_code', { description: 'probe' }))
      .toEqual([{ capability: 'process.exec', resource: 'probe' }])
  })

  it('accepts both delegation-agent id shapes', async () => {
    const ctx = await mounted()

    expect(resolved(ctx, 'interrupt_agent', { agent_id: 'agent-1' }))
      .toEqual([{ capability: 'subagent.spawn', resource: 'agent-1' }])
    expect(resolved(ctx, 'interrupt_agent', { target: 'agent-2' }))
      .toEqual([{ capability: 'subagent.spawn', resource: 'agent-2' }])
    expect(resolved(ctx, 'send_message', { agent_id: 'agent-1' }))
      .toEqual([{ capability: 'subagent.spawn', resource: 'agent-1' }])
  })

  it('reads workflow names from meta before the title', async () => {
    const ctx = await mounted()

    expect(resolved(ctx, 'workflow', { meta: { name: 'migrate' }, title: 'other' }))
      .toEqual([{ capability: 'workflow.start', resource: 'migrate' }])
    expect(resolved(ctx, 'workflow', { title: 'other' }))
      .toEqual([{ capability: 'workflow.start', resource: 'other' }])
    expect(resolved(ctx, 'workflow', { meta: {}, title: 'other' }))
      .toEqual([{ capability: 'workflow.start', resource: 'other' }])
    expect(resolved(ctx, 'workflow', {})).toEqual([{ capability: 'workflow.start', resource: 'workflow' }])
  })

  it('joins question ids and presentation paths', async () => {
    const ctx = await mounted()

    expect(resolved(ctx, 'ask_user_question', { questions: [{ id: 'mode' }, { id: 'scope' }] }))
      .toEqual([{ capability: 'approval.request', resource: 'mode scope' }])
    expect(resolved(ctx, 'ask_user_question', { questions: 'nope' }))
      .toEqual([{ capability: 'approval.request', resource: 'user' }])
    expect(resolved(ctx, 'ask_user_question', { questions: [] }))
      .toEqual([{ capability: 'approval.request', resource: 'user' }])
    expect(resolved(ctx, 'present', { files: [{ path: 'a.md' }, { path: 'b.md' }] }))
      .toEqual([{ capability: 'fs.read', resource: 'a.md b.md' }])
    expect(resolved(ctx, 'present', { files: [{ path: 42 }] }))
      .toEqual([{ capability: 'fs.read', resource: 'present' }])
    expect(resolved(ctx, 'present', { path: 'solo.md' }))
      .toEqual([{ capability: 'fs.read', resource: 'solo.md' }])
  })

  it('never throws on hostile argument shapes', async () => {
    const ctx = await mounted()
    const hostile: readonly unknown[] = [undefined, null, 42, 'text', [], { questions: [{ id: 42 }] }]

    for (const declaration of BUILTIN_DECLARATIONS) {
      for (const args of hostile) {
        const requests = resolved(ctx, declaration.tool, args)
        expect(requests, `${declaration.tool} with ${String(args)}`).toBeDefined()
        for (const request of requests ?? []) {
          expect(request.resource.length).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('tool catalog inventory', () => {
  it('declares every name the generated catalog lists', () => {
    const catalog = readFileSync(resolve(import.meta.dirname, '../../../../docs/tool-catalog.md'), 'utf8')
    const map = catalog.slice(catalog.indexOf('## Tool Package Map'), catalog.indexOf('\n## ', catalog.indexOf('## Tool Package Map') + 1))
    const names = new Set<string>()
    for (const line of map.split('\n')) {
      if (!line.startsWith('| `@deepseek-ai/')) continue
      const cells = line.split('|').map(cell => cell.trim()) as string[]
      for (const cell of [cells[2] ?? '', cells[5] ?? '']) {
        for (const match of cell.matchAll(/`([^`]+)`/g)) names.add(match[1]?.trim() ?? '')
      }
    }
    expect(names.size).toBeGreaterThan(0)
    const declared = new Set(BUILTIN_DECLARATIONS.map(declaration => declaration.tool))
    expect([...names].sort()).toEqual([...declared].sort())
  })
})
