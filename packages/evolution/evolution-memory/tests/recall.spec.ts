import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import EvolutionMemoryStore, {
  EvolutionScopeId,
  RECALL_LABEL_PREFIX,
  memoryUtility,
  recallTarget,
} from '../src/index.ts'
import { appendRecall, bindRecalls, gradeRecall } from '../src/recall.ts'
import type { EvolutionExtraction, MemoryRecall, Config } from '../src/index.ts'
import type { EvolutionScopeId as ScopeId } from '../src/types.ts'

async function harness(config: Config = { capacityBytes: 65536 }) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const fiber = await ctx.plugin(EvolutionMemoryStore, config)
  return { ctx, fiber, store: ctx.evolutionMemory }
}

function scope(name = 'ws-1'): ScopeId {
  return EvolutionScopeId('test', name)
}

/** One recall row with the fields a test varies pinned. */
function recall(overrides: Partial<MemoryRecall> = {}): MemoryRecall {
  return {
    id: 'prior-work',
    itemId: 'item-1',
    at: '2026-01-01T00:00:00.000Z',
    decidedInSessionId: null,
    decidedAt: null,
    outcome: null,
    outcomeAt: null,
    ...overrides,
  }
}

const extraction: EvolutionExtraction = {
  at: '2026-01-01T01:00:00.000Z',
  sessionId: 's-asking',
  provider: 'p',
  model: 'm',
  origin: 'background_review',
  inputBytes: 10,
  truncated: false,
}

describe('recall labels', () => {
  it('reads the recalled memory out of a recall label only', () => {
    expect(recallTarget(`${RECALL_LABEL_PREFIX}s-9`)).toBe('s-9')
    expect(recallTarget(`${RECALL_LABEL_PREFIX}  s-9  `)).toBe('s-9')
    expect(recallTarget(RECALL_LABEL_PREFIX)).toBeUndefined()
    expect(recallTarget(`${RECALL_LABEL_PREFIX}   `)).toBeUndefined()
    expect(recallTarget('Pasted notes')).toBeUndefined()
  })
})

describe('recall ledger folds', () => {
  it('prepends a recall and drops the oldest past the cap', () => {
    const first = recall({ id: 'a' })
    const second = recall({ id: 'b' })
    expect(appendRecall([first], second, 5).map(row => row.id)).toEqual(['b', 'a'])
    expect(appendRecall([first], second, 1).map(row => row.id)).toEqual(['b'])
  })

  it('binds every awaiting recall once and leaves the rest alone', () => {
    const awaiting = recall({ id: 'a' })
    const bound = recall({ id: 'b', decidedInSessionId: 's-1', decidedAt: '2026-01-01T00:00:00.000Z' })
    const rows = bindRecalls([awaiting, bound], 's-2', '2026-01-02T00:00:00.000Z')
    expect(rows[0]).toMatchObject({ id: 'a', decidedInSessionId: 's-2', decidedAt: '2026-01-02T00:00:00.000Z' })
    // The already-bound recall keeps the batch that landed first.
    expect(rows[1]).toBe(bound)
    // Nothing awaiting answers the input itself: no write follows from it.
    expect(bindRecalls([bound], 's-2', '2026-01-02T00:00:00.000Z')).toEqual([bound])
  })

  it('grades the newest awaiting recall of one memory', () => {
    const older = recall({ at: '2026-01-01T00:00:00.000Z' })
    const newer = recall({ at: '2026-01-02T00:00:00.000Z', itemId: 'item-2' })
    const graded = gradeRecall([newer, older], 'prior-work', 'ok', '2026-01-03T00:00:00.000Z')
    expect(graded[0]).toMatchObject({ itemId: 'item-2', outcome: 'ok', outcomeAt: '2026-01-03T00:00:00.000Z' })
    expect(graded[1]?.outcome).toBeNull()
    // A memory with nothing awaiting is left as it was.
    expect(gradeRecall([recall({ id: 'other' })], 'prior-work', 'ok', '2026-01-03T00:00:00.000Z'))
      .toEqual([recall({ id: 'other' })])
  })
})

describe('memory utility', () => {
  it('derives relevance, decision impact, and outcome gain from the ledger', () => {
    const rows = [
      recall({ id: 'a', at: '2026-01-03T00:00:00.000Z', decidedInSessionId: 's-1', outcome: 'ok' }),
      recall({ id: 'a', at: '2026-01-02T00:00:00.000Z', decidedInSessionId: 's-1' }),
      recall({ id: 'a', at: '2026-01-01T00:00:00.000Z' }),
      recall({ id: 'b', at: '2026-01-04T00:00:00.000Z', decidedInSessionId: 's-2' }),
    ]

    const [a, b] = memoryUtility(rows)

    // Recalled three times: relevance 3/4 over two decided and one clean recall.
    expect(a).toMatchObject({ id: 'a', recalls: 3, decidedRecalls: 2, gradedRecalls: 1, okRecalls: 1 })
    expect(a?.utility).toBeCloseTo((3 / 4) * (2 / 3) * (1 / 3), 12)
    // Equally retrieved, but no outcome is recorded: no proven gain, so lower.
    expect(b).toMatchObject({ id: 'b', recalls: 1, decidedRecalls: 1, gradedRecalls: 0, okRecalls: 0 })
    expect(b?.utility).toBe(0)
    expect(b?.utility).toBeLessThan(a?.utility ?? 0)
  })

  it('derives a reading for every recorded recall and none without one', () => {
    expect(memoryUtility([])).toEqual([])
    expect(memoryUtility([recall({ id: 'a' })])).toHaveLength(1)
    // One recall with nothing after it: retrieved, no impact, no gain.
    expect(memoryUtility([recall({ id: 'a' })])[0]?.utility).toBe(0)
  })

  it('raises a recalled memory above an equally recalled one with no outcome', () => {
    const [helped, unproven] = memoryUtility([
      recall({ id: 'helped', decidedInSessionId: 's-1', outcome: 'ok' }),
      recall({ id: 'unproven', decidedInSessionId: 's-2' }),
    ])
    // Same retrieval count, same decision impact; only the recorded outcome differs.
    expect(helped).toMatchObject({ id: 'helped', recalls: 1, decidedRecalls: 1, okRecalls: 1 })
    expect(unproven).toMatchObject({ id: 'unproven', recalls: 1, decidedRecalls: 1, okRecalls: 0 })
    expect(helped?.utility).toBeCloseTo(0.5, 12)
    expect(unproven?.utility).toBe(0)
  })
})

