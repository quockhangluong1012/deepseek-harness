import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMemoryStore, {
  EvolutionScopeId,
  resolveConfig,
  scopeIdFromStorageKey,
  storageKey,
  type LessonArtifactInput,
} from '../src/index.ts'
import type { EvolutionScopeId as ScopeId } from '../src/types.ts'
import { evolutionMemoryDomainSpec, evolutionMemoryRecord } from '../src/spec.ts'
import { digestOf, truncateUtf8 } from '../src/digest.ts'

async function harness(
  config: {
    capacityBytes: number
    maxAgentBytes?: number
    maxContextItems?: number
    maxOutputs?: number
    maxResolutions?: number
  } = { capacityBytes: 1024 },
) {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionMemoryStore, config)
  return { ctx, fiber, store: ctx.evolutionMemory }
}

function scope(name = 'ws-1'): ScopeId {
  return EvolutionScopeId('test', name)
}

/** One caller-supplied artifact candidate, with the fields a test varies pinned. */
function candidate(statement: string, overrides: Partial<LessonArtifactInput> = {}): LessonArtifactInput {
  return {
    statement,
    source: 's1',
    conditions: '',
    evidence: 'fact',
    confidence: 0.9,
    scope: 'project',
    ...overrides,
  }
}

describe('evolution-memory scope ids', () => {
  it('builds workspace and global keys', () => {
    expect(EvolutionScopeId('web', 'abc')).toBe('web:abc')
    expect(EvolutionScopeId('web')).toBe('web:global')
  })

  it('rejects malformed identities loudly', () => {
    expect(() => EvolutionScopeId('')).toThrow('profile must be non-empty')
    expect(() => EvolutionScopeId('a:b')).toThrow("must not contain ':'")
    expect(() => EvolutionScopeId('web', '')).toThrow('workspace scope must be non-empty')
    expect(() => EvolutionScopeId('web', 'a:b')).toThrow("must not contain ':'")
  })

  it('encodes opaque ids as path-safe storage keys', () => {
    expect(storageKey(EvolutionScopeId('web', 'abc'))).toBe('web--abc')
    expect(storageKey(EvolutionScopeId('web'))).toBe('web--global')
    expect(scopeIdFromStorageKey('web--abc')).toBe('web:abc')
    expect(scopeIdFromStorageKey('web--global')).toBe('web:global')
    expect(scopeIdFromStorageKey(storageKey(EvolutionScopeId('a--b', 'ws')))).toBe('a--b:ws')
  })

  it('rejects storage keys that stay path-unsafe', () => {
    expect(() => storageKey(EvolutionScopeId('a/b', 'ws'))).toThrow('not path-safe')
    expect(() => storageKey('nocolon' as ScopeId)).toThrow("missing ':'")
    expect(() => scopeIdFromStorageKey('nodoublehyphen')).toThrow("missing '--'")
  })

  it('resolves default caps', () => {
    expect(resolveConfig({ capacityBytes: 8 })).toEqual({
      capacityBytes: 8,
      maxAgentBytes: 65536,
      maxUserBytes: 32768,
      maxContextItemBytes: 262144,
      maxContextItems: 50,
      maxOutputs: 200,
      maxResolutions: 200,
      mergeSimilarityFloor: 0.87,
      maintenanceIntervalHours: 24,
      refutationFloor: 3,
      defaultTtlDays: 30,
    })
  })
})

describe('evolution-memory truncation', () => {
  it('clips at a UTF-8 boundary', () => {
    expect(truncateUtf8('hello', 10)).toBe('hello')
    expect(truncateUtf8('hello', 5)).toBe('hello')
    // 'a😀b': a takes 1 byte, the emoji takes 4. A budget of 4 keeps 'a';
    // a budget of 5 keeps the emoji whole.
    expect(truncateUtf8('a😀b', 4)).toBe('a')
    expect(truncateUtf8('a😀b', 5)).toBe('a😀')
    expect(truncateUtf8('a😀b', 0)).toBe('')
    expect(truncateUtf8('', 0)).toBe('')
  })
})

