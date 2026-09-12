import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionSkillTelemetry, { isExcludedSkillSource, skillCreationEvidence } from '../src/index.ts'

interface FakeSkill {
  name: string
  source: string
}

async function harness(sources: Record<string, string> = {}) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const skills: FakeSkill[] = Object.entries(sources).map(([name, source]) => ({ name, source }))
  ctx.provide('skills', {
    list: async () => skills.map(skill => ({ ...skill })),
  } as never)
  const fiber = await ctx.plugin(EvolutionSkillTelemetry)
  return { ctx, fiber, store: ctx.evolutionSkillTelemetry }
}

describe('evolution skill telemetry', () => {
  it('classifies excluded sources', () => {
    expect(isExcludedSkillSource('bundled')).toBe(true)
    expect(isExcludedSkillSource('hub')).toBe(true)
    expect(isExcludedSkillSource('hub-community')).toBe(true)
    expect(isExcludedSkillSource('user-dsh')).toBe(false)
    expect(isExcludedSkillSource('project-dsh')).toBe(false)
    expect(isExcludedSkillSource('custom')).toBe(false)
  })

  it('reads absent skills as undefined', async () => {
    const { fiber, store } = await harness()
    expect(store.read('missing')).toBeUndefined()
    expect(store.entries()).toEqual([])
    await fiber.dispose()
  })

  it('counts uses, views, and patches with timestamps', async () => {
    const { fiber, store } = await harness({ catalog: 'user-dsh' })
    const used = await store.markUsed('catalog')
    expect(used).toMatchObject({ useCount: 1, viewCount: 0, patchCount: 0 })
    expect(typeof used?.createdAt).toBe('string')
    expect(typeof used?.lastUsedAt).toBe('string')
    expect(used?.lastViewedAt).toBeNull()
    const viewed = await store.markViewed('catalog')
    expect(viewed).toMatchObject({ useCount: 1, viewCount: 1 })
    expect(typeof viewed?.lastViewedAt).toBe('string')
    const patched = await store.markPatched('catalog')
    expect(patched).toMatchObject({ patchCount: 1 })
    expect(typeof patched?.lastPatchedAt).toBe('string')
    expect(store.entries()).toHaveLength(1)
    expect(store.entries()[0]).toMatchObject({ name: 'catalog' })
    await fiber.dispose()
  })

  it('skips bundled and hub skills without writing', async () => {
    const { fiber, store } = await harness({ box: 'bundled', shared: 'hub-nightly' })
    expect(await store.markUsed('box')).toBeUndefined()
    expect(await store.markViewed('box', 'bundled')).toBeUndefined()
    expect(await store.markPatched('shared')).toBeUndefined()
    expect(store.read('box')).toBeUndefined()
    expect(store.read('shared')).toBeUndefined()
    expect(store.entries()).toEqual([])
    await fiber.dispose()
  })

  it('records unknown skills under a recordable source', async () => {
    const { fiber, store } = await harness()
    const record = await store.markUsed('ghost')
    expect(record).toMatchObject({ useCount: 1 })
    const failing = new Context()
    await failing.plugin(Storage)
    failing.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(failing, { backend: 'memory', routes: {} })
    failing.storage.mount('domain', facility)
    failing.provide('storageDomain', facility)
    failing.provide('skills', {
      list: async () => {
        throw new Error('catalog offline')
      },
    } as never)
    const other = await failing.plugin(EvolutionSkillTelemetry)
    try {
      expect(await failing.evolutionSkillTelemetry.markUsed('ghost')).toMatchObject({ useCount: 1 })
    } finally {
      await other.dispose()
    }
    await fiber.dispose()
  })

  it('marks background authorship once', async () => {
    const { fiber, store } = await harness()
    const first = await store.markAgentCreated('writer')
    expect(first.createdBy).toBe('agent')
    const second = await store.markAgentCreated('writer')
    expect(second).toEqual(first)
    await fiber.dispose()
  })

  it('adopts agent-created skills without resetting clocks', async () => {
    const { fiber, store } = await harness()
    await expect(store.markAdopted('ghost')).rejects.toThrow("has no record for 'ghost'")
    const seeded = await store.markAgentCreated('writer')
    const adopted = await store.markAdopted('writer')
    expect(adopted).toMatchObject({ createdBy: 'foreground' })
    expect(adopted.createdAt).toBe(seeded.createdAt)
    await expect(store.markAdopted('writer')).rejects.toThrow('without background-review authorship')
    await store.markUsed('plain')
    await expect(store.markAdopted('plain')).rejects.toThrow('without background-review authorship')
    await fiber.dispose()
  })

  it('drops records reporting whether one existed', async () => {
    const { fiber, store } = await harness()
    await store.markUsed('dust')
    expect(await store.drop('dust')).toBe(true)
    expect(store.read('dust')).toBeUndefined()
    expect(await store.drop('dust')).toBe(false)
    await fiber.dispose()
  })
  it('pins and unpins without rewriting unchanged state', async () => {
    const { fiber, store } = await harness()
    expect((await store.setPinned('keep', true)).pinned).toBe(true)
    expect((await store.setPinned('keep', true)).pinned).toBe(true)
    expect(store.read('keep')).toMatchObject({ pinned: true })
    expect((await store.setPinned('keep', false)).pinned).toBe(false)
    await fiber.dispose()
  })

  it('moves lifecycle states with archive stamps', async () => {
    const { fiber, store } = await harness()
    expect(await store.setState('old', 'active')).toMatchObject({ state: 'active', archivedAt: null })
    expect(await store.setState('old', 'stale')).toMatchObject({ state: 'stale', archivedAt: null })
    const archived = await store.setState('old', 'archived', 'umbrella')
    expect(archived).toMatchObject({ state: 'archived', absorbedInto: 'umbrella' })
    expect(typeof archived.archivedAt).toBe('string')
    const revived = await store.setState('old', 'active')
    expect(revived).toMatchObject({ state: 'active', absorbedInto: null, archivedAt: null })
    await fiber.dispose()
  })

  it('counts skill-tool loads and ignores failures and foreign tools', async () => {
    const { ctx, fiber, store } = await harness({ catalog: 'user-dsh' })
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const signal = new AbortController().signal
      const nameParam = { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'd' } as const
      ctx.tools.register(defineContentToolFixture({
        name: 'skill',
        description: 'd',
        parameters: { name: nameParam },
        execute: async () => [{ type: 'text' as const, text: 'body' }],
      }))
      ctx.tools.register(defineContentToolFixture({
        name: 'other',
        description: 'd',
        parameters: {},
        execute: async () => [{ type: 'text' as const, text: 'other' }],
      }))
      ctx.tools.register(defineContentToolFixture({
        name: 'broken',
        description: 'd',
        parameters: {},
        execute: async () => {
          throw new Error('tool offline')
        },
      }))
      await ctx.tools.execute({ callId: ToolCallId('c1'), name: 'other', arguments: {}, signal })
      await ctx.tools.execute({ callId: ToolCallId('c2'), name: 'broken', arguments: {}, signal })
      await ctx.tools.execute({ callId: ToolCallId('c3'), name: 'skill', arguments: { name: 'catalog' }, signal })
      await vi.waitFor(() => {
        expect(store.read('catalog')?.useCount).toBe(1)
      })
      expect(store.read('other')).toBeUndefined()
      expect(store.read('broken')).toBeUndefined()
      // A successful load without a skill name records nothing.
      await ctx.tools.execute({ callId: ToolCallId('c4'), name: 'skill', arguments: {}, signal })
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(store.read('catalog')?.useCount).toBe(1)
    } finally {
      await fiber.dispose()
    }
  })

  it('warns instead of rejecting when use recording fails', async () => {
    const { ctx, fiber, store } = await harness({ catalog: 'user-dsh' })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    try {
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.tools.register(defineContentToolFixture({
        name: 'skill',
        description: 'd',
        parameters: { name: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'd' } },
        execute: async () => [{ type: 'text' as const, text: 'body' }],
      }))
      const broken = vi.spyOn(store, 'markUsed').mockRejectedValueOnce(new Error('store offline'))
      const result = await ctx.tools.execute({
        callId: ToolCallId('c1'),
        name: 'skill',
        arguments: { name: 'catalog' },
        signal: new AbortController().signal,
      })
      expect(result.isError).toBe(false)
      await vi.waitFor(() => {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('use recording failed'))
      })
      expect(broken).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      await fiber.dispose()
    }
  })

  it('stored objects never leak by reference', async () => {
    const { fiber, store } = await harness()
    const record = await store.markUsed('catalog')
    if (record === undefined) throw new Error('expected a stored record')
    record.useCount = 99
    expect(store.read('catalog')?.useCount).toBe(1)
    await fiber.dispose()
  })

  it('reads fail before the store starts', async () => {
    const ctx = new Context()
    const store = new EvolutionSkillTelemetry(ctx)
    expect(() => store.read('x')).toThrow('not started yet')
    expect(() => store.entries()).toThrow('not started yet')
  })
})

