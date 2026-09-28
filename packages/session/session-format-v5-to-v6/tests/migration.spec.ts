import { describe, expect, it } from 'vitest'
import { SessionFormatEventCollector, SessionFormatUnsupportedMigrationError } from '@deepseek-ai/dsh-session-format'
import type {
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
} from '@deepseek-ai/dsh-session-format'
import {
  assertReleasedV6Header,
  releasedV5SessionFormatCodec,
  releasedV6SessionFormatCodec,
  restoreReleasedV6Artifact,
  sessionFormatV5ToV6,
} from '../src/index.ts'
import { releasedV5SessionFormatCodec as releasedV5CodecFromPrecedingEdge } from '@deepseek-ai/dsh-session-format-v4-to-v5'

const sourceHeader: SessionFormatHeader = {
  version: 5,
  id: 'v5-to-v6',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
}

const attribution = { source: 'kernel', locator: 'node-1', digest: 'sha256:ab' }
const metadata = {
  version: 1, runId: 'run-1', taskId: 'task-1', actor: 'kernel', timestamp: 7, provenance: attribution,
}

function event(type: string, data: SessionFormatJsonObject, seq = 0): SessionFormatEvent {
  return { type, seq, time: seq + 1, data }
}

function migrate(events: readonly SessionFormatEvent[], header: SessionFormatHeader = sourceHeader) {
  const target = sessionFormatV5ToV6.migrateHeader(header)
  const stage = sessionFormatV5ToV6.createStage({
    sourceHeader: header,
    targetHeader: target,
    sourceInheritedEventCount: header.isSeeded ? undefined : 0,
    sourceKind: 'decoded',
  })
  const output = new SessionFormatEventCollector()
  for (const row of events) stage.transformEvent(row, output)
  return { events: output.values, cut: stage.finish(output), header: target }
}

describe('V5-to-V6 header conversion', () => {
  it('changes only the version and admits the V6 header it produced', () => {
    const target = sessionFormatV5ToV6.migrateHeader(sourceHeader)
    expect(target).toEqual({ ...sourceHeader, version: 6 })
    expect(() => { assertReleasedV6Header(target) }).not.toThrow()
    expect(() => { assertReleasedV6Header(sourceHeader) }).toThrow('expected format v6 header')
  })

  it('refuses a header that is not a released V5 header', () => {
    expect(() => sessionFormatV5ToV6.migrateHeader({ ...sourceHeader, version: 4 }))
      .toThrow('expected format v5 header')
  })
})

describe('V5-to-V6 event conversion', () => {
  it('preserves an event whose payload has no V6 delta as the same object', () => {
    const fact = event('feedback/record', { text: 'retained' })
    const result = migrate([fact])
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toBe(fact)
  })

  it('renames data.metadata.provenance to data.metadata.sourceRef and keeps every other member', () => {
    const row = event('task/plan', { taskId: 'task-1', revision: 2, plan: { steps: ['read'] }, metadata })
    const converted = migrate([row]).events[0]!
    expect(converted.data).toEqual({
      taskId: 'task-1', revision: 2, plan: { steps: ['read'] },
      metadata: {
        version: 1, runId: 'run-1', taskId: 'task-1', actor: 'kernel', timestamp: 7, sourceRef: attribution,
      },
    })
    expect(Object.hasOwn(converted.data as SessionFormatJsonObject, 'provenance')).toBe(false)
  })

  it('renames evidence/recorded data.provenance to data.sourceRef alongside the metadata rename', () => {
    const row = event('evidence/recorded', {
      evidenceId: 'e-1', kind: 'test', contentRef: 'test://a', trust: 'trusted', observedAt: 3,
      metadata, provenance: attribution,
    })
    const converted = migrate([row]).events[0]!
    expect(converted.data).toEqual({
      evidenceId: 'e-1', kind: 'test', contentRef: 'test://a', sourceRef: attribution, trust: 'trusted',
      observedAt: 3,
      metadata: { version: 1, runId: 'run-1', taskId: 'task-1', actor: 'kernel', timestamp: 7, sourceRef: attribution },
    })
  })

  it('keeps opaque nested data, ids, coordinates, and timestamps untouched', () => {
    const nested = { replayState: { blocks: [{ provenance: attribution }] }, toolArguments: { provenance: 'kept' } }
    const row = { ...event('verification/result', {
      taskId: 'task-1', revision: 1, outcome: 'passed', tests: [{ taskId: 'task-1', revision: 1, changedScopes: ['src/a'], criteria: [], repositoryDigest: 'sha256:cd', ...nested }],
    }, 4), id: 'keep-me' }
    const converted = migrate([row]).events[0]!
    expect(converted).toBe(row)
    expect(converted['id']).toBe('keep-me')
    expect(converted.seq).toBe(4)
    expect((converted.data as SessionFormatJsonObject)['tests']).toEqual([expect.objectContaining(nested)])
  })

  it('leaves a record without data.metadata untouched', () => {
    const row = event('claim/updated', { taskId: 'task-1', claim: 'held' })
    expect(migrate([row]).events[0]).toBe(row)
  })
})