describe('evolution-memory store', () => {
  it('absent record reads empty', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    expect(store.read(id)).toBeUndefined()
    expect(store.usage(id)).toEqual({ usedBytes: 0, capacityBytes: 1024 })
    expect(store.digest(id)).toBe('empty')
    expect(digestOf(undefined)).toBe('empty')
    await fiber.dispose()
  })

  it('first write seeds the record and stamps updatedAt', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const record = await store.setInstructions(id, 'follow the repo guide')
    expect(record.instructions).toBe('follow the repo guide')
    expect(record.agentLessons).toEqual([])
    expect(record.userProfile).toBe('')
    expect(record.memoryUpdatedAt).toBeNull()
    expect(record.staged).toEqual([])
    expect(typeof record.updatedAt).toBe('string')
    expect(store.read(id)?.instructions).toBe('follow the repo guide')
    await fiber.dispose()
  })

  it('persists under the path-safe storage key', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'encoded')
    const table = (store as unknown as { table: { entries(): Iterable<[string, unknown]> } }).table
    const keys = [...table.entries()].map(([key]) => key)
    expect(keys).toEqual([storageKey(id)])
    expect(keys[0]).not.toContain(':')
    await fiber.dispose()
  })

  it('setInstructions accounts for retained artifacts, profile, and items', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024 })
    const id = scope()
    await store.addArtifact(id, candidate('abcde'))
    await store.setUserProfile(id, 'fgh')
    await store.addContextItem(id, { kind: 'text', label: 'n', text: 'hi' })
    const withoutInstructions = store.usage(id).usedBytes
    await store.setInstructions(id, 'jk')
    expect(store.usage(id).usedBytes).toBe(withoutInstructions + 2)
    await expect(store.setInstructions(id, 'x'.repeat(1024))).rejects.toMatchObject({
      code: 'evolution/capacity-exceeded',
    })
    expect(store.read(id)?.instructions).toBe('jk')
    await fiber.dispose()
  })

  it('setInstructions capacity rejects on an absent record', async () => {
    const { fiber, store } = await harness({ capacityBytes: 10 })
    const id = scope()
    await expect(store.setInstructions(id, '0123456789x')).rejects.toMatchObject({
      code: 'evolution/capacity-exceeded',
    })
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('addArtifact assigns identity, counters, and instants', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const record = await store.addArtifact(id, candidate('  Use PostgreSQL 15  '))
    expect(record.agentLessons).toHaveLength(1)
    expect(record.agentLessons[0]).toMatchObject({
      id: 'use postgresql 15',
      statement: '  Use PostgreSQL 15  ',
      source: 's1',
      conditions: '',
      evidence: 'fact',
      confidence: 0.9,
      validationCount: 0,
      refutationCount: 0,
      scope: 'project',
    })
    expect(record.agentLessons[0]?.createdAt).toBe(record.agentLessons[0]?.updatedAt)
    expect(typeof record.lessonsUpdatedAt).toBe('string')
    expect(record.memoryUpdatedAt).toBe(record.lessonsUpdatedAt)
    await fiber.dispose()
  })

  it('charges capacity for the artifact array, not for a stringified form', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, {
      statement: 'x'.repeat(64), source: 's1', conditions: '', evidence: 'fact', confidence: 0.9, scope: 'project',
    })
    expect(store.usage(id).usedBytes).toBeGreaterThanOrEqual(64)
    await fiber.dispose()
  })

  it('addArtifact stores nothing when keep_both meets an existing identity', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('use postgres'))
    const before = store.read(id)
    const after = await store.addArtifact(id, candidate('Use Postgres'))
    expect(after.agentLessons).toHaveLength(1)
    expect(after.agentLessons[0]?.statement).toBe('use postgres')
    // A no-op reaches no write at all, so not even `updatedAt` moves.
    expect(after).toEqual(before)
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('addArtifact overwrites an exact-identity collision when asked', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const first = await store.addArtifact(id, candidate('use postgres', { conditions: 'database work', confidence: 0.6 }))
    const createdAt = first.agentLessons[0]?.createdAt as string
    await store.addArtifact(id, candidate('keep me'))
    const record = await store.addArtifact(
      id,
      candidate('use postgres', { conditions: 'database work only', confidence: 0.95, source: 's2' }),
      'overwrite',
    )
    expect(record.agentLessons).toHaveLength(2)
    expect(record.agentLessons[0]).toMatchObject({
      id: 'use postgres',
      conditions: 'database work only',
      confidence: 0.95,
      source: 's2',
      validationCount: 0,
      refutationCount: 0,
      createdAt,
    })
    // The overwrite replaces exactly the addressed artifact.
    expect(record.agentLessons[1]?.statement).toBe('keep me')
    await fiber.dispose()
  })

  it('addArtifact rejects a candidate outside the artifact vocabulary', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await expect(store.addArtifact(id, candidate('unbounded confidence', { confidence: 2 }))).rejects.toThrow()
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('addArtifact caps reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 400 })
    const id = scope()
    await store.addArtifact(id, candidate('ok'))
    const before = store.read(id)
    await expect(store.addArtifact(id, candidate('x'.repeat(400)))).rejects.toMatchObject({
      code: 'evolution/capacity-exceeded',
    })
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('refuses a statement with no identity, on a present and an absent record', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('use postgres'))
    const before = store.read(id)
    await expect(store.addArtifact(id, candidate('   \n\t '))).rejects.toThrow('is blank once normalized')
    expect(store.read(id)).toEqual(before)
    // The guard fires before the record is seeded, so nothing is written at all.
    const blank = scope('blank')
    await expect(store.addArtifact(blank, candidate('   '))).rejects.toThrow('is blank once normalized')
    expect(store.read(blank)).toBeUndefined()
    await fiber.dispose()
  })

  it('refuses a blank statement at a staged add and keeps the entry', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'rules')
    const before = store.read(id)
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', originSessionId: 's1', gist: 'g',
      payload: { candidate: candidate('  ') },
    })
    await expect(store.approveStaged(staged.id)).rejects.toThrow('is blank once normalized')
    const after = store.read(id)
    expect(after?.agentLessons).toEqual([])
    expect(after?.instructionsUpdatedAt).toBe(before?.instructionsUpdatedAt)
    expect(after?.staged).toHaveLength(1)
    await fiber.dispose()
  })

  it('enforces maxAgentBytes against the serialized artifact array', async () => {
    const { fiber, store } = await harness({ capacityBytes: 4096, maxAgentBytes: 400 })
    const id = scope()
    const before = store.read(id)
    await expect(store.addArtifact(id, candidate('x'.repeat(400)))).rejects.toMatchObject({
      code: 'evolution/too-large',
    })
    expect(store.read(id)).toEqual(before)
    const added = await store.addArtifact(id, candidate('short'))
    const artifactId = added.agentLessons[0]?.id as string
    const withOne = store.read(id)
    await expect(store.updateArtifact(id, artifactId, { conditions: 'x'.repeat(400) })).rejects.toMatchObject({
      code: 'evolution/too-large',
    })
    expect(store.read(id)).toEqual(withOne)
    await fiber.dispose()
  })

  it('updateArtifact patches fields and keeps identity, counters, and creation instant', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const added = await store.addArtifact(id, candidate('use postgres', { conditions: 'database work' }))
    const artifactId = added.agentLessons[0]?.id as string
    const createdAt = added.agentLessons[0]?.createdAt as string
    await store.addArtifact(id, candidate('keep me'))
    const record = await store.updateArtifact(id, artifactId, { conditions: 'database work only', confidence: 0.95 })
    expect(record.agentLessons).toHaveLength(2)
    expect(record.agentLessons[0]).toMatchObject({
      id: artifactId,
      statement: 'use postgres',
      conditions: 'database work only',
      confidence: 0.95,
      createdAt,
      validationCount: 0,
      refutationCount: 0,
    })
    expect(record.agentLessons[1]?.statement).toBe('keep me')
    await expect(store.updateArtifact(id, artifactId, { confidence: 2 })).rejects.toThrow()
    expect(store.read(id)?.agentLessons[0]?.confidence).toBe(0.95)
    await fiber.dispose()
  })

  it('a patch cannot rewrite the statement an artifact is keyed by', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const added = await store.addArtifact(id, candidate('use postgres'))
    const artifactId = added.agentLessons[0]?.id as string
    // `statement` is absent from `LessonArtifactPatch`, so the durable payload
    // is the route that can carry one; it must not land.
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'updateArtifact', originSessionId: 's1', gist: 'g',
      payload: { id: artifactId, patch: { statement: 'use mysql', confidence: 0.5 } },
    })
    await store.approveStaged(staged.id)
    const after = store.read(id)?.agentLessons[0]
    expect(after?.statement).toBe('use postgres')
    expect(after?.id).toBe(artifactId)
    expect(after?.confidence).toBe(0.5)
    await fiber.dispose()
  })

  it('artifact ops reject an unknown artifact id', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('use postgres'))
    await expect(store.updateArtifact(id, 'absent', { confidence: 0.5 })).rejects.toMatchObject({
      code: 'evolution/item-not-found',
    })
    await expect(store.removeArtifact(id, 'absent')).rejects.toMatchObject({ code: 'evolution/item-not-found' })
    expect(store.read(id)?.agentLessons).toHaveLength(1)
    const absent = scope('absent')
    await expect(store.removeArtifact(absent, 'absent')).rejects.toMatchObject({ code: 'evolution/item-not-found' })
    expect(store.read(absent)).toBeUndefined()
    await fiber.dispose()
  })

  it('removeArtifact drops the addressed artifact', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('first'))
    const two = await store.addArtifact(id, candidate('second'))
    const firstId = two.agentLessons[0]?.id as string
    const record = await store.removeArtifact(id, firstId)
    expect(record.agentLessons.map(artifact => artifact.statement)).toEqual(['second'])
    expect(record.memoryUpdatedAt).toBe(record.lessonsUpdatedAt)
    await fiber.dispose()
  })

  it('an update past the capacity cap rejects without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 600 })
    const id = scope()
    const added = await store.addArtifact(id, candidate('use postgres'))
    const artifactId = added.agentLessons[0]?.id as string
    const before = store.read(id)
    await expect(store.updateArtifact(id, artifactId, { conditions: 'x'.repeat(600) })).rejects.toMatchObject({
      code: 'evolution/capacity-exceeded',
    })
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('a staged update past the capacity cap keeps the entry and the artifacts', async () => {
    const { fiber, store } = await harness({ capacityBytes: 600 })
    const id = scope()
    const added = await store.addArtifact(id, candidate('use postgres'))
    const artifactId = added.agentLessons[0]?.id as string
    const before = store.read(id)
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'updateArtifact', originSessionId: 's1', gist: 'g',
      payload: { id: artifactId, patch: { conditions: 'x'.repeat(600) } },
    })
    await expect(store.approveStaged(staged.id)).rejects.toMatchObject({ code: 'evolution/capacity-exceeded' })
    const after = store.read(id)
    expect(after?.agentLessons).toEqual(before?.agentLessons)
    expect(after?.lessonsUpdatedAt).toBe(before?.lessonsUpdatedAt)
    expect(after?.staged).toHaveLength(1)
    await fiber.dispose()
  })

  it('replaceArtifacts rewrites the whole array, clearing it for an empty list', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('old one'))
    await store.addArtifact(id, candidate('old two'))
    const replaced = await store.replaceArtifacts(id, [candidate('new one'), candidate('new two')])
    expect(replaced.agentLessons.map(artifact => artifact.statement)).toEqual(['new one', 'new two'])
    expect(replaced.agentLessons.map(artifact => artifact.id)).toEqual(['new one', 'new two'])
    expect(replaced.agentLessons[0]?.createdAt).toBe(replaced.agentLessons[1]?.createdAt)
    expect(replaced.memoryUpdatedAt).toBe(replaced.lessonsUpdatedAt)
    const cleared = await store.replaceArtifacts(id, [])
    expect(cleared.agentLessons).toEqual([])
    await fiber.dispose()
  })

  it('replaceArtifacts refuses a repeated identity or a blank statement without mutating', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('kept'))
    const before = store.read(id)
    await expect(store.replaceArtifacts(id, [candidate('same'), candidate('Same')]))
      .rejects.toThrow("repeats identity 'same'")
    await expect(store.replaceArtifacts(id, [candidate('fine'), candidate(' \n ')]))
      .rejects.toThrow('is blank once normalized')
    await expect(store.replaceArtifacts(id, [candidate('fine'), candidate('off vocabulary', { confidence: 2 })]))
      .rejects.toThrow()
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('replaceArtifacts refuses a list past the lessons cap without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 4096, maxAgentBytes: 400 })
    const id = scope()
    await store.addArtifact(id, candidate('kept'))
    const before = store.read(id)
    await expect(store.replaceArtifacts(id, [candidate('x'.repeat(400))])).rejects.toMatchObject({
      code: 'evolution/too-large',
    })
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('setUserProfile replaces the document with provenance', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const plain = await store.setUserProfile(id, 'likes terse answers')
    expect(plain.userProfile).toBe('likes terse answers')
    expect(typeof plain.memoryUpdatedAt).toBe('string')
    expect(plain.lastExtraction).toBeNull()
    const proven = await store.setUserProfile(id, 'likes examples', {
      at: '2026-01-01T00:00:00.000Z',
      sessionId: 's1',
      provider: 'p',
      model: 'm',
      origin: 'user-edit',
      inputBytes: 4,
      truncated: true,
    })
    expect(proven.lastExtraction).toMatchObject({ origin: 'user-edit', truncated: true })
    await fiber.dispose()
  })

  it('setUserProfile caps reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 64 })
    const id = scope()
    await store.setUserProfile(id, 'ok')
    const before = store.read(id)
    await expect(store.setUserProfile(id, 'x'.repeat(40000))).rejects.toMatchObject({ code: 'evolution/too-large' })
    await expect(store.setUserProfile(id, 'y'.repeat(100))).rejects.toMatchObject({
      code: 'evolution/capacity-exceeded',
    })
    expect(store.read(id)).toEqual(before)
    await fiber.dispose()
  })

  it('adds and removes text and file context items', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const afterText = await store.addContextItem(id, { kind: 'text', label: 'note', text: 'hello' })
    expect(afterText.contextItems).toHaveLength(1)
    expect(afterText.contextItems[0]).toMatchObject({ kind: 'text', label: 'note', text: 'hello' })
    const afterFile = await store.addContextItem(id, { kind: 'file', label: 'doc', path: '/w/doc.md', sizeBytes: 9 })
    expect(afterFile.contextItems).toHaveLength(2)
    expect(afterFile.contextItems[1]).toMatchObject({ kind: 'file', path: '/w/doc.md', sizeBytes: 9 })
    expect(store.usage(id).usedBytes).toBe(Buffer.byteLength('hello', 'utf8') + 9)
    const itemId = afterFile.contextItems[0]?.id as string
    const afterRemove = await store.removeContextItem(id, itemId)
    expect(afterRemove.contextItems).toHaveLength(1)
    expect(afterRemove.contextItems[0]?.kind).toBe('file')
    await fiber.dispose()
  })

  it('context item caps reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024 })
    const id = scope()
    await expect(
      store.addContextItem(id, { kind: 'text', label: 'big', text: 'x'.repeat(300000) }),
    ).rejects.toMatchObject({ code: 'evolution/too-large' })
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('item count and capacity caps reject without mutating', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024, maxContextItems: 1 })
    const id = scope()
    await store.addContextItem(id, { kind: 'text', label: 'a', text: 'a' })
    const before = store.read(id)
    await expect(store.addContextItem(id, { kind: 'text', label: 'b', text: 'b' })).rejects.toMatchObject({
      code: 'evolution/capacity-exceeded',
    })
    expect(store.read(id)).toEqual(before)
    const tight = await harness({ capacityBytes: 10 })
    await expect(
      tight.store.addContextItem(scope('tight'), { kind: 'text', label: 'a', text: '0123456789x' }),
    ).rejects.toMatchObject({ code: 'evolution/capacity-exceeded' })
    await tight.fiber.dispose()
    await fiber.dispose()
  })

  it('remove of unknown item rejects', async () => {
    const { fiber, store } = await harness()
    await expect(store.removeContextItem(scope('absent'), 'missing')).rejects.toMatchObject({
      code: 'evolution/item-not-found',
    })
    const id = scope('present')
    await store.setInstructions(id, 'i')
    await expect(store.removeContextItem(id, 'missing')).rejects.toMatchObject({
      code: 'evolution/item-not-found',
    })
    await fiber.dispose()
  })

  it('recordOutputs prepends newest-first and leaves the digest alone', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'i')
    const withContent = store.digest(id)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }])
    expect(store.digest(id)).toBe(withContent)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }])
    expect(store.read(id)?.outputs).toHaveLength(1)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' }])
    expect(store.read(id)?.outputs[0]?.at).toBe('2026-01-02T00:00:00.000Z')
    expect(store.digest(id)).toBe(withContent)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'edit', sessionId: 's2', at: '2026-01-02T00:00:00.000Z' }])
    expect(store.read(id)?.outputs).toHaveLength(1)
    expect(store.read(id)?.outputs[0]).toMatchObject({ tool: 'edit', sessionId: 's2' })
    expect(store.digest(id)).toBe(withContent)
    await fiber.dispose()
  })

  it('recordOutputs seeds absent records and ignores empty batches', async () => {
    const { fiber, store } = await harness()
    const id = scope()
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
    const id = scope()
    await store.setInstructions(id, 'i')
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' }])
    await store.recordOutputs(id, [
      { path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' },
      { path: '/w/b.ts', tool: 'edit', sessionId: 's1', at: '2026-01-03T00:00:00.000Z' },
    ])
    expect(store.read(id)?.outputs.map(entry => entry.path)).toEqual(['/w/b.ts', '/w/a.ts'])
    await fiber.dispose()
  })

  it('recordOutputs grows the index when merged paths differ in length', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }])
    await store.recordOutputs(id, [
      { path: '/w/b.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' },
      { path: '/w/c.ts', tool: 'write', sessionId: 's1', at: '2026-01-03T00:00:00.000Z' },
    ])
    expect(store.read(id)?.outputs.map(entry => entry.path)).toEqual(['/w/c.ts', '/w/b.ts', '/w/a.ts'])
    await fiber.dispose()
  })

  it('recordOutputs truncates to maxOutputs', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024, maxOutputs: 2 })
    const id = scope()
    await store.recordOutputs(id, [
      { path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' },
      { path: '/w/b.ts', tool: 'write', sessionId: 's1', at: '2026-01-02T00:00:00.000Z' },
      { path: '/w/c.ts', tool: 'write', sessionId: 's1', at: '2026-01-03T00:00:00.000Z' },
    ])
    expect(store.read(id)?.outputs.map(entry => entry.path)).toEqual(['/w/c.ts', '/w/b.ts'])
    await fiber.dispose()
  })

  it('digest covers instructions, artifacts, profile, and context only', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'i')
    await store.addArtifact(id, candidate('l'))
    await store.setUserProfile(id, 'p')
    const covered = store.digest(id)
    await store.addContextItem(id, { kind: 'text', label: 'c', text: 't' })
    expect(store.digest(id)).not.toBe(covered)
    const withContext = store.digest(id)
    await store.recordOutputs(id, [{ path: '/w/a.ts', tool: 'write', sessionId: 's1', at: '2026-01-01T00:00:00.000Z' }])
    expect(store.digest(id)).toBe(withContext)
    await store.stageWrite({ scopeId: id, kind: 'skill', op: 'create', payload: {}, originSessionId: 's1', gist: 'g' })
    expect(store.digest(id)).toBe(withContext)
    await fiber.dispose()
  })

  it('stageWrite seeds an absent record without charging capacity', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const staged = await store.stageWrite({
      scopeId: id,
      kind: 'memory',
      op: 'setInstructions',
      payload: { text: 'staged rules' },
      originSessionId: 's1',
      gist: 'proposal from review',
    })
    expect(staged.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(typeof staged.createdAt).toBe('string')
    expect(store.read(id)?.staged).toHaveLength(1)
    expect(store.usage(id).usedBytes).toBe(0)
    await fiber.dispose()
  })

  it('stageWrite rejects malformed inputs', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await expect(store.stageWrite({
      scopeId: id,
      kind: 'unknown' as unknown as 'memory',
      op: 'setInstructions',
      payload: {},
      originSessionId: 's1',
      gist: 'g',
    })).rejects.toThrow("must be 'memory' or 'skill'")
    await expect(store.stageWrite({
      scopeId: id, kind: 'memory', op: '', payload: {}, originSessionId: 's1', gist: 'g',
    })).rejects.toThrow('staged op must be non-empty')
    await expect(store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: {}, originSessionId: 's1', gist: '',
    })).rejects.toThrow('staged gist must be non-empty')
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('refuses a staged payload that is not a JSON value', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const invalid = [
      { text: undefined },
      { text: Number.NaN },
      { text: () => 'nope' },
      { at: new Date('2026-01-01T00:00:00.000Z') },
    ]
    for (const payload of invalid) {
      await expect(store.stageWrite({
        scopeId: id,
        kind: 'memory',
        op: 'setInstructions',
        payload: payload as never,
        originSessionId: 's1',
        gist: 'g',
      })).rejects.toThrow('staged payload must be a JSON value')
    }
    // Nothing was stored: the record does not exist and no entry is pending.
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('approveStaged applies a staged setInstructions', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'before')
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: { text: 'after' }, originSessionId: 's1', gist: 'g',
    })
    await store.approveStaged(staged.id)
    const record = store.read(id)
    expect(record?.instructions).toBe('after')
    expect(record?.staged).toEqual([])
    expect(record?.memoryUpdatedAt).toBeNull()
    await fiber.dispose()
  })

  it('approveStaged applies a staged artifact add with extraction', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const staged = await store.stageWrite({
      scopeId: id,
      kind: 'memory',
      op: 'addArtifact',
      payload: {
        candidate: candidate('reviewed fact'),
        extraction: {
          at: '2026-01-01T00:00:00.000Z',
          sessionId: 's9',
          provider: 'p',
          model: 'm',
          origin: 'background_review',
          inputBytes: 7,
          truncated: false,
        },
      },
      originSessionId: 's9',
      gist: 'g',
    })
    await store.approveStaged(staged.id)
    const record = store.read(id)
    expect(record?.agentLessons.map(artifact => artifact.statement)).toEqual(['reviewed fact'])
    expect(typeof record?.memoryUpdatedAt).toBe('string')
    expect(record?.lastExtraction).toMatchObject({ sessionId: 's9', origin: 'background_review' })
    expect(record?.staged).toEqual([])
    await fiber.dispose()
  })

  it('approveStaged applies artifact add, update, and remove ops', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const add = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', originSessionId: 's1', gist: 'g',
      payload: {
        candidate: { statement: 'Use PostgreSQL 15', source: 's1', conditions: 'database work', evidence: 'fact', confidence: 0.9, scope: 'project' },
      },
    })
    await store.approveStaged(add.id)
    let record = store.read(id)
    expect(record?.agentLessons).toHaveLength(1)
    const artifactId = record?.agentLessons[0]?.id as string
    expect(record?.agentLessons[0]?.statement).toBe('Use PostgreSQL 15')

    const patch = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'updateArtifact', originSessionId: 's1', gist: 'g',
      payload: { id: artifactId, patch: { confidence: 0.95, conditions: 'database work only' } },
    })
    await store.approveStaged(patch.id)
    record = store.read(id)
    expect(record?.agentLessons[0]?.confidence).toBe(0.95)
    expect(record?.agentLessons[0]?.id).toBe(artifactId)

    const remove = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'removeArtifact', originSessionId: 's1', gist: 'g',
      payload: { id: artifactId },
    })
    await store.approveStaged(remove.id)
    expect(store.read(id)?.agentLessons).toEqual([])
    await fiber.dispose()
  })

  it('keeps a staged artifact op whose payload names no existing artifact', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'removeArtifact', originSessionId: 's1', gist: 'g',
      payload: { id: 'absent' },
    })
    await expect(store.approveStaged(staged.id)).rejects.toMatchObject({ code: 'evolution/item-not-found' })
    expect(store.read(id)?.staged).toHaveLength(1)
    await fiber.dispose()
  })

  it('approveStaged replaces the whole array with extraction', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('dropped'))
    const staged = await store.stageWrite({
      scopeId: id,
      kind: 'memory',
      op: 'replaceArtifacts',
      payload: {
        candidates: [candidate('one'), candidate('two')],
        extraction: {
          at: '2026-01-01T00:00:00.000Z',
          sessionId: 's9',
          provider: 'p',
          model: 'm',
          origin: 'rebuild',
          inputBytes: 7,
          truncated: false,
        },
      },
      originSessionId: 's9',
      gist: 'g',
    })
    await store.approveStaged(staged.id)
    const record = store.read(id)
    expect(record?.agentLessons.map(artifact => artifact.statement)).toEqual(['one', 'two'])
    expect(record?.lastExtraction).toMatchObject({ sessionId: 's9', origin: 'rebuild' })
    expect(record?.staged).toEqual([])
    await fiber.dispose()
  })

  it('keeps a staged replaceArtifacts whose list repeats an identity', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('kept'))
    const before = store.read(id)
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'replaceArtifacts', originSessionId: 's1', gist: 'g',
      payload: { candidates: [candidate('same'), candidate('same')] },
    })
    await expect(store.approveStaged(staged.id)).rejects.toThrow("repeats identity 'same'")
    const after = store.read(id)
    expect(after?.agentLessons).toEqual(before?.agentLessons)
    expect(after?.staged).toHaveLength(1)
    await fiber.dispose()
  })

  it('approveStaged applies a staged artifact add to an empty record', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'rules')
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', payload: { candidate: candidate('first') }, originSessionId: 's1', gist: 'g',
    })
    await store.approveStaged(staged.id)
    expect(store.read(id)?.agentLessons.map(artifact => artifact.statement)).toEqual(['first'])
    await fiber.dispose()
  })

  it('approveStaged scans past scopes without the entry', async () => {
    const { fiber, store } = await harness()
    await store.setInstructions(scope('other'), 'unrelated')
    const id = scope('target')
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: { text: 'found' }, originSessionId: 's1', gist: 'g',
    })
    await store.approveStaged(staged.id)
    expect(store.read(id)?.instructions).toBe('found')
    expect(store.read(scope('other'))?.instructions).toBe('unrelated')
    await fiber.dispose()
  })

  it('approveStaged drops a repeated artifact add without touching content', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('alpha'))
    const before = store.read(id)
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', originSessionId: 's1', gist: 'g',
      payload: { candidate: candidate('alpha'), strategy: 'keep_both' },
    })
    await store.approveStaged(staged.id)
    const after = store.read(id)
    expect(after?.agentLessons.map(artifact => artifact.statement)).toEqual(['alpha'])
    expect(after?.staged).toEqual([])
    // The op changed no content, so it stamped no family.
    expect(after?.lessonsUpdatedAt).toBe(before?.lessonsUpdatedAt)
    expect(after?.memoryUpdatedAt).toBe(before?.memoryUpdatedAt)
    expect(after?.resolutions?.[0]?.decision).toBe('approved')
    await fiber.dispose()
  })

  it('approveStaged drops skill entries without applying them', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'rules')
    const before = store.read(id)
    const staged = await store.stageWrite({
      scopeId: id, kind: 'skill', op: 'create', payload: { name: 'new-skill' }, originSessionId: 's1', gist: 'g',
    })
    await store.approveStaged(staged.id)
    const after = store.read(id)
    expect(after?.staged).toEqual([])
    expect(after?.instructions).toBe(before?.instructions)
    expect(after?.agentLessons).toEqual(before?.agentLessons)
    await fiber.dispose()
  })

  it('approveStaged of an unknown id rejects', async () => {
    const { fiber, store } = await harness()
    await expect(store.approveStaged('missing')).rejects.toMatchObject({ code: 'evolution/staged-not-found' })
    await expect(store.rejectStaged('missing')).rejects.toMatchObject({ code: 'evolution/staged-not-found' })
    await fiber.dispose()
  })

  it('approveStaged rejects unknown ops and keeps the entry', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'explode', payload: {}, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(staged.id)).rejects.toThrow("unknown staged memory op 'explode'")
    expect(store.read(id)?.staged).toHaveLength(1)
    await fiber.dispose()
  })

  it('approveStaged keeps the entry when capacity rejects', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', originSessionId: 's1', gist: 'g',
      payload: { candidate: candidate('x'.repeat(1024)) },
    })
    await expect(store.approveStaged(staged.id)).rejects.toMatchObject({ code: 'evolution/capacity-exceeded' })
    expect(store.read(id)?.staged).toHaveLength(1)
    await fiber.dispose()
  })

  it('approveStaged rejects malformed payloads and keeps the entry', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const scalar = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: 'nope', originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(scalar.id)).rejects.toThrow('payload must be an object')
    const nil = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: null, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(nil.id)).rejects.toThrow('payload must be an object')
    const missingText = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: {}, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(missingText.id)).rejects.toThrow("must carry a string 'text'")
    const missingCandidate = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', payload: {}, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(missingCandidate.id)).rejects.toThrow()
    const badStrategy = await store.stageWrite({
      scopeId: id,
      kind: 'memory',
      op: 'addArtifact',
      payload: { candidate: candidate('fine'), strategy: 'absorb' },
      originSessionId: 's1',
      gist: 'g',
    })
    await expect(store.approveStaged(badStrategy.id)).rejects.toThrow('unknown merge strategy "absorb"')
    const badExtraction = await store.stageWrite({
      scopeId: id,
      kind: 'memory',
      op: 'setUserProfile',
      payload: { text: 'fine', extraction: { provider: 42 } },
      originSessionId: 's1',
      gist: 'g',
    })
    await expect(store.approveStaged(badExtraction.id)).rejects.toThrow('invalid extraction')
    expect(store.read(id)?.staged).toHaveLength(6)
    await fiber.dispose()
  })

  it('approveStaged rejects malformed artifact payloads and keeps the entry', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const missingId = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'updateArtifact', payload: {}, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(missingId.id)).rejects.toThrow("must carry a non-empty string 'id'")
    const emptyId = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'removeArtifact', payload: { id: '' }, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(emptyId.id)).rejects.toThrow("must carry a non-empty string 'id'")
    const scalarPatch = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'updateArtifact', payload: { id: 'x', patch: 'nope' }, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(scalarPatch.id)).rejects.toThrow("must carry an object 'patch'")
    const nilPatch = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'updateArtifact', payload: { id: 'x', patch: null }, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(nilPatch.id)).rejects.toThrow("must carry an object 'patch'")
    const listPatch = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'updateArtifact', payload: { id: 'x', patch: [] }, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(listPatch.id)).rejects.toThrow("must carry an object 'patch'")
    const missingCandidates = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'replaceArtifacts', payload: {}, originSessionId: 's1', gist: 'g',
    })
    await expect(store.approveStaged(missingCandidates.id)).rejects.toThrow("must carry an array 'candidates'")
    expect(store.read(id)?.staged).toHaveLength(6)
    await fiber.dispose()
  })

  it('concurrent approvals settle exactly once', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: { text: 'i' }, originSessionId: 's1', gist: 'g',
    })
    const outcomes = await Promise.allSettled([store.approveStaged(staged.id), store.approveStaged(staged.id)])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'evolution/staged-not-found' })
    await fiber.dispose()
  })

  it('rejectStaged drops the entry without applying it', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'rules')
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: { text: 'other' }, originSessionId: 's1', gist: 'g',
    })
    await store.rejectStaged(staged.id)
    const record = store.read(id)
    expect(record?.instructions).toBe('rules')
    expect(record?.staged).toEqual([])
    await fiber.dispose()
  })

  it('concurrent rejections settle exactly once', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const staged = await store.stageWrite({
      scopeId: id, kind: 'skill', op: 'create', payload: {}, originSessionId: 's1', gist: 'g',
    })
    const outcomes = await Promise.allSettled([store.rejectStaged(staged.id), store.rejectStaged(staged.id)])
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.filter(outcome => outcome.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'evolution/staged-not-found' })
    await fiber.dispose()
  })

  it('stored objects never leak by reference', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const payload = { candidate: candidate('original') }
    const record = await store.setInstructions(id, 'i')
    const mutable = record as unknown as { instructions: string; contextItems: unknown[] }
    mutable.instructions = 'mutated'
    mutable.contextItems.push({
      kind: 'text',
      id: 'x',
      label: 'x',
      text: 'x',
      sizeBytes: 1,
      addedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(store.read(id)?.instructions).toBe('i')
    expect(store.read(id)?.contextItems).toEqual([])
    const staged = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', payload, originSessionId: 's1', gist: 'g',
    })
    payload.candidate.statement = 'mutated'
    staged.gist = 'mutated'
    await store.approveStaged(staged.id)
    expect(store.read(id)?.agentLessons.map(artifact => artifact.statement)).toEqual(['original'])
    await fiber.dispose()
  })

  it('reads fail before the store starts', async () => {
    const ctx = new Context()
    const store = new EvolutionMemoryStore(ctx, { capacityBytes: 1024 })
    expect(() => store.read(EvolutionScopeId('test', 'ws-1'))).toThrow('not started yet')
    expect(() => store.usage(EvolutionScopeId('test', 'ws-1'))).toThrow('not started yet')
    expect(() => store.digest(EvolutionScopeId('test', 'ws-1'))).toThrow('not started yet')
  })
})