describe('recall ledger over the store', () => {
  it('counts a recall as the recalled item lands, and only for recall labels', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    try {
      await store.addContextItem(id, { kind: 'text', label: 'Pasted notes', text: 'x' })
      expect(store.recalls()).toEqual([])
      const record = await store.addContextItem(id, { kind: 'text', label: `${RECALL_LABEL_PREFIX}s-9`, text: 'prior snippet' })
      expect(record.recalls).toHaveLength(1)
      expect(record.recalls[0]).toMatchObject({
        id: 's-9',
        itemId: record.contextItems[1]?.id,
        at: record.contextItems[1]?.addedAt,
        decidedInSessionId: null,
        outcome: null,
      })
      expect(store.recalls()).toMatchObject([{ id: 's-9', scopeId: id }])
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps the newest recalls and reports the scope each landed in', async () => {
    const { fiber, store } = await harness({ capacityBytes: 65536, maxRecalls: 2 })
    const one = scope('ws-1')
    const other = scope('ws-2')
    try {
      for (const target of ['s-1', 's-2', 's-3']) {
        await store.addContextItem(one, { kind: 'text', label: `${RECALL_LABEL_PREFIX}${target}`, text: 'x' })
      }
      await store.addContextItem(other, { kind: 'text', label: `${RECALL_LABEL_PREFIX}s-4`, text: 'x' })

      expect(store.recalls().map(row => [String(row.scopeId), row.id]))
        .toEqual([[String(one), 's-3'], [String(one), 's-2'], [String(other), 's-4']])
    } finally {
      await fiber.dispose()
    }
  })

  it('binds an awaiting recall to the decision batch that lands after it', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    try {
      await store.addContextItem(id, { kind: 'text', label: `${RECALL_LABEL_PREFIX}s-9`, text: 'x' })
      await store.applyExtractionDecisions(id, [], extraction)
      // The batch lands now; the stored instant is the write's, not the call's.
      expect(store.read(id)?.recalls[0]).toMatchObject({ decidedInSessionId: 's-asking' })
      expect(typeof store.read(id)?.recalls[0]?.decidedAt).toBe('string')

      // A later batch leaves the bound recall alone, and a batch without
      // provenance binds nothing.
      await store.addContextItem(id, { kind: 'text', label: `${RECALL_LABEL_PREFIX}s-10`, text: 'y' })
      await store.applyExtractionDecisions(id, [{ kind: 'confirms', artifactId: 'gone' }])
      expect(store.read(id)?.recalls[0]).toMatchObject({ id: 's-10', decidedInSessionId: null })
      await store.applyExtractionDecisions(id, [], { ...extraction, sessionId: 's-later' })
      expect(store.read(id)?.recalls.map(row => row.decidedInSessionId)).toEqual(['s-later', 's-asking'])
    } finally {
      await fiber.dispose()
    }
  })

  it('grades one recall and refuses a memory with nothing awaiting an outcome', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    try {
      await store.addContextItem(id, { kind: 'text', label: `${RECALL_LABEL_PREFIX}s-9`, text: 'x' })
      const graded = await store.recordRecallOutcome(id, 's-9', 'ok', '2026-01-02T00:00:00.000Z')
      expect(graded.recalls[0]).toMatchObject({ outcome: 'ok', outcomeAt: '2026-01-02T00:00:00.000Z' })
      expect(store.recallUtility()).toMatchObject([{ id: 's-9', recalls: 1, gradedRecalls: 1, okRecalls: 1 }])

      await expect(store.recordRecallOutcome(id, 's-9', 'failed')).rejects.toMatchObject({
        code: 'evolution/item-not-found',
      })
      await expect(store.recordRecallOutcome(scope('absent'), 's-9', 'ok')).rejects.toMatchObject({
        code: 'evolution/item-not-found',
      })
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps the recall after its item is detached', async () => {
    const { fiber, store } = await harness()
    const id = scope()
    try {
      const record = await store.addContextItem(id, { kind: 'text', label: `${RECALL_LABEL_PREFIX}s-9`, text: 'x' })
      const item = record.contextItems[0]
      await store.removeContextItem(id, item?.id ?? '')
      expect(store.read(id)?.contextItems).toEqual([])
      expect(store.read(id)?.recalls).toHaveLength(1)
    } finally {
      await fiber.dispose()
    }
  })
})