describe('V5-to-V6 refusal families', () => {
  it('refuses the source kind V6 removed from every message slot it appeared in', () => {
    const source = { kind: 'workspace-memory-llm' }
    const rows: SessionFormatEvent[] = [
      { ...event('user/message', { id: 'u', role: 'user', content: [], source }), surfaceOp: 'append' },
      { ...event('developer/message', { turn: 1, step: 1, message: { id: 'd', role: 'developer', content: [], source } }), surfaceOp: 'append' },
      event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'i', role: 'user', content: [], source }] }),
      event('session/title-llm-request', { titleProvider: 't', route: { provider: 'mock', model: 'mock' }, messages: [{ id: 'm', role: 'user', content: [], source }] }),
    ]
    for (const row of rows) {
      expect(() => migrate([row])).toThrow(SessionFormatUnsupportedMigrationError)
      expect(() => migrate([row])).toThrow(
        `format v5 ${row.type} at seq 0 carries the source kind "workspace-memory-llm" that format v6 no longer admits`,
      )
    }
  })

  it('names every member V6 requires and a V5 record cannot supply', () => {
    const rows: [string, SessionFormatJsonObject, string][] = [
      ['budget/exceeded', { limit: 'maxTotalTokens', name: 'maxTotalTokens', observed: 10, step: 1, turn: 1 }, 'data.ceilings'],
      ['task/created', { taskId: 'task-1', objective: 'o', revision: 1, status: 'open', acceptance: [], constraints: [], agentProfile: 'p', budget: {}, policyProfile: 'p' }, 'data.dependencies'],
      ['task/transitioned', { taskId: 'task-1', revision: 1, taskRevision: 1, transitionId: 't', from: 'open', to: 'done', actor: 'kernel', at: 1, effects: [], preconditions: [], trigger: { kind: 'manual' } }, 'data.evidence'],
      ['verification/requested', { taskId: 'task-1', revision: 1, criteria: [], changedScopes: [] }, 'data.repositoryDigest'],
      ['hypothesis/updated', { hypothesisId: 'h', question: 'q', status: 'open', claims: [], tests: [{ taskId: 'task-1', revision: 1, changedScopes: [], criteria: [] }] }, 'data.tests[0].repositoryDigest'],
    ]
    for (const [type, data, member] of rows) {
      expect(() => migrate([event(type, data)])).toThrow(
        `format v5 ${type} at seq 0 lacks ${member}, which format v6 requires and this edge cannot synthesize`,
      )
    }
  })

  it('reports the first absent member of a record that lacks several', () => {
    const row = event('budget/exceeded', { limit: 'maxTotalTokens', name: 'maxTotalTokens', observed: 1, step: 1, turn: 1 })
    expect(() => migrate([row])).toThrow('lacks data.ceilings')
  })

  it('refuses an attribution rename that would collide with an existing V6 member', () => {
    const both = event('task/plan', { taskId: 'task-1', metadata: { ...metadata, sourceRef: attribution } })
    expect(() => migrate([both])).toThrow(
      'format v5 task/plan at seq 0 carries both data.metadata.provenance and data.metadata.sourceRef',
    )
    const evidence = event('evidence/recorded', {
      evidenceId: 'e-1', kind: 'test', contentRef: 'test://a', trust: 'trusted', observedAt: 1,
      sourceRef: attribution, provenance: attribution,
    })
    expect(() => migrate([evidence])).toThrow(
      'format v5 evidence/recorded at seq 0 carries both data.provenance and data.sourceRef',
    )
  })

  it('publishes no partial successor: the first refusal ends the artifact', () => {
    const good = event('task/plan', { taskId: 'task-1', revision: 1, metadata })
    const bad = event('budget/exceeded', { limit: 'maxTotalTokens', name: 'maxTotalTokens', observed: 1, step: 1, turn: 1 }, 1)
    expect(() => migrate([good, bad])).toThrow('lacks data.ceilings')
  })
})

