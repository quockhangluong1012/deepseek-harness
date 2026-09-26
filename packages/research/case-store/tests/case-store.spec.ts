import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { EvidenceId } from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ConceptId, LearnerId } from '@deepseek-ai/dsh-learner-model'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import CaseStore, {
  caseArtifact, CaseId, caseStoreDomainSpec, emptyCaseArtifact, EvidenceKey, FindingId, ImpactId, InterpretationId,
  ObservationId, ThesisId,
} from '../src/index.ts'
import type { CaseEvidence, CaseFinding, CaseInterpretation, CaseObservation, CaseThesis } from '../src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const learnerA = LearnerId('learner-a')
const learnerB = LearnerId('learner-b')
const pip = ConceptId('pd-array-pip')
const mss = ConceptId('mss-entry')

const evidenceRef: CaseEvidence = {
  evidenceKey: EvidenceKey('ev-1'),
  kind: 'kernel',
  evidenceId: brandString<EvidenceId>('kernel-evidence-1'),
}
const observationOne: CaseObservation = {
  observationId: ObservationId('obs-1'),
  statement: 'D1 closed above the PD array high',
  timeframe: 'D1',
  evidence: [EvidenceKey('ev-1')],
  trust: 'trusted',
  observedAt: '2026-03-11T00:00:00.000Z',
}
const observationTwo: CaseObservation = {
  observationId: ObservationId('obs-2'),
  statement: 'M5 left a fair-value gap below the entry',
  timeframe: 'M5',
  evidence: [],
  trust: 'untrusted',
  observedAt: '2026-03-11T04:00:00.000Z',
}
const thesis: CaseThesis = {
  thesisId: ThesisId('th-1'),
  statement: 'MSS happened, therefore the entry is valid',
  at: '2026-03-11T04:05:00.000Z',
  trust: 'trusted',
}
const audit: CaseInterpretation<'audit'> = {
  interpretationId: InterpretationId('in-audit'),
  kind: 'audit',
  statement: 'MSS is not a standalone entry trigger',
  basis: [ObservationId('obs-1')],
  trust: 'trusted',
  at: '2026-03-11T04:10:00.000Z',
}
const critique: CaseInterpretation<'devil-advocate'> = {
  interpretationId: InterpretationId('in-devil'),
  kind: 'devil-advocate',
  statement: 'The PD array high was read before the D1 close',
  basis: [ObservationId('obs-2')],
  trust: 'trusted',
  at: '2026-03-11T04:12:00.000Z',
}
const scenario: CaseInterpretation<'scenario'> = {
  interpretationId: InterpretationId('in-scenario'),
  kind: 'scenario',
  statement: 'A D1 close back inside the range invalidates the long',
  basis: [ObservationId('obs-1'), ObservationId('obs-2')],
  trust: 'trusted',
  at: '2026-03-11T04:14:00.000Z',
}
const mistake: CaseFinding = {
  findingId: FindingId('f-mistake'),
  statement: 'Entry taken before the M5 confirmation',
  basis: [ObservationId('obs-2')],
  concepts: [mss],
  trust: 'trusted',
  at: '2026-03-11T04:20:00.000Z',
}
const lesson: CaseFinding = {
  findingId: FindingId('f-lesson'),
  statement: 'Read the D1 bias before looking for an M5 entry',
  basis: [ObservationId('obs-1')],
  concepts: [pip],
  trust: 'trusted',
  at: '2026-03-11T04:22:00.000Z',
}

/** Boot the store over the real storage hub and domain form, optionally over an existing medium. */
async function harness(pool: MemoryMediaPool = new MemoryMediaPool()) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  await ctx.plugin(CaseStore)
  return { ctx, pool, store: ctx.caseStore }
}

/** Open the case domain over an existing medium without a store in front of it. */
async function openDomain(pool: MemoryMediaPool) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  return new DomainFacility(ctx, { backend: 'memory', routes: {} }).open(caseStoreDomainSpec)
}

