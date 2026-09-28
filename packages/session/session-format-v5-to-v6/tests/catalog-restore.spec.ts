/** Strict V5-to-V6 restoration through the build-static catalog, including multi-hop cuts. */

import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createSessionFormatCatalogWithChildren, sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog'
import type {
  SessionFormatArtifact,
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatJsonObject,
  SessionFormatJsonValue,
} from '@deepseek-ai/dsh-session-format'
import { isSessionFormatJsonObject } from '@deepseek-ai/dsh-session-format'
import { releasedV5SessionFormatCodec } from '../src/index.ts'

/** Events the installed V6 writer actually produces, used as the conversion oracle. */
function currentEvents(): { header: SessionFormatHeader; events: readonly SessionFormatEvent[] } {
  const session = Session.create(SessionId('v5-to-v6'))
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hello' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return {
    header: { ...session.header, delegationDepth: 0 },
    // The writer's typed events are the oracle for the durable rows the edge reads.
    events: session.snapshotEvents() as readonly SessionFormatEvent[],
  }
}

const attribution = { source: 'kernel', locator: 'node-1', digest: 'sha256:ab' }
const metadata = { version: 1, runId: 'run-1', taskId: 'task-1', actor: 'kernel', timestamp: 7, provenance: attribution }

/** One current writer event carrying the V5 `data.metadata` member the edge renames. */
function v5Row(row: SessionFormatEvent): SessionFormatEvent {
  if (!isSessionFormatJsonObject(row.data)) throw new Error(`fixture event ${row.type} carries no data object`)
  return { ...row, data: { ...row.data, metadata } }
}

function v5PhysicalHeader(header: SessionFormatHeader): SessionFormatJsonObject {
  return { type: 'session', ...header, version: 5 }
}

function restoreV5(header: SessionFormatHeader, rows: readonly SessionFormatEvent[]): SessionFormatArtifact {
  const reader = sessionFormatCatalog.createRestore(v5PhysicalHeader(header), {
    recovery: 'strict',
    validation: 'current',
  })
  for (const row of rows) reader.decodeRow(releasedV5SessionFormatCodec.encodeEvent(row))
  return reader.finish()
}

