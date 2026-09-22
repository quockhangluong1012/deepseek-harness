import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionCanary from '../src/index.ts'
import type { DeploymentInput } from '../src/index.ts'

async function boot(backend = new MemoryStorageBackend(new MemoryMediaPool())) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionCanary)
  return { ctx, fiber, store: ctx.evolutionCanary }
}

const input = (overrides: Partial<DeploymentInput> = {}): DeploymentInput => ({
  id: 'staged-0',
  skill: 'writer',
  triple: { pass: true, tokens: 3, wallTimeMs: 5 },
  ...overrides,
})

describe('evolution canary', () => {
  it('enters a deployment in shadow with its measured triple', async () => {
    const { fiber, store } = await boot()
    try {
      const record = await store.enter(input())
      expect(record).toMatchObject({
        id: 'staged-0',
        skill: 'writer',
        state: 'shadow',
        triple: { pass: true, tokens: 3, wallTimeMs: 5 },
        decidedAt: null,
      })
      expect(record.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(record.enteredAt).toBe(record.at)
      await expect(store.enter(input())).rejects.toThrow("deployment 'staged-0' already exists")
      const unmeasured = await store.enter(input({ id: 'staged-1', triple: null }))
      expect(unmeasured.triple).toBeNull()
    } finally {
      await fiber.dispose()
    }
  })

  it('rolls a deployment through the ladder and stamps terminal decisions', async () => {
    const { fiber, store } = await boot()
    try {
      await store.enter(input())
      const canary = await store.advance('staged-0', 'canary')
      expect(canary.state).toBe('canary')
      expect(canary.decidedAt).toBeNull()
      const promoted = await store.advance('staged-0', 'promoted')
      expect(promoted.state).toBe('promoted')
      expect(promoted.decidedAt).not.toBeNull()
      await expect(store.advance('staged-0', 'shadow')).rejects.toThrow(/illegal transition promoted → shadow/)
    } finally {
      await fiber.dispose()
    }
  })

  it('exits staged rollouts to rejected and rolled-back', async () => {
    const { fiber, store } = await boot()
    try {
      await store.enter(input())
      const rejected = await store.advance('staged-0', 'rejected')
      expect(rejected.state).toBe('rejected')
      expect(rejected.decidedAt).not.toBeNull()
      await store.enter(input({ id: 'staged-1' }))
      await store.advance('staged-1', 'canary')
      const rolledBack = await store.advance('staged-1', 'rolled-back')
      expect(rolledBack.state).toBe('rolled-back')
      expect(rolledBack.decidedAt).not.toBeNull()
      await expect(store.advance('staged-1', 'canary')).rejects.toThrow(/illegal transition rolled-back → canary/)
      await expect(store.advance('ghost', 'canary')).rejects.toThrow("unknown deployment 'ghost'")
      // Same-state resolves without writing.
      await expect(store.advance('staged-1', 'rolled-back')).resolves.toMatchObject({ state: 'rolled-back' })
    } finally {
      await fiber.dispose()
    }
  })

  it('lists deployments in ladder order, filters, and detaches copies', async () => {
    const { fiber, store } = await boot()
    try {
      await store.enter(input())
      await store.enter(input({ id: 'staged-1' }))
      await store.advance('staged-1', 'canary')
      await store.enter(input({ id: 'staged-2', skill: 'polish' }))
      const bySkill = store.deployments(undefined, 'writer')
      expect(bySkill.map(record => record.state)).toEqual(['shadow', 'canary'])
      expect(store.deployments('shadow')).toHaveLength(2)
      expect(store.deployments('promoted')).toHaveLength(0)
      const copy = store.deployments()
      ;(copy[0] as { skill: string }).skill = 'mutated'
      expect(store.deployments()[0]?.skill).not.toBe('mutated')
    } finally {
      await fiber.dispose()
    }
  })

  it('summarizes per-state counts with zeros never omitted', async () => {
    const { fiber, store } = await boot()
    try {
      expect(store.summary()).toEqual({ total: 0, byState: { shadow: 0, canary: 0, promoted: 0, 'rolled-back': 0, rejected: 0 } })
      await store.enter(input())
      await store.enter(input({ id: 'staged-1' }))
      await store.advance('staged-1', 'canary')
      await store.enter(input({ id: 'staged-2', skill: 'polish' }))
      expect(store.summary('writer')).toEqual({ total: 2, byState: { shadow: 1, canary: 1, promoted: 0, 'rolled-back': 0, rejected: 0 } })
      expect(store.summary()).toMatchObject({ total: 3, byState: { shadow: 2, canary: 1 } })
    } finally {
      await fiber.dispose()
    }
  })

  it('survives a restart through the zod spec', async () => {
    const backend = new MemoryStorageBackend(new MemoryMediaPool())
    const first = await boot(backend)
    try {
      await first.store.enter(input())
      await first.store.advance('staged-0', 'canary')
    } finally {
      await first.fiber.dispose()
    }
    const second = await boot(backend)
    try {
      expect(second.store.deployments()).toHaveLength(1)
      expect(second.store.deployments()[0]).toMatchObject({ id: 'staged-0', state: 'canary' })
    } finally {
      await second.fiber.dispose()
    }
  })

  it('reads throw before the store starts', () => {
    const ctx = new Context()
    const store = new EvolutionCanary(ctx)
    expect(() => store.deployments()).toThrow('not started yet')
    expect(() => store.summary()).toThrow('not started yet')
  })
})
