import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import LearnerModel, {
  applicationMastery, CaseReference, ConceptId, LearnerId, learnerModelDomainSpec,
} from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const learnerA = LearnerId('learner-a')
const learnerB = LearnerId('learner-b')
const pip = ConceptId('pd-array-pip')
const mss = ConceptId('mss-entry')
const caseOne = CaseReference('case-1')

/** Boot the store over the real storage hub and domain form, optionally over an existing medium. */
async function harness(pool: MemoryMediaPool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(LearnerModel)
  return { ctx, pool, store: ctx.learnerModel }
}

/** Open the learner-model domain over an existing medium without a store in front of it. */
async function openDomain(pool: MemoryMediaPool) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  return new DomainFacility(ctx, { backend: 'memory', routes: {} }).open(learnerModelDomainSpec)
}

describe('learner model store', () => {
  it('reads an empty record before anything is recorded', async () => {
    const { store } = await harness()
    const record = store.read(learnerA)
    expect(record.learnerId).toBe(learnerA)
    expect(record.updatedAt).toBeNull()
    expect(store.misconceptions(learnerA)).toEqual([])
    expect(store.mistakes(learnerA)).toEqual([])
    expect(store.objectives(learnerA)).toEqual([])
    expect(store.axes(learnerA, pip)).toEqual({ conceptId: pip, concept: undefined, application: undefined })
  })

  it('keeps stated familiarity and application mastery as separate axes', async () => {
    const { store } = await harness()
    await store.recordConcept(learnerA, { conceptId: pip, familiarity: 1, observations: 4, trust: 'trusted' })

    const stated = store.axes(learnerA, pip)
    expect(stated.concept?.familiarity).toBe(1)
    expect(stated.application).toBeUndefined()
    expect(store.read(learnerA).applicationAbility).toEqual([])

    await store.recordApplication(learnerA, { conceptId: pip, succeeded: false, trust: 'trusted' })
    const applied = store.axes(learnerA, pip)
    expect(applied.concept?.familiarity).toBe(1)
    expect(applied.application).toMatchObject({ attempts: 1, successes: 0 })
    const ability = applied.application
    expect(ability === undefined ? undefined : applicationMastery(ability)).toBe(0)
  })

  it('accumulates graded applications and derives mastery only once one is graded', async () => {
    const { store } = await harness()
    await store.recordApplication(learnerA, { conceptId: pip, succeeded: true, trust: 'trusted' })
    const one = store.read(learnerA).applicationAbility[0]
    expect(one?.attempts).toBe(1)
    expect(one === undefined ? undefined : applicationMastery(one)).toBe(1)

    await store.recordApplication(learnerA, { conceptId: pip, succeeded: false, trust: 'untrusted' })
    const two = store.read(learnerA).applicationAbility[0]
    expect(two).toMatchObject({ attempts: 2, successes: 1, trust: 'untrusted' })
    expect(two === undefined ? undefined : applicationMastery(two)).toBe(0.5)
  })

  it('refuses a caller value outside the durable contract without storing anything', async () => {
    const { store } = await harness()
    await expect(store.recordConcept(learnerA, {
      conceptId: pip, familiarity: 1.5, observations: 1, trust: 'trusted',
    })).rejects.toThrow()
    expect(store.read(learnerA).updatedAt).toBeNull()
    expect(store.read(learnerA).conceptKnowledge).toEqual([])
  })

  it('counts misconception recurrences, resolves it, and reopens it on the next detection', async () => {
    const { store } = await harness()
    await store.recordMisconception(learnerA, {
      misconceptionId: 'mss-standalone', statement: 'MSS is a standalone entry trigger', caseId: caseOne, trust: 'trusted',
    })
    await store.recordMisconception(learnerA, {
      misconceptionId: 'mss-standalone', statement: 'MSS is a standalone entry trigger', trust: 'trusted',
    })
    expect(store.misconceptions(learnerA)[0]).toMatchObject({
      recurrences: 2, status: 'detected', caseIds: [caseOne],
    })

    await store.setMisconceptionStatus(learnerA, 'mss-standalone', 'resolved')
    expect(store.misconceptions(learnerA)[0]?.status).toBe('resolved')

    await store.recordMisconception(learnerA, {
      misconceptionId: 'mss-standalone', statement: 'MSS is a standalone entry trigger', trust: 'trusted',
    })
    expect(store.misconceptions(learnerA)[0]).toMatchObject({ recurrences: 3, status: 'detected' })
  })

  it('rejects a status move for a misconception that was never recorded', async () => {
    const { store } = await harness()
    await expect(store.setMisconceptionStatus(learnerA, 'nope', 'addressed'))
      .rejects.toThrow(/unknown misconception 'nope'/)
  })

  it('counts recurring mistakes and unions the concepts they bear on', async () => {
    const { store } = await harness()
    await store.recordMistake(learnerA, {
      mistakeId: 'no-bias-check', statement: 'Entry without a bias read', conceptIds: [pip], caseId: caseOne, trust: 'trusted',
    })
    await store.recordMistake(learnerA, {
      mistakeId: 'no-bias-check', statement: 'Entry without a bias read', conceptIds: [mss], trust: 'trusted',
    })
    expect(store.mistakes(learnerA)[0]).toMatchObject({
      occurrences: 2, conceptIds: [pip, mss], caseIds: [caseOne],
    })
  })

  it('replaces the objective list while a surviving objective keeps its instant', async () => {
    const { store } = await harness()
    const first = await store.setObjectives(learnerA, [
      { objectiveId: 'o1', statement: 'Read the D1 bias first', concepts: [pip], trust: 'trusted' },
      { objectiveId: 'o2', statement: 'Stop treating MSS as a trigger', concepts: [mss], trust: 'trusted' },
    ])
    const raisedAt = first.objectives[1]?.raisedAt

    const second = await store.setObjectives(learnerA, [
      { objectiveId: 'o2', statement: 'Stop treating MSS as a trigger', concepts: [mss], trust: 'trusted' },
    ])
    expect(second.objectives).toHaveLength(1)
    expect(second.objectives[0]?.objectiveId).toBe('o2')
    expect(second.objectives[0]?.raisedAt).toBe(raisedAt)
    expect(store.objectives(learnerA)[0]?.raisedAt).toBe(second.objectives[0]?.raisedAt)
  })

  it('records one case-history entry per case and replaces it on re-application', async () => {
    const { store } = await harness()
    await store.applyCase(learnerA, {
      caseId: caseOne,
      symbol: 'EURUSD',
      outcome: 'reached target in 3 bars',
      conceptsTested: [pip],
      lessons: ['PD array held'],
      mistakes: ['entry before confirmation'],
      impacts: [{ conceptId: pip, impact: 'strengthened' }],
      trust: 'trusted',
    })
    const second = await store.applyCase(learnerA, {
      caseId: caseOne,
      symbol: 'EURUSD',
      outcome: 'stopped out',
      conceptsTested: [pip, mss],
      lessons: ['PD array held'],
      mistakes: ['entry before confirmation', 'ignored invalidation'],
      impacts: [{ conceptId: mss, impact: 'weakened' }],
      trust: 'untrusted',
    })

    expect(second.caseHistory).toHaveLength(1)
    expect(second.caseHistory[0]).toMatchObject({
      caseId: caseOne,
      symbol: 'EURUSD',
      outcome: 'stopped out',
      conceptsTested: [pip, mss],
      trust: 'untrusted',
    })
    expect(second.caseHistory[0]?.reviewedAt).toBe(second.updatedAt)
    expect(second.caseHistory[0]?.impacts[0]).toMatchObject({ conceptId: mss, impact: 'weakened', trust: 'untrusted' })
  })

  it('records stated confidence as its own reading', async () => {
    const { store } = await harness()
    await store.recordConfidence(learnerA, { conceptId: pip, stated: 0.9, trust: 'trusted' })
    await store.recordConfidence(learnerA, { conceptId: pip, stated: 0.4, trust: 'untrusted' })
    expect(store.read(learnerA).confidence).toHaveLength(1)
    expect(store.read(learnerA).confidence[0]).toMatchObject({ stated: 0.4, trust: 'untrusted' })
  })

  it('survives a restart over the same medium', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    await first.store.recordConcept(learnerA, {
      conceptId: pip, familiarity: 0.6, observations: 3, trust: 'trusted',
    })
    await first.store.recordApplication(learnerA, { conceptId: pip, succeeded: false, trust: 'trusted' })
    await first.store.recordMisconception(learnerA, {
      misconceptionId: 'mss-standalone', statement: 'MSS is a standalone trigger', caseId: caseOne, trust: 'trusted',
    })
    await first.store.setObjectives(learnerA, [
      { objectiveId: 'o1', statement: 'Read the D1 bias first', concepts: [pip], trust: 'trusted' },
    ])

    const reopened = await harness(pool)
    const record = reopened.store.read(learnerA)
    expect(record.conceptKnowledge[0]).toMatchObject({ conceptId: pip, familiarity: 0.6, observations: 3 })
    expect(record.applicationAbility[0]).toMatchObject({ conceptId: pip, attempts: 1, successes: 0 })
    expect(record.misconceptions[0]).toMatchObject({ misconceptionId: 'mss-standalone', caseIds: [caseOne] })
    expect(reopened.store.objectives(learnerA)[0]?.statement).toBe('Read the D1 bias first')
  })

  it('isolates one learner record from another across a restart', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    await first.store.recordConcept(learnerA, {
      conceptId: pip, familiarity: 1, observations: 2, trust: 'trusted',
    })

    const reopened = await harness(pool)
    expect(reopened.store.read(learnerB).updatedAt).toBeNull()
    expect(reopened.store.misconceptions(learnerB)).toEqual([])
    expect(reopened.store.read(learnerA).conceptKnowledge).toHaveLength(1)

    await reopened.store.recordConcept(learnerB, {
      conceptId: mss, familiarity: 0.2, observations: 1, trust: 'trusted',
    })
    expect(reopened.store.read(learnerA).conceptKnowledge.map(entry => entry.conceptId)).toEqual([pip])
    expect(reopened.store.read(learnerB).conceptKnowledge.map(entry => entry.conceptId)).toEqual([mss])
  })

  it('rejects a stored record that no longer matches the durable schema', async () => {
    const pool = new MemoryMediaPool()
    const { store } = await harness(pool)
    await store.recordConcept(learnerA, { conceptId: pip, familiarity: 0.5, observations: 1, trust: 'trusted' })

    const stored = store.read(learnerA)
    pool.media.get('learner_model')?.tables.get('learners')?.set(learnerA, {
      ...stored,
      conceptKnowledge: [{ ...stored.conceptKnowledge[0], familiarity: 2 }],
    })

    await expect(openDomain(pool)).rejects.toThrow(/does not match its schema/)
  })

  it('rejects a read before the store is started', () => {
    const ctx = new Context()
    const store = new LearnerModel(ctx)
    expect(() => store.read(learnerA)).toThrow('learner model store is not started yet')
  })
})