describe('V5-to-V6 inherited cut', () => {
  const marker: SessionFormatEvent = event('session/end-seed', { inherited: true }, 2)
  const seeded = { ...sourceHeader, isSeeded: true }

  it('derives the exact cut from the seed marker when a preceding edge cannot supply it', () => {
    const rows = [event('feedback/record', { text: 'inherited' }, 0), marker, event('feedback/record', { text: 'local' }, 3)]
    const result = migrate(rows, seeded)
    expect(result.cut).toBe(2)
    expect(result.header.version).toBe(6)
  })

  it('uses the last marker when the inherited prefix contains nested seed boundaries', () => {
    const rows = [marker, event('feedback/record', { text: 'local' }, 3), { ...marker, seq: 4 }, event('feedback/record', { text: 'newest' }, 5)]
    expect(migrate(rows, seeded).cut).toBe(4)
  })

  it('refuses a seeded header that disagrees with its marker and an unseeded marker', () => {
    const target = sessionFormatV5ToV6.migrateHeader(seeded)
    const disagreeing = sessionFormatV5ToV6.createStage({
      sourceHeader: seeded, targetHeader: target, sourceInheritedEventCount: 1, sourceKind: 'decoded',
    })
    const output = new SessionFormatEventCollector()
    disagreeing.transformEvent(marker, output)
    expect(() => disagreeing.finish(output)).toThrow('disagrees with its inherited end-seed marker')

    const unseeded = sessionFormatV5ToV6.createStage({
      sourceHeader: sourceHeader, targetHeader: sessionFormatV5ToV6.migrateHeader(sourceHeader),
      sourceInheritedEventCount: 0, sourceKind: 'decoded',
    })
    expect(() => { unseeded.transformEvent(marker, new SessionFormatEventCollector()) })
      .toThrow('unseeded format v5 Session contains an inherited end-seed marker')
  })

  it('exposes the known cut before EOF and leaves a seeded unknown cut to finish', () => {
    const target = sessionFormatV5ToV6.migrateHeader(seeded)
    const known = sessionFormatV5ToV6.createStage({
      sourceHeader: seeded, targetHeader: target, sourceInheritedEventCount: 2, sourceKind: 'transformed',
    })
    expect(known.headerInheritedEventCount).toBe(2)
    const unknown = sessionFormatV5ToV6.createStage({
      sourceHeader: seeded, targetHeader: target, sourceInheritedEventCount: undefined, sourceKind: 'transformed',
    })
    expect(unknown.headerInheritedEventCount).toBeUndefined()
  })
})