describe('strict V5-to-V6 catalog restoration', () => {
  it('migrates a released V5 record to the V6 writer shape and reopens it natively', () => {
    const { header, events } = currentEvents()
    const v5 = events.map(v5Row)
    const before = JSON.stringify(v5)
    const target = restoreV5(header, v5)

    expect(target.header.version).toBe(SESSION_FORMAT_VERSION)
    expect(SESSION_FORMAT_VERSION).toBe(6)
    expect(target.inheritedEventCount).toBe(0)
    expect((target.events[0]!.data as SessionFormatJsonObject)['metadata']).toEqual({
      version: 1, runId: 'run-1', taskId: 'task-1', actor: 'kernel', timestamp: 7, sourceRef: attribution,
    })
    expect(target.events.map(row => row.type)).toEqual(events.map(row => row.type))
    expect(JSON.stringify(v5)).toBe(before)

    const native = sessionFormatCatalog.createRestore(sessionFormatCatalog.encodeCurrentHeader(target.header, 0), {
      recovery: 'strict',
      validation: 'current',
    })
    for (const row of target.events) native.decodeRow(sessionFormatCatalog.encodeCurrentEvent(row))
    expect(native.finish()).toEqual(target)
  })

  it('is deterministic across repeated restores of the same source', () => {
    const { header, events } = currentEvents()
    const v5 = events.map(v5Row)
    expect(JSON.stringify(restoreV5(header, v5))).toBe(JSON.stringify(restoreV5(header, v5)))
  })

  it('refuses a corrupt physical row without publishing a partial successor', () => {
    const { header, events } = currentEvents()
    const v5 = events.map(v5Row)
    const reader = sessionFormatCatalog.createRestore(v5PhysicalHeader(header), {
      recovery: 'strict',
      validation: 'current',
    })
    reader.decodeRow(releasedV5SessionFormatCodec.encodeEvent(v5[0]!))
    expect(() => { reader.decodeRow(releasedV5SessionFormatCodec.encodeEvent({ ...v5[0]!, seq: 7 })) })
      .toThrow('has seq gap')
  })

  it('refuses a seed marker in an unseeded V5 record', () => {
    const { header, events } = currentEvents()
    const v5 = [...events.map(v5Row), { type: 'session/end-seed', seq: 1, time: 9, data: { inherited: true } }]
    expect(() => restoreV5(header, v5)).toThrow('unseeded format v5 Session contains an inherited end-seed marker')
  })

  it('refuses an unknown required event type and admits the same type as ignorable', () => {
    const { header, events } = currentEvents()
    const v5 = events.map(v5Row)
    const unknown: SessionFormatEvent = { type: 'external/required', seq: v5.length, time: 99, data: { any: true } }
    expect(() => restoreV5(header, [...v5, unknown])).toThrow(/unknown event type/)

    const ignorable = { ...unknown, ignorable: true }
    const target = restoreV5(header, [...v5, ignorable])
    expect(target.events.at(-1)).toEqual(ignorable)
  })

  it('refuses a V5 record the edge cannot map and leaves the source rows unchanged', () => {
    const { header, events } = currentEvents()
    const v5 = events.map(v5Row)
    const refusing: SessionFormatEvent = {
      type: 'user/message',
      seq: v5.length,
      time: 99,
      surfaceOp: 'append',
      data: { id: 'u', role: 'user', content: [], source: { kind: 'workspace-memory-llm' } },
    }
    const before = JSON.stringify([...v5, refusing])
    expect(() => restoreV5(header, [...v5, refusing])).toThrow(
      'format v5 user/message at seq 1 carries the source kind "workspace-memory-llm" that format v6 no longer admits',
    )
    expect(JSON.stringify([...v5, refusing])).toBe(before)
  })

  it('never falls back to a predecessor when the selected generation is newer or invalid', () => {
    const { header, events } = currentEvents()
    const v5 = events.map(v5Row)
    const newer = sessionFormatCatalog.readHeader({ type: 'session', ...header, version: 7 })
    expect(newer).toMatchObject({ status: 'unsupported', storedVersion: 7 })
    expect(() => sessionFormatCatalog.createRestore({ type: 'session', ...header, version: 7 }, {
      recovery: 'strict',
      validation: 'current',
    })).toThrow('newer format v7')

    const missing = sessionFormatCatalog.readHeader({ type: 'session', id: header.id })
    expect(missing.status).toBe('malformed')
    expect(restoreV5({ ...header, id: 'other' }, v5).header.id).toBe('other')
  })
})

describe('seeded multi-hop restoration from an older generation', () => {
  /** One released V0 shape whose first surface sits inside an open step, so every edge can admit it. */
  const v0Header = { type: 'session', version: 0, id: 'v0-seeded', createdAt: 1, cwd: '/work', delegationDepth: 0 }
  const v0Rows: SessionFormatJsonValue[] = [
    { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
    { type: 'step/start', seq: 1, time: 3, data: { turn: 1, step: 1 } },
    { type: 'user/message', seq: 2, time: 4, data: { id: 'seed-a', role: 'user', content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'session/end-seed', seq: 3, time: 5, data: {} },
    { type: 'step/end', seq: 4, time: 6, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 7, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  function restoreV0(header: SessionFormatJsonObject): SessionFormatArtifact {
    const reader = createSessionFormatCatalogWithChildren([]).createRestore(header, {
      recovery: 'strict',
      validation: 'current',
    })
    for (const row of v0Rows) reader.decodeRow(row)
    return reader.finish()
  }

  it('carries a seeded inherited cut from V0 across every adjacent edge to V6', () => {
    const target = restoreV0({ ...v0Header, seedLength: 3 })
    expect(target.header.version).toBe(6)
    expect(target.header.isSeeded).toBe(true)
    // The V2-to-V3 edge inserts a system head before the marker, so the cut is a target event count.
    expect(target.inheritedEventCount).toBe(4)
    expect(target.events.map(row => row.type)).toEqual([
      'turn/start', 'step/start', 'system/message', 'user/message', 'session/end-seed', 'step/end', 'turn/end',
    ])
    const marker = target.events.find(row => row.type === 'session/end-seed')
    expect(marker?.seq).toBe(4)
  })

})
