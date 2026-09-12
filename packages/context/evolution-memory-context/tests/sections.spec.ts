import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { EvolutionScopeId } from '@deepseek-ai/dsh-evolution-memory'
import { SessionId } from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import * as evolutionMemoryContext from '../src/index.ts'
import {
  LESSONS_SKILLS_SECTION,
  MEMORY_SCOPE_SECTION,
  SESSION_SEARCH_SECTION,
  USAGE_VARIABLE,
  UNKNOWN_USAGE,
  formatUsage,
  lessonsSkillsText,
} from '../src/sections.ts'

/** Mount SystemPrompt and the injector with a visible `skill_manage` tool. */
async function nudgeHarness(config: {
  memoryNudgeInterval?: number
  skillNudgeInterval?: number
}): Promise<{ ctx: Context; fiber: { dispose(): Promise<void> } }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  ctx.provide('workspaceRegistry', { list: () => [] } as never)
  ctx.provide('evolutionMemory', {} as never)
  ctx.provide('tools', { get: (name: string) => name === 'skill_manage' ? {} : undefined } as never)
  const fiber = await ctx.plugin(evolutionMemoryContext, { maxBytes: 8192, profile: 'test', ...config })
  return { ctx, fiber }
}

/**
 * Count `turns` further `turn/start` events for the session, then render the
 * prompt its assembly would send.
 */
async function nudgePrompt(ctx: Context, session: SessionId, turns = 0): Promise<string> {
  for (let turn = 0; turn < turns; turn += 1) {
    ctx.emit('session/event', { id: session } as never, { type: 'turn/start' } as never)
  }
  const agent = { id: String(session), session: { id: session } } as unknown as Agent
  return renderPrompt(await ctx.systemPrompt.assemble({ agent }))
}

describe('evolution nudge sections', () => {
  it('pins the registered names, orders, and copy', () => {
    expect(LESSONS_SKILLS_SECTION.name).toBe('evolution-lessons-skills')
    expect(MEMORY_SCOPE_SECTION.name).toBe('evolution-memory-scope')
    expect(SESSION_SEARCH_SECTION.name).toBe('evolution-session-search')
    expect(new Set([
      LESSONS_SKILLS_SECTION.order,
      MEMORY_SCOPE_SECTION.order,
      SESSION_SEARCH_SECTION.order,
    ]).size).toBe(3)
    expect(LESSONS_SKILLS_SECTION.text).toContain('skill_manage')
    expect(MEMORY_SCOPE_SECTION.text).toContain(`{{${USAGE_VARIABLE}}}`)
    expect(SESSION_SEARCH_SECTION.text).toContain('search past sessions')
    expect(USAGE_VARIABLE).toBe('evolution_memory_usage')
    expect(UNKNOWN_USAGE).toBe('unknown')
  })

  it('shows the skills nudge only beside a visible skill tool', () => {
    expect(lessonsSkillsText(undefined)).toBe('')
    expect(lessonsSkillsText({})).toBe(LESSONS_SKILLS_SECTION.text)
  })

  it('formats capacity as used/cap (pct%)', () => {
    expect(formatUsage(10, 100)).toBe('10/100 (10%)')
    expect(formatUsage(12, 12)).toBe('12/12 (100%)')
    expect(formatUsage(0, 131072)).toBe('0/131072 (0%)')
  })

  it('assembles the variable without a session and drops the hidden nudge', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    ctx.provide('evolutionMemory', {} as never)
    const fiber = await ctx.plugin(evolutionMemoryContext, { maxBytes: 8192, profile: 'test' })
    try {
      const assembly = await ctx.systemPrompt.assemble({})
      const names = assembly.sections.map(section => section.name)
      expect(names).toContain('evolution-memory-scope')
      expect(names).toContain('evolution-session-search')
      const prompt = renderPrompt(assembly)
      expect(prompt).toContain('(usage unknown)')
      expect(prompt).not.toContain('skill_manage')
    } finally {
      await fiber.dispose()
    }
  })

  it('resolves the capacity variable for a scoped session', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
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
    const fiber = await ctx.plugin(evolutionMemoryContext, { maxBytes: 8192, profile: 'test' })
    try {
      const scope = EvolutionScopeId('test', 'ws-1')
      workspaces.set('ws-1', { id: WorkspaceId('ws-1'), title: 'Project', path: '/work', sessionIds: [SessionId('s1')] })
      await ctx.evolutionMemory.setInstructions(scope, 'rules')
      const agent = { id: 's1', session: { id: SessionId('s1') } } as unknown as Agent
      const prompt = renderPrompt(await ctx.systemPrompt.assemble({ agent }))
      expect(prompt).toContain('(usage 5/65536 (0%))')

      const outsider = { id: 'nope', session: { id: SessionId('nope') } } as unknown as Agent
      const cold = renderPrompt(await ctx.systemPrompt.assemble({ agent: outsider }))
      expect(cold).toContain('(usage unknown)')
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps the nudge hidden when the registry names no skill tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    ctx.provide('evolutionMemory', {} as never)
    const fiber = await ctx.plugin(evolutionMemoryContext, { maxBytes: 8192, profile: 'test' })
    try {
      const prompt = renderPrompt(await ctx.systemPrompt.assemble({}))
      expect(prompt).not.toContain('skill_manage')
    } finally {
      await fiber.dispose()
    }
  })
})

