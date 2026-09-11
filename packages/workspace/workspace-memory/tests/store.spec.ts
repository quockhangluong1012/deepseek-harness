import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceMemoryStore from '../src/index.ts'
import { digestOf } from '../src/digest.ts'

async function harness(
  config: { capacityBytes: number; maxContextItems?: number; maxOutputs?: number } = { capacityBytes: 1024 },
) {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(WorkspaceMemoryStore, config)
  return { ctx, fiber, store: ctx.workspaceMemory }
}

describe('workspace-memory store', () => {
  it('absent record reads empty', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    expect(store.read(id)).toBeUndefined()
    expect(store.usage(id)).toEqual({ usedBytes: 0, capacityBytes: 1024 })
    expect(store.digest(id)).toBe('empty')
    await fiber.dispose()
  })

  it('first write seeds the record and stamps updatedAt', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    const record = await store.setInstructions(id, 'follow the repo guide')
    expect(record.instructions).toBe('follow the repo guide')
    expect(record.description).toBe('')
    expect(typeof record.updatedAt).toBe('string')
    expect(store.read(id)?.instructions).toBe('follow the repo guide')
    await fiber.dispose()
  })

  it('field caps reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024 })
    const id = WorkspaceId('ws-1')
    await store.setInstructions(id, 'ok')
    const before = store.read(id)
    await expect(store.setInstructions(id, 'x'.repeat(70000))).rejects.toMatchObject({ code: 'workspace-memory/too-large' })
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('capacity cap rejects context items that would overflow', async () => {
    const { fiber, store } = await harness({ capacityBytes: 10 })
    const id = WorkspaceId('ws-1')
    await expect(store.addContextItem(id, { kind: 'text', label: 'a', text: '0123456789x' })).rejects.toMatchObject({
      code: 'workspace-memory/capacity-exceeded',
    })
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('remove of unknown item rejects', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    await store.setDescription(id, 'blurb')
    await expect(store.removeContextItem(id, 'missing')).rejects.toMatchObject({ code: 'workspace-memory/item-not-found' })
    await fiber.dispose()
  })

  it('recordOutputs prepends newest-first and never re-injects the brief', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    await store.setInstructions(id, 'i')
    const withContent = store.digest(id)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }])
    expect(store.digest(id)).toBe(withContent)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }])
    expect(store.read(id)?.outputs).toHaveLength(1)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' }])
    expect(store.read(id)?.outputs[0]?.at).toBe('2026-01-02T00:00:00.000Z')
    expect(store.digest(id)).toBe(withContent)
    // A repeat at the same instant with new facts collapses onto the newer entry.
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'edit', sessionId: 's2', at: '2026-01-02T00:00:00.000Z' }])
    expect(store.read(id)?.outputs).toHaveLength(1)
    expect(store.read(id)?.outputs[0]).toMatchObject({ tool: 'edit', sessionId: 's2' })
    expect(store.digest(id)).toBe(withContent)
    await fiber.dispose()
  })

  it('digest covers instructions, memory, and context only', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    await store.setInstructions(id, 'i')
    const a = store.digest(id)
    await store.setDescription(id, 'blurb')
    expect(store.digest(id)).toBe(a)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }])
    expect(store.digest(id)).toBe(a)
    expect(digestOf(undefined)).toBe('empty')
    await fiber.dispose()
  })

  it('stored objects never leak by reference', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    const record = await store.setInstructions(id, 'i')
    record.instructions = 'mutated'
    expect(store.read(id)?.instructions).toBe('i')
    await fiber.dispose()
  })

  it('description caps reject without mutating', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    await store.setDescription(id, 'blurb')
    const before = store.read(id)
    await expect(store.setDescription(id, 'x'.repeat(5000))).rejects.toMatchObject({ code: 'workspace-memory/too-large' })
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('instructions pushing past capacity reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 10 })
    const id = WorkspaceId('ws-1')
    await expect(store.setInstructions(id, '0123456789x')).rejects.toMatchObject({
      code: 'workspace-memory/capacity-exceeded',
    })
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('setMemory stamps memoryUpdatedAt and keeps provenance', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    expect(store.read(id)).toBeUndefined()
    const record = await store.setMemory(id, 'doc', {
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 's1',
      provider: 'p',
      model: 'm',
      inputBytes: 12,
      truncated: false,
    })
    expect(record.memory).toBe('doc')
    expect(typeof record.memoryUpdatedAt).toBe('string')
    expect(record.lastExtraction).toMatchObject({ provider: 'p', model: 'm', truncated: false })
    expect(store.usage(id).usedBytes).toBe(Buffer.byteLength('doc', 'utf8'))
    await fiber.dispose()
  })

  it('memory caps and capacity reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 64 })
    const id = WorkspaceId('ws-1')
    await store.setMemory(id, 'ok')
    const before = store.read(id)
    await expect(store.setMemory(id, 'x'.repeat(70000))).rejects.toMatchObject({ code: 'workspace-memory/too-large' })
    await expect(store.setMemory(id, 'y'.repeat(100))).rejects.toMatchObject({ code: 'workspace-memory/capacity-exceeded' })
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('field rewrites account for retained context item bytes', async () => {
    const { fiber, store } = await harness({ capacityBytes: 12 })
    const id = WorkspaceId('ws-1')
    await store.addContextItem(id, { kind: 'text', label: 'note', text: 'hello' })
    await store.setInstructions(id, 'abcdefg')
    await store.setMemory(id, '')
    expect(store.usage(id).usedBytes).toBe(12)
    await expect(store.setInstructions(id, 'abcdefgh')).rejects.toMatchObject({
      code: 'workspace-memory/capacity-exceeded',
    })
    await expect(store.setMemory(id, 'z')).rejects.toMatchObject({
      code: 'workspace-memory/capacity-exceeded',
    })
    await fiber.dispose()
  })

  it('adds and removes text and file context items', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    const afterText = await store.addContextItem(id, { kind: 'text', label: 'note', text: 'hello' })
    expect(afterText.contextItems).toHaveLength(1)
    expect(afterText.contextItems[0]).toMatchObject({ kind: 'text', label: 'note', text: 'hello' })
    const afterFile = await store.addContextItem(id, { kind: 'file', label: 'doc', path: '/w/doc.md', sizeBytes: 9 })
    expect(afterFile.contextItems).toHaveLength(2)
    expect(afterFile.contextItems[1]).toMatchObject({ kind: 'file', path: '/w/doc.md', sizeBytes: 9 })
    expect(store.usage(id).usedBytes).toBe(
      Buffer.byteLength('hello', 'utf8') + 9,
    )
    const itemId = afterFile.contextItems[0]?.id as string
    const afterRemove = await store.removeContextItem(id, itemId)
    expect(afterRemove.contextItems).toHaveLength(1)
    expect(afterRemove.contextItems[0]?.kind).toBe('file')
    await fiber.dispose()
  })

  it('context item caps reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024 })
    const id = WorkspaceId('ws-1')
    await expect(
      store.addContextItem(id, { kind: 'text', label: 'big', text: 'x'.repeat(300000) }),
    ).rejects.toMatchObject({ code: 'workspace-memory/too-large' })
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('item count caps reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024, maxContextItems: 1 })
    const id = WorkspaceId('ws-1')
    await store.addContextItem(id, { kind: 'text', label: 'a', text: 'a' })
    const before = store.read(id)
    await expect(store.addContextItem(id, { kind: 'text', label: 'b', text: 'b' })).rejects.toMatchObject({
      code: 'workspace-memory/capacity-exceeded',
    })
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('recordOutputs seeds absent records and ignores empty batches', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    await store.recordOutputs(id, [])
    expect(store.read(id)).toBeUndefined()
    await store.recordOutputs(id, [
      { path: '/w/b.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' },
      { path: '/w/b.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' },
      { path: '/w/b.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' },
      { path: '/w/a.ts', tool: 'edit', sessionId: 's1', at: '2026-01-01T12:00:00.000Z' },
    ])
    expect(store.read(id)?.outputs.map(entry => entry.path)).toEqual(['/w/b.ts', '/w/a.ts'])
    await fiber.dispose()
  })

  it('recordOutputs merges new paths and ignores older repeats', async () => {
    const { fiber, store } = await harness()
    const id = WorkspaceId('ws-1')
    await store.setInstructions(id, 'i')
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' }])
    await store.recordOutputs(id, [
      { path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' },
      { path: '/w/b.ts', tool: 'edit', sessionId: 's1', at: '2026-01-03T00:00:00.000Z' },
    ])
    expect(store.read(id)?.outputs.map(entry => entry.path)).toEqual(['/w/b.ts', '/w/a.ts'])
    await fiber.dispose()
  })

  it('recordOutputs truncates to maxOutputs', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024, maxOutputs: 2 })
    const id = WorkspaceId('ws-1')
    await store.recordOutputs(id, [
      { path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' },
      { path: '/w/b.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' },
      { path: '/w/c.ts', tool: 'write', sessionId: 's1', at: '2026-01-03T00:00:00.000Z' },
    ])
    expect(store.read(id)?.outputs.map(entry => entry.path)).toEqual(['/w/c.ts', '/w/b.ts'])
    await fiber.dispose()
  })

  it('reads fail before the store starts', async () => {
    const ctx = new Context()
    const store = new WorkspaceMemoryStore(ctx, { capacityBytes: 1024 })
    expect(() => store.read(WorkspaceId('ws-1'))).toThrow('not started yet')
    expect(() => store.usage(WorkspaceId('ws-1'))).toThrow('not started yet')
    expect(() => store.digest(WorkspaceId('ws-1'))).toThrow('not started yet')
  })
})