describe('independent per-artifact stage state', () => {
  const seeded = { ...sourceHeader, isSeeded: true, id: 'seeded' }
  const marker: SessionFormatEvent = event('session/end-seed', { inherited: true }, 2)

  it('keeps two concurrent sessions on one migration declaration independent', () => {
    const target = sessionFormatV5ToV6.migrateHeader(seeded)
    const first = sessionFormatV5ToV6.createStage({
      sourceHeader: seeded, targetHeader: target, sourceInheritedEventCount: undefined, sourceKind: 'decoded',
    })
    const second = sessionFormatV5ToV6.createStage({
      sourceHeader: { ...seeded, id: 'other' }, targetHeader: target, sourceInheritedEventCount: undefined, sourceKind: 'decoded',
    })
    const firstOut = new SessionFormatEventCollector()
    const secondOut = new SessionFormatEventCollector()
    const inherited = event('feedback/record', { text: 'inherited' }, 0)
    const local = event('feedback/record', { text: 'local' }, 3)

    first.transformEvent(inherited, firstOut)
    second.transformEvent(inherited, secondOut)
    first.transformEvent({ ...marker, seq: 2 }, firstOut)
    second.transformEvent(local, secondOut)

    expect(firstOut.values).toEqual([inherited, { ...marker, seq: 2 }])
    expect(secondOut.values).toEqual([inherited, local])
    expect(first.finish(firstOut)).toBe(2)
    expect(() => second.finish(secondOut)).toThrow('disagrees with its inherited end-seed marker')
  })

  it('re-expands a compact run so a run-owned event is converted exactly like a scalar one', () => {
    const target = sessionFormatV5ToV6.migrateHeader(sourceHeader)
    const stage = sessionFormatV5ToV6.createStage({
      sourceHeader: sourceHeader, targetHeader: target, sourceInheritedEventCount: 0, sourceKind: 'decoded',
    })
    const output = new SessionFormatEventCollector()
    const rows = [event('task/plan', { taskId: 'task-1', revision: 1, metadata }, 0), event('feedback/record', { text: 'x' }, 1)]
    stage.transformRun({
      runType: 'packed',
      firstSeq: 0,
      eventCount: rows.length,
      expand: () => rows,
    }, output)
    expect(stage.finish(output)).toBe(0)
    expect(output.values).toHaveLength(2)
    expect((output.values[0]!.data as SessionFormatJsonObject)['metadata']).toMatchObject({ sourceRef: attribution })
    expect(output.values[1]).toBe(rows[1])
  })
})

describe('V6 codec and native admission', () => {
  const header: SessionFormatHeader = { ...sourceHeader, version: 6 }

  it('reuses the released V5 source codec and frames V6 rows under a V6 header', () => {
    // Codec reuse: the same released object, re-exported rather than redefined.
    expect(releasedV5SessionFormatCodec).toBe(releasedV5CodecFromPrecedingEdge)
    expect(releasedV5SessionFormatCodec.version).toBe(5)
    const seededHeader: SessionFormatHeader = { ...header, isSeeded: true }
    const encoded = releasedV6SessionFormatCodec.encodeHeader(seededHeader, 1)
    expect(encoded['version']).toBe(6)
    const decoder = releasedV6SessionFormatCodec.createDecoder(encoded, 'strict')
    const output = new SessionFormatEventCollector()
    const fact = event('feedback/record', { text: 'current' }, 0)
    const endSeed = { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } }
    decoder.decodeRow(releasedV6SessionFormatCodec.encodeEvent(fact), output)
    decoder.decodeRow(releasedV6SessionFormatCodec.encodeEvent(endSeed), output)
    expect(decoder.finish(output)).toBe(1)
    expect(output.values).toEqual([fact, endSeed])
    expect(releasedV6SessionFormatCodec.decodeHeader(encoded)).toEqual(seededHeader)
    expect(() => releasedV6SessionFormatCodec.decodeHeader({ ...encoded, version: 5 })).toThrow('expected format v6 physical header')
  })

  it('admits a native V6 artifact and refuses one that still carries V5 attribution', () => {
    const fact = event('feedback/record', { text: 'current' })
    const artifact = { header, inheritedEventCount: 0, events: [fact] }
    expect(restoreReleasedV6Artifact(artifact, new Set(['feedback/record']))).toBe(artifact)

    const legacy = { ...fact, data: { ...fact.data as SessionFormatJsonObject, metadata } }
    expect(() => restoreReleasedV6Artifact({ ...artifact, events: [legacy] }, new Set(['feedback/record'])))
      .toThrow('format v5 feedback/record at seq 0 still carries data.metadata.provenance')

    const evidence = event('evidence/recorded', {
      evidenceId: 'e-1', kind: 'test', contentRef: 'test://a', sourceRef: attribution, trust: 'trusted', observedAt: 1, provenance: attribution,
    })
    expect(() => restoreReleasedV6Artifact({ ...artifact, events: [evidence] }, new Set(['evidence/recorded'])))
      .toThrow('still carries data.provenance')
  })

  it('is deliberately narrower than the V6 schema: the installed Session package owns the rest', () => {
    const fact = event('external/unknown', { anything: true })
    expect(() => restoreReleasedV6Artifact({ header, inheritedEventCount: 0, events: [fact] }, new Set()))
      .toThrow()
  })
})