describe('evolution-memory decisions and family stamps', () => {
  it('records the decided entry on both decisions', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const approved = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: { text: 'rules' }, originSessionId: 's1', gist: 'rules gist',
    })
    await store.approveStaged(approved.id)
    const rejected = await store.stageWrite({
      scopeId: id, kind: 'skill', op: 'create', payload: {}, originSessionId: 's2', gist: 'skill gist',
    })
    await store.rejectStaged(rejected.id)
    const resolutions = store.read(id)?.resolutions ?? []
    expect(resolutions).toHaveLength(2)
    // Newest first: the rejection landed last.
    expect(resolutions[0]).toMatchObject({
      id: rejected.id,
      kind: 'skill',
      op: 'create',
      gist: 'skill gist',
      decision: 'rejected',
      originSessionId: 's2',
    })
    expect(resolutions[1]).toMatchObject({
      id: approved.id,
      kind: 'memory',
      op: 'setInstructions',
      gist: 'rules gist',
      decision: 'approved',
      originSessionId: 's1',
    })
    expect(typeof resolutions[0]?.at).toBe('string')
    await fiber.dispose()
  })

  it('caps the resolution log newest-first', async () => {
    const { fiber, store } = await harness({ capacityBytes: 1024, maxResolutions: 2 })
    const id = scope()
    const ids: string[] = []
    for (const text of ['one', 'two', 'three']) {
      const staged = await store.stageWrite({
        scopeId: id, kind: 'memory', op: 'setInstructions', payload: { text }, originSessionId: 's1', gist: text,
      })
      ids.push(staged.id)
      await store.approveStaged(staged.id)
    }
    const resolutions = store.read(id)?.resolutions ?? []
    expect(resolutions.map(resolution => resolution.id)).toEqual([ids[2], ids[1]])
    await fiber.dispose()
  })

  it('leaves capacity and digest to the memory content', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.setInstructions(id, 'rules')
    const before = { digest: store.digest(id), usage: store.usage(id) }
    const staged = await store.stageWrite({
      scopeId: id, kind: 'skill', op: 'create', payload: {}, originSessionId: 's1', gist: 'g',
    })
    await store.approveStaged(staged.id)
    expect(store.digest(id)).toBe(before.digest)
    expect(store.usage(id)).toEqual(before.usage)
    expect(store.read(id)?.resolutions).toHaveLength(1)
    await fiber.dispose()
  })

  it('stamps only the family a write changed', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    // Date-only fake timers keep the derived `memoryUpdatedAt` deterministic
    // without disturbing the storage backend's own scheduling.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
      const instructed = await store.setInstructions(id, 'rules')
      expect(instructed.instructionsUpdatedAt).toBe('2026-01-01T00:00:00.000Z')
      expect(instructed.lessonsUpdatedAt).toBeNull()
      expect(instructed.profileUpdatedAt).toBeNull()
      expect(instructed.memoryUpdatedAt).toBeNull()

      vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
      const lessoned = await store.addArtifact(id, candidate('one lesson'))
      expect(lessoned.instructionsUpdatedAt).toBe(instructed.instructionsUpdatedAt)
      expect(lessoned.lessonsUpdatedAt).toBe('2026-01-02T00:00:00.000Z')
      expect(lessoned.profileUpdatedAt).toBeNull()
      expect(lessoned.memoryUpdatedAt).toBe(lessoned.lessonsUpdatedAt)

      // Profile newer than lessons: the derived aggregate follows the profile.
      vi.setSystemTime(new Date('2026-01-03T00:00:00.000Z'))
      const profiled = await store.setUserProfile(id, 'prefers fast tests')
      expect(profiled.instructionsUpdatedAt).toBe(instructed.instructionsUpdatedAt)
      expect(profiled.lessonsUpdatedAt).toBe(lessoned.lessonsUpdatedAt)
      expect(profiled.profileUpdatedAt).toBe('2026-01-03T00:00:00.000Z')
      expect(profiled.memoryUpdatedAt).toBe(profiled.profileUpdatedAt)

      // Lessons newer than profile: the derived aggregate follows the lessons.
      vi.setSystemTime(new Date('2026-01-04T00:00:00.000Z'))
      const relearned = await store.addArtifact(id, candidate('another lesson'))
      expect(relearned.lessonsUpdatedAt).toBe('2026-01-04T00:00:00.000Z')
      expect(relearned.profileUpdatedAt).toBe(profiled.profileUpdatedAt)
      expect(relearned.memoryUpdatedAt).toBe(relearned.lessonsUpdatedAt)
    } finally {
      vi.useRealTimers()
    }
    await fiber.dispose()
  })

  it('stamps the family a staged approval changed', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const instructions = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setInstructions', payload: { text: 'rules' }, originSessionId: 's1', gist: 'g',
    })
    await store.approveStaged(instructions.id)
    const afterInstructions = store.read(id)
    expect(typeof afterInstructions?.instructionsUpdatedAt).toBe('string')
    expect(afterInstructions?.lessonsUpdatedAt).toBeNull()
    expect(afterInstructions?.profileUpdatedAt).toBeNull()
    expect(afterInstructions?.memoryUpdatedAt).toBeNull()

    const profile = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'setUserProfile', payload: { text: 'profile' }, originSessionId: 's1', gist: 'g',
    })
    await store.approveStaged(profile.id)
    const afterProfile = store.read(id)
    expect(afterProfile?.instructionsUpdatedAt).toBe(afterInstructions?.instructionsUpdatedAt)
    expect(afterProfile?.profileUpdatedAt).toBe(afterProfile?.memoryUpdatedAt)
    expect(afterProfile?.lessonsUpdatedAt).toBeNull()

    // An artifact write stamps the lessons family and the derived aggregate.
    const beforeArtifact = store.read(id)
    const artifact = await store.stageWrite({
      scopeId: id, kind: 'memory', op: 'addArtifact', originSessionId: 's1', gist: 'g',
      payload: { candidate: candidate('kept lesson') },
    })
    await store.approveStaged(artifact.id)
    const afterArtifact = store.read(id)
    expect(afterArtifact?.agentLessons.map(entry => entry.statement)).toEqual(['kept lesson'])
    expect(afterArtifact?.memoryUpdatedAt).toBe(afterArtifact?.lessonsUpdatedAt)
    expect(afterArtifact?.instructionsUpdatedAt).toBe(beforeArtifact?.instructionsUpdatedAt)
    expect(afterArtifact?.resolutions?.[0]?.decision).toBe('approved')
    await fiber.dispose()
  })

  it('admits a record stored as a legacy lessons string as one coarse artifact', () => {
    const legacy = {
      instructions: 'rules',
      agentLessons: '## Purpose\nOld work',
      userProfile: '',
      memoryUpdatedAt: '2026-01-01T00:00:00.000Z',
      contextItems: [],
      outputs: [],
      lastExtraction: null,
      staged: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const parsed = evolutionMemoryRecord.parse(legacy)
    expect(parsed.instructions).toBe('rules')
    expect(parsed.agentLessons).toHaveLength(1)
    expect(parsed.agentLessons[0]).toMatchObject({
      statement: '## Purpose\nOld work',
      source: 'migration-pending',
      confidence: 0.5,
    })
    expect(parsed.memoryUpdatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(parsed.instructionsUpdatedAt).toBeNull()
    expect(parsed.lessonsUpdatedAt).toBeNull()
    expect(parsed.profileUpdatedAt).toBeNull()
    expect(parsed.resolutions).toEqual([])
  })

  it('declares the artifact format as version 2 while still reading version 1', () => {
    expect(evolutionMemoryDomainSpec.version).toBe(2)
    expect(evolutionMemoryDomainSpec.compatibleVersions).toEqual([1])
  })
})