describe('skill creation evidence', () => {
  it('counts nothing as evidence without produced outputs', () => {
    expect(skillCreationEvidence([])).toEqual({ repeated: [], fires: false })
    expect(skillCreationEvidence(['out/report.md'])).toEqual({ repeated: [], fires: false })
  })

  it('fires at the third similar output and not before', () => {
    const twice = skillCreationEvidence(['out/report.md', 'out/report.md'])
    expect(twice).toEqual({ repeated: [], fires: false })
    const thrice = skillCreationEvidence(['out/report.md', 'out/report.md', 'out/report.md'])
    expect(thrice.fires).toBe(true)
    expect(thrice.repeated).toEqual([{ path: 'out/report.md', count: 3 }])
  })

  it('groups outputs by normalized path without reading their content', () => {
    const evidence = skillCreationEvidence([
      'out\\Report.md',
      'OUT/report.md',
      'out/report.md/',
      'out/other.md',
      'out/other.md',
    ])
    expect(evidence.fires).toBe(true)
    // Most produced first, ties in first-seen order; the first-seen spelling is reported.
    expect(evidence.repeated).toEqual([
      { path: 'out\\Report.md', count: 3 },
    ])
  })

  it('orders repeated groups by count', () => {
    const evidence = skillCreationEvidence([
      'a.md', 'a.md', 'a.md',
      'b.md', 'b.md', 'b.md', 'b.md',
      'c.md', 'c.md', 'c.md',
    ])
    expect(evidence.repeated).toEqual([
      { path: 'b.md', count: 4 },
      { path: 'a.md', count: 3 },
      { path: 'c.md', count: 3 },
    ])
  })
})

describe('consolidation cost row', () => {
  it('records the frozen row shape and reads a detached copy', async () => {
    const { fiber, store } = await harness()
    expect(store.readConsolidationCost()).toBeUndefined()

    store.recordConsolidationCost({
      inputBytes: 131_072,
      maxOutputTokens: 1_024,
      provider: 'deepseek',
      model: 'deepseek-chat',
      truncated: false,
    })
    expect(store.readConsolidationCost()).toEqual({
      inputBytes: 131_072,
      maxOutputTokens: 1_024,
      provider: 'deepseek',
      model: 'deepseek-chat',
      truncated: false,
    })
    expect(store.readConsolidationCost()).not.toBe(store.readConsolidationCost())

    store.recordConsolidationCost({
      inputBytes: 4_096,
      maxOutputTokens: 512,
      provider: 'openrouter',
      model: 'aux/flash',
      truncated: true,
    })
    expect(store.readConsolidationCost()).toMatchObject({ inputBytes: 4_096, truncated: true, provider: 'openrouter' })
    await fiber.dispose()
  })
})