describe('case store', () => {
  it('opens a case holding exactly the spec fields and nothing else', async () => {
    const { store } = await harness()
    const record = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1', 'H1', 'M5'] })

    expect(record.artifact.symbol).toBe('EURUSD')
    expect(record.artifact.timeframes).toEqual(['D1', 'H1', 'M5'])
    expect(record.artifact.outcome).toBeNull()
    expect(Object.keys(record.artifact).sort()).toEqual([
      'agentAudit', 'alternativeScenarios', 'conceptsTested', 'devilAdvocate', 'evidence', 'learnerImpact',
      'lessons', 'mistakes', 'observations', 'outcome', 'symbol', 'timeframes', 'userThesis',
    ])
  })

  it('amends one field at a time without disturbing the others', async () => {
    const { store } = await harness()
    const opened = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1', 'M5'] })

    const withObservations = await store.amend(learnerA, opened.caseId, {
      observations: [observationOne, observationTwo],
      evidence: [evidenceRef],
    })
    expect(withObservations.artifact.observations).toHaveLength(2)
    expect(withObservations.artifact.userThesis).toEqual([])
    expect(withObservations.artifact.outcome).toBeNull()
  })

  it('replaces an entry that carries the same identity in place', async () => {
    const { store } = await harness()
    const opened = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1'] })
    await store.amend(learnerA, opened.caseId, { observations: [observationOne] })

    const revised = await store.amend(learnerA, opened.caseId, {
      observations: [{ ...observationOne, statement: 'D1 closed 3 pips above the PD array high' }],
    })
    expect(revised.artifact.observations).toHaveLength(1)
    expect(revised.artifact.observations[0]?.statement).toBe('D1 closed 3 pips above the PD array high')
  })

  it('keeps observations free of interpretation and interpretations citing observations', async () => {
    const { store } = await harness()
    const opened = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1', 'M5'] })
    const record = await store.amend(learnerA, opened.caseId, {
      observations: [observationOne],
      agentAudit: [audit],
      devilAdvocate: [critique],
      alternativeScenarios: [scenario],
    })

    expect(record.artifact.observations[0]).toEqual(observationOne)
    expect(Object.keys(record.artifact.observations[0] ?? {}).sort()).toEqual([
      'evidence', 'observationId', 'observedAt', 'statement', 'timeframe', 'trust',
    ])
    expect(record.artifact.agentAudit[0]).toEqual(audit)
    expect(record.artifact.devilAdvocate[0]?.kind).toBe('devil-advocate')
    expect(record.artifact.alternativeScenarios[0]?.kind).toBe('scenario')
    expect(record.artifact.agentAudit[0]?.basis).toEqual([ObservationId('obs-1')])
  })

  it('references kernel evidence by identity alone and labels an external locator', async () => {
    const { store } = await harness()
    const opened = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1'] })
    const record = await store.amend(learnerA, opened.caseId, {
      evidence: [evidenceRef, { evidenceKey: EvidenceKey('ev-2'), kind: 'external', locator: 'backtest-2024-03.csv', trust: 'untrusted' }],
    })

    expect(record.artifact.evidence[0]).toEqual({
      evidenceKey: EvidenceKey('ev-1'),
      kind: 'kernel',
      evidenceId: 'kernel-evidence-1',
    })
    expect(Object.keys(record.artifact.evidence[0] ?? {}).sort()).toEqual(['evidenceId', 'evidenceKey', 'kind'])
    expect(record.artifact.evidence[1]).toMatchObject({ kind: 'external', trust: 'untrusted' })
  })

  it('unions the concepts tested, records the outcome, and appends findings by identity', async () => {
    const { store } = await harness()
    const opened = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1', 'M5'] })

    await store.amend(learnerA, opened.caseId, { conceptsTested: [pip], userThesis: [thesis] })
    await store.amend(learnerA, opened.caseId, { conceptsTested: [pip, mss] })
    await store.amend(learnerA, opened.caseId, {
      mistakes: [mistake],
      lessons: [lesson],
      learnerImpact: [{ impactId: ImpactId('i-1'), conceptId: mss, impact: 'weakened', at: '2026-03-11T05:00:00.000Z', trust: 'trusted' }],
    })
    const resolved = await store.amend(learnerA, opened.caseId, {
      outcome: { statement: 'Stopped out below the range low', at: '2026-03-12T00:00:00.000Z', trust: 'trusted' },
    })

    expect(resolved.artifact.conceptsTested).toEqual([pip, mss])
    expect(resolved.artifact.userThesis).toEqual([thesis])
    expect(resolved.artifact.mistakes).toEqual([mistake])
    expect(resolved.artifact.lessons).toEqual([lesson])
    expect(resolved.artifact.learnerImpact[0]).toMatchObject({ conceptId: mss, impact: 'weakened' })
    expect(resolved.artifact.outcome?.statement).toBe('Stopped out below the range low')
  })

  it('refuses an artifact outside the spec at the durable boundary', () => {
    const empty = emptyCaseArtifact({ symbol: 'EURUSD', timeframes: ['D1'] })
    expect(caseArtifact.safeParse(empty).success).toBe(true)
    expect(caseArtifact.safeParse({ ...empty, narrative: 'not a spec field' }).success).toBe(false)
    expect(caseArtifact.safeParse({
      ...empty,
      observations: [{ ...observationOne, basis: [ObservationId('obs-2')] }],
    }).success).toBe(false)
    expect(caseArtifact.safeParse({
      ...empty,
      devilAdvocate: [{
        interpretationId: InterpretationId('in-1'),
        kind: 'devil-advocate',
        statement: 'no basis cited',
        trust: 'trusted',
        at: '2026-03-11T04:12:00.000Z',
      }],
    }).success).toBe(false)
    expect(caseArtifact.safeParse({
      ...empty,
      agentAudit: [{ ...scenario, interpretationId: InterpretationId('in-2') }],
    }).success).toBe(false)
  })

  it('serves the four consumers the spec names', async () => {
    const { store } = await harness()
    const opened = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1', 'M5'] })
    await store.amend(learnerA, opened.caseId, {
      observations: [observationOne, observationTwo],
      userThesis: [thesis],
      agentAudit: [audit],
      devilAdvocate: [critique],
      alternativeScenarios: [scenario],
      mistakes: [mistake],
      lessons: [lesson],
      conceptsTested: [pip, mss],
      learnerImpact: [{ impactId: ImpactId('i-1'), conceptId: mss, impact: 'weakened', at: '2026-03-11T05:00:00.000Z', trust: 'trusted' }],
      outcome: { statement: 'Stopped out below the range low', at: '2026-03-12T00:00:00.000Z', trust: 'trusted' },
    })

    const memory = store.forLearnerMemory(learnerA)
    expect(memory[0]).toMatchObject({ caseId: opened.caseId, symbol: 'EURUSD', conceptsTested: [pip, mss] })
    expect(memory[0]?.mistakes).toEqual([mistake])
    expect(memory[0]?.lessons).toEqual([lesson])

    const detection = store.forMisconceptionDetection(learnerA)
    expect(detection[0]?.userThesis).toEqual([thesis])
    expect(detection[0]?.agentAudit).toEqual([audit])
    expect(detection[0]?.devilAdvocate).toEqual([critique])

    const dataset = store.forBenchmarkDataset(learnerA)
    expect(dataset[0]?.artifact.observations).toHaveLength(2)
    expect(dataset[0]?.artifact.alternativeScenarios).toEqual([scenario])

    const intervention = store.forMentorIntervention(learnerA)
    expect(intervention[0]?.outcome?.statement).toBe('Stopped out below the range low')
    expect(intervention[0]?.learnerImpact[0]).toMatchObject({ conceptId: mss, impact: 'weakened' })
    expect(intervention[0]?.lessons).toEqual([lesson])
  })

  it('survives a restart over the same medium', async () => {
    const pool = new MemoryMediaPool()
    const first = await harness(pool)
    const opened = await first.store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1', 'M5'] })
    await first.store.amend(learnerA, opened.caseId, {
      observations: [observationOne],
      agentAudit: [audit],
      lessons: [lesson],
    })

    const reopened = await harness(pool)
    const record = reopened.store.get(learnerA, opened.caseId)
    expect(record?.artifact.symbol).toBe('EURUSD')
    expect(record?.artifact.observations).toEqual([observationOne])
    expect(record?.artifact.agentAudit).toEqual([audit])
    expect(record?.artifact.lessons).toEqual([lesson])
    expect(reopened.store.cases(learnerA)).toHaveLength(1)
  })

  it('isolates one learner scope from another', async () => {
    const pool = new MemoryMediaPool()
    const { store } = await harness(pool)
    const opened = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1'] })
    await store.amend(learnerA, opened.caseId, { observations: [observationOne], userThesis: [thesis] })

    expect(store.get(learnerB, opened.caseId)).toBeUndefined()
    expect(store.cases(learnerB)).toEqual([])
    expect(store.forLearnerMemory(learnerB)).toEqual([])
    expect(store.forMisconceptionDetection(learnerB)).toEqual([])
    expect(store.forMentorIntervention(learnerB)).toEqual([])
    expect(store.forBenchmarkDataset(learnerB)).toEqual([])
    await expect(store.amend(learnerB, opened.caseId, { observations: [observationTwo] })).rejects.toThrow()

    const own = await store.createCase(learnerB, { symbol: 'GBPUSD', timeframes: ['H4'] })
    expect(store.cases(learnerA).map(record => record.caseId)).toEqual([opened.caseId])
    expect(store.cases(learnerB).map(record => record.caseId)).toEqual([own.caseId])
    expect(store.forBenchmarkDataset().map(row => row.symbol)).toEqual(['EURUSD', 'GBPUSD'])
  })

  it('rejects an amendment to a case the learner does not hold', async () => {
    const { store } = await harness()
    await expect(store.amend(learnerA, CaseId('no-such-case'), {})).rejects.toThrow()
  })

  it('rejects a stored artifact carrying a field outside the spec at the next open', async () => {
    const pool = new MemoryMediaPool()
    const { store } = await harness(pool)
    const opened = await store.createCase(learnerA, { symbol: 'EURUSD', timeframes: ['D1'] })

    const record = store.get(learnerA, opened.caseId)
    const tampered = { ...record, artifact: { ...record?.artifact, narrative: 'not a spec field' } }
    for (const key of pool.media.get('ict_case')?.tables.get('cases')?.keys() ?? []) {
      pool.media.get('ict_case')?.tables.get('cases')?.set(key, tampered)
    }

    await expect(openDomain(pool)).rejects.toThrow(/does not match its schema/)
  })

  it('rejects a read before the store is started', () => {
    const ctx = new Context()
    const store = new CaseStore(ctx)
    expect(() => store.cases(learnerA)).toThrow('case store is not started yet')
  })
})
