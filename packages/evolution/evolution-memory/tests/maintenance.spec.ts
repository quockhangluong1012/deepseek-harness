import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMemoryStore, {
  EVOLUTION_MEMORY_MAINTENANCE_TASK,
  EvolutionScopeId,
  storageKey,
  type LessonArtifactInput,
} from '../src/index.ts'
import type { EvolutionScopeId as ScopeId } from '../src/types.ts'
import { artifactKey, type LessonArtifact } from '../src/lesson-artifact.ts'
import { prunable } from '../src/maintenance.ts'
import { evolutionMemoryDomainSpec, evolutionMemoryRecord } from '../src/spec.ts'

const NOW = Date.parse('2026-09-13T00:00:00.000Z')
const DAY = 86_400_000

function artifact(overrides: Partial<LessonArtifact> = {}): LessonArtifact {
  return {
    id: artifactKey('s'), statement: 's', source: 's1', conditions: '', evidence: 'fact', confidence: 0.9,
    validationCount: 0, refutationCount: 0, scope: 'project',
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', ...overrides,
  }
}

describe('artifact decay', () => {
  it('never prunes an artifact without a ttl', () => {
    expect(prunable(artifact({ updatedAt: '2020-01-01T00:00:00.000Z' }), NOW, 3)).toBe(false)
  })

  it('prunes past its ttl, and keeps it inside the ttl', () => {
    expect(prunable(artifact({ ttlDays: 5, updatedAt: new Date(NOW - 6 * DAY).toISOString() }), NOW, 3)).toBe(true)
    expect(prunable(artifact({ ttlDays: 5, updatedAt: new Date(NOW - 4 * DAY).toISOString() }), NOW, 3)).toBe(false)
  })

  it('keeps an artifact exactly at its ttl boundary', () => {
    expect(prunable(artifact({ ttlDays: 5, updatedAt: new Date(NOW - 5 * DAY).toISOString() }), NOW, 3)).toBe(false)
  })

  it('prunes at the refutation floor regardless of age', () => {
    expect(prunable(artifact({ refutationCount: 3, updatedAt: new Date(NOW).toISOString() }), NOW, 3)).toBe(true)
    expect(prunable(artifact({ refutationCount: 2, updatedAt: new Date(NOW).toISOString() }), NOW, 3)).toBe(false)
  })
})

/** One heartbeat registration, as the engine would receive it. */
interface RecordedTask {
  name: string
  intervalHours: number
  run: (signal: AbortSignal) => Promise<void> | void
}

