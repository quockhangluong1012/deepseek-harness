/**
 * The selection as a compiler source: an agent-context composition places it as
 * one required source, records the placement, and reuses it while the objective
 * and the tree hold.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentContext from '@deepseek-ai/dsh-agent-context'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import RepoIndex from '@deepseek-ai/dsh-repo-index'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as WorkingSet from '../src/index.ts'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup()
  cleanups.length = 0
})

const ASSEMBLY = { sections: [], contexts: [], tools: [], variables: {} }

describe('working-set compiled context', () => {
  it('places the selection as a required source and records the compile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-working-set-context-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'auth-controller.ts'), [
      "import { AuthService } from './auth-service.ts'",
      '',
      'export class AuthController {',
      '  constructor(private readonly service: AuthService) {}',
      '}',
    ].join('\n'))
    await writeFile(join(root, 'auth-service.ts'), 'export class AuthService {}\n')
    await writeFile(join(root, 'package.json'), '{\n  "name": "context-fixture"\n}\n')
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(RepoIndex)
    await ctx.plugin(WorkingSet, {})
    await ctx.plugin(AgentContext, {})
    const session = ctx.sessions.create(SessionId('working-set-context'), { meta: { cwd: root } })
    const agent = { id: session.id, ctx, session } as Agent
    const message = createUserMessage({ content: [{ type: 'text', text: 'auth controller guard' }], source: { kind: 'user' } })
    await agent.ctx.waterfall('agent/pre-step', {
      agent,
      messages: [message],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    }, () => Promise.resolve({ kind: 'enter' as const, messages: [message] }))

    const placed = await ctx.agentContext.compile(agent, ASSEMBLY)
    const source = placed.included.find(entry => entry.source.id === 'working-set:set')
    expect(source?.source).toMatchObject({ kind: 'artifact', trust: 'untrusted', retention: 'required' })
    expect(source?.source.content).toContain('- auth-controller.ts')
    expect(source?.source.content).toContain('- auth-service.ts')

    const recorded = session.snapshotEvents().filter(event => event.type === 'context/compiled')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.data.included.map(entry => entry.id)).toContain('working-set:set')
    expect(recorded[0]?.data.included[0]?.retention).toBe('required')

    const reused = await ctx.agentContext.compile(agent, ASSEMBLY)
    expect(reused.included.find(entry => entry.source.id === 'working-set:set')?.source.content).toBe(source?.source.content)
    expect(session.snapshotEvents().filter(event => event.type === 'context/compiled')).toHaveLength(1)

    // A session that declares no workspace contributes no selection source at all.
    const bare = ctx.sessions.create(SessionId('working-set-context-bare'))
    const bareAgent = { id: bare.id, ctx, session: bare } as Agent
    const empty = await ctx.agentContext.compile(bareAgent, ASSEMBLY)
    expect(empty.included.filter(entry => entry.source.id === 'working-set:set')).toEqual([])

    // A compile before any pre-step selects on demand rather than reading a
    // selection the listener never rendered.
    const cold = ctx.sessions.create(SessionId('working-set-context-cold'), { meta: { cwd: root } })
    cold.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'auth controller guard' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const coldAgent = { id: cold.id, ctx, session: cold } as Agent
    const onDemand = await ctx.agentContext.compile(coldAgent, ASSEMBLY)
    expect(onDemand.included.find(entry => entry.source.id === 'working-set:set')?.source.content).toContain('- auth-controller.ts')
  }, 60_000)
})
