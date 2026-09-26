import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMemoryStore, { EvolutionScopeId } from '../src/index.ts'
import type { Config } from '../src/index.ts'
import type { EvolutionScopeId as ScopeId } from '../src/types.ts'
import { digestOf } from '../src/digest.ts'

async function harness(config: Config) {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const lockDirectory = await mkdtemp(join(tmpdir(), 'dsh-evolution-memory-locks-'))
  // Object.assign: the Config interface shares its name with the schema value,
  // which trips no-misused-spread's class-instance check.
  const fiber = await ctx.plugin(EvolutionMemoryStore, Object.assign({ lockDirectory }, config))
  return { ctx, fiber, store: ctx.evolutionMemory }
}

function scope(name = 'ws-episodic'): ScopeId {
  return EvolutionScopeId('test', name)
}

describe('evolution-memory episodic tier', () => {
  it('appends a staged note verbatim with its UTC day, stamping no family', async () => {
    const { fiber, store } = await harness({ capacityBytes: 4096 })
    try {
      const id = scope()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(new Date('2026-09-14T08:00:00.000Z'))
        const staged = await store.stageWrite({
          scopeId: id, kind: 'memory', op: 'appendEpisodic',
          payload: { text: 'user corrected the approach at step 3' },
          originSessionId: 's1', gist: 'session note',
        })
        await store.approveStaged(staged.id)
      } finally {
        vi.useRealTimers()
      }
      const record = store.read(id)
      expect(record?.episodic).toEqual([{
        day: '2026-09-14',
        text: 'user corrected the approach at step 3',
        addedAt: '2026-09-14T08:00:00.000Z',
      }])
      expect(record?.staged).toEqual([])
      expect(record?.instructionsUpdatedAt).toBeNull()
      expect(record?.lessonsUpdatedAt).toBeNull()
      expect(record?.profileUpdatedAt).toBeNull()
      expect(record?.memoryUpdatedAt).toBeNull()
    } finally {
      await fiber.dispose()
    }
  })

  it('refuses a blank note and keeps the entry staged', async () => {
    const { fiber, store } = await harness({ capacityBytes: 4096 })
    try {
      const id = scope()
      const staged = await store.stageWrite({
        scopeId: id, kind: 'memory', op: 'appendEpisodic',
        payload: { text: '  \n ' }, originSessionId: 's1', gist: 'blank note',
      })
      await expect(store.approveStaged(staged.id)).rejects.toThrow("non-blank 'text'")
      expect(store.read(id)?.episodic).toEqual([])
      expect(store.read(id)?.staged.map(entry => entry.id)).toEqual([staged.id])
    } finally {
      await fiber.dispose()
    }
  })

  it('prunes notes past retention and keeps the newest past the count cap', async () => {
    const { fiber, store } = await harness({ capacityBytes: 4096, episodicRetentionDays: 1, maxEpisodicEntries: 2 })
    try {
      const id = scope()
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        const append = async (text: string): Promise<void> => {
          const staged = await store.stageWrite({
            scopeId: id, kind: 'memory', op: 'appendEpisodic',
            payload: { text }, originSessionId: 's1', gist: text,
          })
          await store.approveStaged(staged.id)
        }
        vi.setSystemTime(new Date('2026-09-10T00:00:00.000Z'))
        await append('old note')
        vi.setSystemTime(new Date('2026-09-12T00:00:00.000Z'))
        await append('new one')
        await append('new two')
        await append('new three')
      } finally {
        vi.useRealTimers()
      }
      expect(store.read(id)?.episodic.map(note => note.text)).toEqual(['new two', 'new three'])
    } finally {
      await fiber.dispose()
    }
  })

  it('counts note text toward capacity and never invalidates the brief digest', async () => {
    const { fiber, store } = await harness({ capacityBytes: 64 })
    try {
      const id = scope()
      await store.setInstructions(id, 'ok')
      const before = store.read(id)
      const usedBefore = store.usage(id).usedBytes
      const staged = await store.stageWrite({
        scopeId: id, kind: 'memory', op: 'appendEpisodic',
        payload: { text: 'y'.repeat(100) }, originSessionId: 's1', gist: 'oversized note',
      })
      await expect(store.approveStaged(staged.id)).rejects.toMatchObject({ code: 'evolution/capacity-exceeded' })
      expect(store.read(id)?.episodic).toEqual([])

      const fitting = await store.stageWrite({
        scopeId: id, kind: 'memory', op: 'appendEpisodic',
        payload: { text: 'fits' }, originSessionId: 's1', gist: 'small note',
      })
      await store.approveStaged(fitting.id)
      const after = store.read(id)
      expect(store.usage(id).usedBytes).toBe(usedBefore + 4)
      expect(after?.episodic).toHaveLength(1)
      expect(digestOf(after)).toBe(digestOf(before))
    } finally {
      await fiber.dispose()
    }
  })
})

describe('evolution-memory quick-add instructions', () => {
  it('appends a staged instruction after the existing document and stamps the family', async () => {
    const { fiber, store } = await harness({ capacityBytes: 4096 })
    try {
      const id = scope()
      await store.setInstructions(id, 'existing rule')
      const staged = await store.stageWrite({
        scopeId: id, kind: 'memory', op: 'appendInstructions',
        payload: { text: '  always run pnpm run lint  ' }, originSessionId: 's1', gist: 'remember lint',
      })
      expect(store.read(id)?.instructions).toBe('existing rule')
      await store.approveStaged(staged.id)

      const record = store.read(id)
      expect(record?.instructions).toBe('existing rule\n\nalways run pnpm run lint')
      expect(record?.instructionsUpdatedAt).not.toBeNull()
      expect(record?.staged).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('starts an empty instructions document and refuses a blank quick-add', async () => {
    const { fiber, store } = await harness({ capacityBytes: 4096 })
    try {
      const id = scope()
      const first = await store.stageWrite({
        scopeId: id, kind: 'memory', op: 'appendInstructions',
        payload: { text: 'first rule' }, originSessionId: 's1', gist: 'first',
      })
      await store.approveStaged(first.id)
      expect(store.read(id)?.instructions).toBe('first rule')

      const blank = await store.stageWrite({
        scopeId: id, kind: 'memory', op: 'appendInstructions',
        payload: { text: '  \n ' }, originSessionId: 's1', gist: 'blank',
      })
      await expect(store.approveStaged(blank.id)).rejects.toThrow("non-blank 'text'")
      expect(store.read(id)?.instructions).toBe('first rule')
      expect(store.read(id)?.staged.map(entry => entry.id)).toEqual([blank.id])
    } finally {
      await fiber.dispose()
    }
  })
})