async function harness(options: {
  config?: { capacityBytes: number; maintenanceIntervalHours?: number; defaultTtlDays?: number }
  heartbeat?: RecordedTask[]
} = {}) {
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  if (options.heartbeat !== undefined) {
    const recorded = options.heartbeat
    ctx.provide('evolutionHeartbeat', {
      register: (task: RecordedTask) => {
        recorded.push(task)
        return () => {}
      },
    })
  }
  const fiber = await ctx.plugin(EvolutionMemoryStore, options.config ?? { capacityBytes: 4096 })
  return { facility, fiber, store: ctx.evolutionMemory }
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

/**
 * The live `records` table of the evolution-memory domain: the durable state
 * the store reads and writes, reachable because the store assigns artifact
 * counters itself and no Phase-1 write path can raise one.
 */
function scopeTable(facility: DomainFacility) {
  const table = facility.get(evolutionMemoryDomainSpec.name)?.table('records')
  if (table === undefined) throw new Error('evolution-memory domain is not open')
  return table
}

/** Parse one scope's durable row exactly as the store reads it. */
function storedRow(facility: DomainFacility, id: ScopeId) {
  return evolutionMemoryRecord.parse(scopeTable(facility).get(storageKey(id)))
}

/** Raise one stored artifact's refutation count to the default floor. */
async function condemn(facility: DomainFacility, id: ScopeId, artifactId: string): Promise<void> {
  const stored = storedRow(facility, id)
  await scopeTable(facility).put(storageKey(id), {
    ...stored,
    agentLessons: stored.agentLessons.map(entry => entry.id === artifactId ? { ...entry, refutationCount: 3 } : entry),
  })
}

describe('evolution-memory sweep', () => {
  it('sweeps a scope that was never written to nothing', async () => {
    const { fiber, store } = await harness()
    const id = scope('absent')
    expect(await store.sweep(id)).toEqual({ pruned: 0, refined: 0 })
    expect(store.read(id)).toBeUndefined()
    await fiber.dispose()
  })

  it('reaches no write when every artifact is fresh', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('short-lived fact', { ttlDays: 5 }))
    await store.addArtifact(id, candidate('default-ttl fact'))
    const before = store.read(id)
    // A future instant makes the guard decisive: a write would stamp
    // `updatedAt` and the lessons family with `later`, so the stamps still
    // holding the earlier value is what proves no write happened, rather than
    // a write landing in the same millisecond as the record's read.
    const later = new Date(Date.now() + 2 * DAY).toISOString()
    expect(await store.sweep(id, later)).toEqual({ pruned: 0, refined: 0 })
    const after = store.read(id)
    expect(after).toEqual(before)
    expect(after?.updatedAt).not.toBe(later)
    expect(after?.lessonsUpdatedAt).not.toBe(later)
    expect(after?.memoryUpdatedAt).not.toBe(later)
    await fiber.dispose()
  })

  it('drops what the ttl condemned and keeps the fresh siblings', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('aged fact', { ttlDays: 5 }))
    await store.addArtifact(id, candidate('durable fact', { ttlDays: 60 }))
    await store.addArtifact(id, candidate('default-ttl fact'))
    const later = new Date(Date.now() + 6 * DAY).toISOString()
    expect(await store.sweep(id, later)).toEqual({ pruned: 1, refined: 0 })
    expect(store.read(id)?.agentLessons.map(entry => entry.statement)).toEqual(['durable fact', 'default-ttl fact'])
    await fiber.dispose()
  })

  it('reports what it removed from the record it wrote, not from its read', async () => {
    const { facility, fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('condemned fact'))
    await condemn(facility, id, artifactKey('condemned fact'))
    // The un-awaited put claims the write chain's next slot before the sweep
    // reads, so it lands after that read and before the sweep's queued update:
    // the sweep decides on `[condemned]` but writes from `[condemned, concurrent]`.
    const row = storedRow(facility, id)
    const concurrent = scopeTable(facility).put(storageKey(id), {
      ...row,
      agentLessons: [
        ...row.agentLessons,
        artifact({ id: artifactKey('concurrent fact'), statement: 'concurrent fact' }),
      ],
    })
    const report = await store.sweep(id, new Date(Date.now() + 90 * DAY).toISOString())
    await concurrent
    expect(report).toEqual({ pruned: 1, refined: 0 })
    expect(store.read(id)?.agentLessons.map(entry => entry.statement)).toEqual(['concurrent fact'])
    await fiber.dispose()
  })

  it('drops an artifact at the refutation floor and keeps its fresh sibling', async () => {
    const { facility, fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('condemned fact'))
    await store.addArtifact(id, candidate('fresh fact', { ttlDays: 5 }))
    await condemn(facility, id, artifactKey('condemned fact'))
    expect(await store.sweep(id)).toEqual({ pruned: 1, refined: 0 })
    expect(store.read(id)?.agentLessons.map(entry => entry.statement)).toEqual(['fresh fact'])
    expect(store.read(id)?.lessonsUpdatedAt).not.toBeNull()
    await fiber.dispose()
  })

  it('gives a new artifact the resolved ttl when the caller supplies none', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    const added = await store.addArtifact(id, candidate('defaulted fact'))
    expect(added.agentLessons[0]?.ttlDays).toBe(30)
    await fiber.dispose()
  })

  it('keeps a caller-supplied ttl over the configured default', async () => {
    const { fiber, store } = await harness({ config: { capacityBytes: 4096, defaultTtlDays: 7 } })
    const id = scope()
    const added = await store.addArtifact(id, candidate('explicit fact', { ttlDays: 5 }))
    expect(added.agentLessons[0]?.ttlDays).toBe(5)
    // `replaceArtifacts` builds its artifacts the same way.
    const replaced = await store.replaceArtifacts(id, [candidate('replaced fact')])
    expect(replaced.agentLessons[0]?.ttlDays).toBe(7)
    await fiber.dispose()
  })

  it('never age-prunes a coarse artifact migrated from a legacy lessons document', async () => {
    const { facility, fiber, store } = await harness()
    const id = scope('legacy')
    // A version-1 record: `agentLessons` as the markdown string the reader
    // admits as one coarse artifact.
    await scopeTable(facility).put(storageKey(id), evolutionMemoryRecord.parse({
      instructions: 'rules',
      agentLessons: '## Purpose\nOld work',
      userProfile: '',
      memoryUpdatedAt: '2026-01-01T00:00:00.000Z',
      contextItems: [],
      outputs: [],
      lastExtraction: null,
      staged: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }))
    expect(store.read(id)?.agentLessons[0]?.ttlDays).toBeUndefined()
    const farFuture = new Date(Date.now() + 3650 * DAY).toISOString()
    expect(await store.sweep(id, farFuture)).toEqual({ pruned: 0, refined: 0 })
    expect(store.read(id)?.agentLessons.map(entry => entry.statement)).toEqual(['## Purpose\nOld work'])
    await fiber.dispose()
  })
})