describe('evolution nudge turn intervals', () => {
  /** Static fragment of the scope nudge, free of the interpolated variable. */
  const SCOPE_FRAGMENT = 'Ignore it for work outside its directory'

  it('shows each nudge only on its interval-matching turn', async () => {
    const { ctx, fiber } = await nudgeHarness({ memoryNudgeInterval: 6, skillNudgeInterval: 4 })
    try {
      const session = SessionId('interval-turns')
      const cold = await nudgePrompt(ctx, session)
      expect(cold).not.toContain(LESSONS_SKILLS_SECTION.text)
      expect(cold).not.toContain(SCOPE_FRAGMENT)
      expect(cold).toContain(SESSION_SEARCH_SECTION.text)

      const first = await nudgePrompt(ctx, session, 1)
      expect(first).not.toContain(LESSONS_SKILLS_SECTION.text)
      expect(first).not.toContain(SCOPE_FRAGMENT)

      const fourth = await nudgePrompt(ctx, session, 3)
      expect(fourth).toContain(LESSONS_SKILLS_SECTION.text)
      expect(fourth).not.toContain(SCOPE_FRAGMENT)

      const sixth = await nudgePrompt(ctx, session, 2)
      expect(sixth).not.toContain(LESSONS_SKILLS_SECTION.text)
      expect(sixth).toContain(SCOPE_FRAGMENT)

      const twelfth = await nudgePrompt(ctx, session, 6)
      expect(twelfth).toContain(LESSONS_SKILLS_SECTION.text)
      expect(twelfth).toContain('(usage unknown)')

      const thirteenth = await nudgePrompt(ctx, session, 1)
      expect(thirteenth).not.toContain(LESSONS_SKILLS_SECTION.text)
      expect(thirteenth).not.toContain(SCOPE_FRAGMENT)
    } finally {
      await fiber.dispose()
    }
  })

  it('counts turn/start events per session independently', async () => {
    const { ctx, fiber } = await nudgeHarness({ skillNudgeInterval: 2 })
    try {
      const first = SessionId('counter-first')
      const second = SessionId('counter-second')
      expect(await nudgePrompt(ctx, first, 2)).toContain(LESSONS_SKILLS_SECTION.text)
      expect(await nudgePrompt(ctx, second, 1)).not.toContain(LESSONS_SKILLS_SECTION.text)
      expect(await nudgePrompt(ctx, second, 1)).toContain(LESSONS_SKILLS_SECTION.text)

      // Another event type leaves the count alone, so the next turn hides it again.
      ctx.emit('session/event', { id: first } as never, { type: 'step/start' } as never)
      expect(await nudgePrompt(ctx, first, 1)).not.toContain(LESSONS_SKILLS_SECTION.text)
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps the scope nudge on every turn at the default interval', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    ctx.provide('workspaceRegistry', { list: () => [] } as never)
    ctx.provide('evolutionMemory', {} as never)
    ctx.provide('tools', { get: (name: string) => name === 'skill_manage' ? {} : undefined } as never)
    // Direct apply bypasses the loader schema, so the omitted intervals here
    // exercise the built-in defaults rather than loader-filled values.
    evolutionMemoryContext.apply(ctx, { maxBytes: 8192, profile: 'test' })

    const session = SessionId('default-intervals')
    for (const turns of [0, 1, 3, 1, 1]) {
      const prompt = await nudgePrompt(ctx, session, turns)
      expect(prompt).toContain('(usage unknown)')
      expect(prompt).toContain(SESSION_SEARCH_SECTION.text)
    }
    // Six turns in, the default skills interval of 10 still withholds it.
    expect(await nudgePrompt(ctx, session)).not.toContain(LESSONS_SKILLS_SECTION.text)
  })
})
