import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as evolutionMemoryContext from '../src/index.ts'

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted adapter recording every request it receives. */
class StubAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    return (async function* (): AsyncIterable<StreamChunk> {
      yield* textChunks('done')
    })()
  }
}

async function composition(): Promise<{
  ctx: Context
  loop: AgentLoopTestHarness
  requests: GenerateOptions[]
  workspaces: Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>
  dir: string
  dispose: () => Promise<void>
}> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'evx-')))
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const { default: EvolutionMemoryStore } = await import('@deepseek-ai/dsh-evolution-memory')
  await ctx.plugin(EvolutionMemoryStore, { capacityBytes: 65536 })
  const workspaces = new Map<string, { id: WorkspaceId; title: string; path: string; sessionIds: SessionId[] }>()
  ctx.provide('workspaceRegistry', {
    list: () => [...workspaces.values()],
    get: (id: WorkspaceId) => workspaces.get(String(id)),
  } as never)
  await mountAgentLoopTestDependencies(ctx)
  const adapter = new StubAdapter()
  const requests = adapter.requests
  ctx.llm.registerAdapter(['mock'], adapter)
  const fiber = await ctx.plugin(evolutionMemoryContext, { maxBytes: 8192, profile: 'test' })
  const loop = await mountAgentLoopTestHarness(ctx)
  return {
    ctx,
    loop,
    requests,
    workspaces,
    dir,
    dispose: () => fiber.dispose(),
  }
}

/** Wait for the agent's next transition to idle after a waking send. */
function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** User-message texts recorded in the log. */
function loggedUserTexts(agent: Agent): { text: string; kind: unknown }[] {
  return agent.session.ownEvents().flatMap((event) => {
    if (event.type !== 'user/message') return []
    const text = event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    return [{ text, kind: event.data.source.kind }]
  })
}

/** Every framed brief one request carried, in message order. */
function framedTexts(request: GenerateOptions | undefined): string[] {
  if (request === undefined) return []
  return request.messages
    .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    .filter(text => text.includes('<system-reminder>'))
}

describe('evolution-memory-context composition', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  it('briefs the model once through the real loop and the real log', async () => {
    const { ctx, loop, requests, workspaces, dir, dispose } = await composition()
    dirs.push(dir)
    try {
      const scope = EvolutionScopeId('test', 'ws-1')
      const agent = await loop.create(SessionId('evolution-composition'), { provider: 'mock', model: 'mock' }, { cwd: dir })
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [agent.session.id] })
      await ctx.evolutionMemory.setInstructions(scope, 'follow the guide')
      await ctx.evolutionMemory.addArtifact(scope, {
        statement: 'tabs win', source: 's1', conditions: '', evidence: 'fact', confidence: 0.9, scope: 'project',
        sourceRefs: ['session:s1'], trajectoryRefs: ['run:s1'], lineage: { origin: 's1' },
      })

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(requests.length).toBeGreaterThan(0)
      const briefed = requests[0]?.messages.filter(message => message.role === 'user') ?? []
      const briefTexts = briefed.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
      expect(briefTexts.some(text => text.includes('<system-reminder>') && text.includes('tabs win'))).toBe(true)

      const first = loggedUserTexts(agent).filter(entry => entry.kind === 'evolution-memory')
      expect(first).toHaveLength(1)

      // The unchanged record adds nothing on the second turn.
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'again' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(loggedUserTexts(agent).filter(entry => entry.kind === 'evolution-memory')).toHaveLength(1)

      // The system prompt never carries memory usage: that value belongs to
      // the brief (already varying with content), so a memory write must not
      // change the cached prefix's text.
      const system = requests[0]?.messages[0]
      const systemText = system?.role === 'system'
        ? system.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        : ''
      expect(systemText).not.toContain('usage')
      expect(systemText).not.toContain('skill_manage')
    } finally {
      await dispose()
    }
  })

  it('replaces the brief after a record change and injects nothing outside a scope', async () => {
    const { ctx, loop, requests, workspaces, dir, dispose } = await composition()
    dirs.push(dir)
    const elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'evx-other-')))
    dirs.push(elsewhere)
    try {
      const scope = EvolutionScopeId('test', 'ws-1')
      const agent = await loop.create(SessionId('evolution-replace'), { provider: 'mock', model: 'mock' }, { cwd: dir })
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: dir, sessionIds: [agent.session.id] })
      await ctx.evolutionMemory.setInstructions(scope, 'first rules')

      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      expect(loggedUserTexts(agent).filter(entry => entry.kind === 'evolution-memory')).toHaveLength(1)

      await ctx.evolutionMemory.setInstructions(scope, 'second rules')
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)

      const briefs = loggedUserTexts(agent).filter(entry => entry.kind === 'evolution-memory')
      expect(briefs).toHaveLength(2)
      expect(briefs[1]?.text).toContain('second rules')
      // The change commits a complete replacement and declares `supersedes`, so
      // the surface carries the live brief once: the superseded frame stays in
      // the log but never reaches the model.
      const framed = framedTexts(requests.at(-1))
      expect(framed).toHaveLength(1)
      expect(framed[0]).toContain('second rules')
      expect(framed[0]).not.toContain('first rules')

      const before = requests.length
      const outsider = await loop.create(SessionId('evolution-outsider'), { provider: 'mock', model: 'mock' }, { cwd: elsewhere })
      outsider.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
      await waitForIdle(ctx, outsider)
      expect(loggedUserTexts(outsider).filter(entry => entry.kind === 'evolution-memory')).toHaveLength(0)
      expect(requests.slice(before).flatMap(request => framedTexts(request))).toHaveLength(0)
    } finally {
      await dispose()
    }
  })
})