describe('evolution-memory maintenance task', () => {
  it('registers the sweep under the configured name and interval', async () => {
    const tasks: RecordedTask[] = []
    const { fiber } = await harness({ config: { capacityBytes: 4096, maintenanceIntervalHours: 6 }, heartbeat: tasks })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.name).toBe(EVOLUTION_MEMORY_MAINTENANCE_TASK)
    expect(tasks[0]?.name).toBe('evolution-memory-maintenance')
    expect(tasks[0]?.intervalHours).toBe(6)
    await fiber.dispose()
  })

  it('sweeps every stored scope when the task runs', async () => {
    const tasks: RecordedTask[] = []
    const { facility, fiber, store } = await harness({ heartbeat: tasks })
    await store.addArtifact(scope('one'), candidate('condemned one'))
    await store.addArtifact(scope('two'), candidate('condemned two'))
    await condemn(facility, scope('one'), artifactKey('condemned one'))
    await condemn(facility, scope('two'), artifactKey('condemned two'))
    await tasks[0]?.run(new AbortController().signal)
    expect(store.read(scope('one'))?.agentLessons).toEqual([])
    expect(store.read(scope('two'))?.agentLessons).toEqual([])
    await fiber.dispose()
  })

  it('stops before sweeping once its signal is aborted', async () => {
    const tasks: RecordedTask[] = []
    const { facility, fiber, store } = await harness({ heartbeat: tasks })
    const id = scope()
    await store.addArtifact(id, candidate('condemned fact'))
    await condemn(facility, id, artifactKey('condemned fact'))
    const controller = new AbortController()
    controller.abort()
    await tasks[0]?.run(controller.signal)
    expect(store.read(id)?.agentLessons).toHaveLength(1)
    await fiber.dispose()
  })

  it('sweeps directly when no heartbeat is mounted', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    await store.addArtifact(id, candidate('fresh fact', { ttlDays: 5 }))
    expect(await store.sweep(id)).toEqual({ pruned: 0, refined: 0 })
    expect(store.read(id)?.agentLessons).toHaveLength(1)
    await fiber.dispose()
  })
})
