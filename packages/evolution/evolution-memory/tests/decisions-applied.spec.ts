import { describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMemoryStore, {
  EvolutionScopeId,
  type Config,
  type EvolutionDecisionsApplied,
  type EvolutionExtraction,
  type LessonArtifactInput,
  type LessonDecision,
} from '../src/index.ts'
import type { EvolutionScopeId as ScopeId } from '../src/types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

async function harness(config: Config = { capacityBytes: 65536 }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const lockDirectory = await mkdtemp(join(tmpdir(), 'dsh-evolution-memory-locks-'))
  // Object.assign: the Config interface shares its name with the schema value,
  // which trips no-misused-spread's class-instance check.
  const fiber = await ctx.plugin(EvolutionMemoryStore, Object.assign({ lockDirectory }, config))
  const published: EvolutionDecisionsApplied[] = []
  ctx.on('evolution/decisions-applied', (batch) => {
    published.push(batch)
  })
  return { ctx, fiber, store: ctx.evolutionMemory, published }
}

function scope(name = 'ws-decisions'): ScopeId {
  return EvolutionScopeId('test', name)
}

/** One caller-supplied artifact candidate, with the fields a test varies pinned. */
function candidate(statement: string, source = 's1'): LessonArtifactInput {
  return {
    statement, source, conditions: '', evidence: 'fact', confidence: 0.9, scope: 'project',
    sourceRefs: [`session:${source}`], trajectoryRefs: [`run:${source}`], lineage: { origin: source },
  }
}

/** One extraction record, as the reviewer stamps it on a batch. */
function extraction(sessionId: string): EvolutionExtraction {
  return {
    at: '2026-09-22T00:00:00.000Z',
    sessionId,
    provider: 'stub',
    model: 'stub-model',
    origin: 'background_review',
    inputBytes: 10,
    truncated: false,
  }
}

/** A staged payload carrying a decision batch, as the reviewer stages one. */
function batchPayload(decisions: LessonDecision[]): JsonValue {
  return { decisions, extraction: extraction('s7') } as unknown as JsonValue
}

describe('evolution-memory applied decision batches', () => {
  it('publishes the batch and the artifacts it addressed', async () => {
    const h = await harness()
    try {
      const id = scope()
      await h.store.addArtifact(id, candidate('use postgres 15'))
      const decisions: LessonDecision[] = [
        { kind: 'confirms', artifactId: 'use postgres 15' },
        { kind: 'new', candidate: candidate('prefers terse answers') },
      ]
      await h.store.applyExtractionDecisions(id, decisions, extraction('s1'))
      // The artifacts published are the ones the decisions were resolved
      // against: the stored artifact has already moved past them, so a
      // consumer that resolved its own state from the record instead would
      // read a claim's evidence from after its correction.
      expect(h.published).toEqual([{
        scopeId: id,
        sessionId: 's1',
        decisions,
        artifacts: [expect.objectContaining({ id: 'use postgres 15', validationCount: 0 })],
      }])
      expect(h.store.read(id)?.agentLessons[0]?.validationCount).toBe(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('counts a paraphrased new decision as a validation of the lesson it matched', async () => {
    const h = await harness()
    try {
      // Every vector is identical, so the similarity lookup selects the
      // standing fact as the target; the decision omits a strategy, so the
      // fold runs under keep_both.
      h.ctx.provide('embeddings', {
        embed: async ({ texts }: { texts: readonly string[] }) => ({ vectors: texts.map(() => [1]) }),
      })
      const id = scope()
      await h.store.addArtifact(id, candidate('use postgres', 's1'))
      const record = await h.store.applyExtractionDecisions(id, [
        { kind: 'new', candidate: candidate('prefers postgres for storage', 's2') },
      ])
      // The fact keeps its identity and gains the extraction's evidence; no
      // twin artifact was stored beside it.
      expect(record.agentLessons).toHaveLength(1)
      expect(record.agentLessons[0]).toMatchObject({ id: 'use postgres', statement: 'use postgres', validationCount: 1 })
      expect(record.lessonsUpdatedAt).toEqual(expect.any(String))
    } finally {
      await h.fiber.dispose()
    }
  })

  it('publishes nothing for a batch applied without an extraction record', async () => {
    const h = await harness()
    try {
      const id = scope()
      await h.store.addArtifact(id, candidate('use postgres 15'))
      await h.store.applyExtractionDecisions(id, [{ kind: 'confirms', artifactId: 'use postgres 15' }])
      expect(h.published).toEqual([])
      expect(h.store.read(id)?.agentLessons[0]?.validationCount).toBe(1)
    } finally {
      await h.fiber.dispose()
    }
  })

  it('publishes an approved staged batch under the entry origin session', async () => {
    const h = await harness()
    try {
      const id = scope()
      await h.store.addArtifact(id, candidate('use postgres 15'))
      const decisions: LessonDecision[] = [{ kind: 'confirms', artifactId: 'use postgres 15' }]
      const staged = await h.store.stageWrite({
        scopeId: id,
        kind: 'memory',
        op: 'applyDecisions',
        payload: batchPayload(decisions),
        originSessionId: 's7',
        gist: '1 confirms, 0 contradicts, 0 new',
      })
      expect(h.published).toEqual([])
      await h.store.approveStaged(staged.id)
      expect(h.published).toEqual([{
        scopeId: id,
        sessionId: 's7',
        decisions,
        artifacts: [expect.objectContaining({ id: 'use postgres 15', validationCount: 0 })],
      }])
    } finally {
      await h.fiber.dispose()
    }
  })

  it('contains a listener failure instead of failing the durable write', async () => {
    const h = await harness()
    const warn = vi.spyOn(h.ctx.logger, 'warn')
    h.ctx.on('evolution/decisions-applied', () => {
      throw new Error('hostile consumer')
    })
    try {
      const id = scope()
      await h.store.addArtifact(id, candidate('use postgres 15'))
      // The batch is stored by the time listeners run, so their failure is
      // reported rather than turning a committed write into a rejected call.
      await h.store.applyExtractionDecisions(id, [{ kind: 'confirms', artifactId: 'use postgres 15' }], extraction('s1'))
      expect(h.store.read(id)?.agentLessons[0]?.validationCount).toBe(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('decisions-applied listener failed'))
    } finally {
      warn.mockRestore()
      await h.fiber.dispose()
    }
  })
})
