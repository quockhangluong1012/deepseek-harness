import { describe, expect, it } from 'vitest'
import type {
  SessionFormatEvent,
  SessionFormatHeader,
  SessionFormatMigrationContext,
} from '@deepseek-ai/dsh-session-format'
import {
  releasedV5SessionFormatCodec,
  sessionFormatV4ToV5,
} from '../src/index.ts'

const sourceHeader: SessionFormatHeader = {
  version: 4,
  id: 'v4-to-v5',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
}

const inheritedEvent: SessionFormatEvent = {
  type: 'feedback/record',
  seq: 0,
  time: 1,
  data: { text: 'inherited' },
}

const inheritedMarker: SessionFormatEvent = {
  type: 'session/end-seed',
  seq: 1,
  time: 1,
  data: { inherited: true },
}

const turnEnded: SessionFormatEvent = {
  type: 'turn/end',
  seq: 2,
  time: 2,
  data: { turn: 1, reason: { kind: 'blocked' } },
}

function context(events: SessionFormatEvent[]): SessionFormatMigrationContext {
  return {
    emitEvent: event => events.push(event),
    emitRun: (run) => { for (const event of run.expand()) events.push(event) },
  }
}

describe('V4-to-V5 Session format migration', () => {
  it('changes only the header version and preserves the inherited event prefix', () => {
    const migration = sessionFormatV4ToV5
    const source = { ...sourceHeader, isSeeded: true }
    const target = migration.migrateHeader(source)
    const events: SessionFormatEvent[] = []
    const output = context(events)
    const stage = migration.createStage({
      sourceHeader: source,
      targetHeader: target,
      sourceInheritedEventCount: 1,
      sourceKind: 'decoded',
    })

    stage.transformEvent(inheritedEvent, output)
    stage.transformEvent(inheritedMarker, output)
    stage.transformEvent(turnEnded, output)

    expect(target).toEqual({ ...source, version: 5 })
    expect(stage.finish(output)).toBe(1)
    expect(events).toEqual([inheritedEvent, inheritedMarker, turnEnded])
    expect(() =>{  migration.validateTargetHeader(target) }).not.toThrow()
  })
  it('uses the last inherited marker when the V4 prefix contains nested seed boundaries', () => {
    const source = { ...sourceHeader, isSeeded: true }
    const target = sessionFormatV4ToV5.migrateHeader(source)
    const rows = [
      inheritedEvent,
      inheritedMarker,
      { ...inheritedEvent, seq: 2 },
      { ...inheritedMarker, seq: 3 },
      { ...turnEnded, seq: 4 },
    ]
    const events: SessionFormatEvent[] = []
    const output = context(events)
    const stage = sessionFormatV4ToV5.createStage({
      sourceHeader: source,
      targetHeader: target,
      sourceInheritedEventCount: undefined,
      sourceKind: 'decoded',
    })

    for (const event of rows) stage.transformEvent(event, output)

    expect(stage.finish(output)).toBe(3)
    expect(events).toEqual(rows)
  })
})

describe('V5 Session format codec', () => {
  it('round-trips the new max-steps turn-end reason under a V5 header', () => {
    const header: SessionFormatHeader = { ...sourceHeader, version: 5 }
    const event: SessionFormatEvent = {
      type: 'turn/end',
      seq: 0,
      time: 2,
      data: { turn: 1, reason: { kind: 'max-steps' } },
    }
    const encodedHeader = releasedV5SessionFormatCodec.encodeHeader(header, 0)
    const decoder = releasedV5SessionFormatCodec.createDecoder(encodedHeader, 'strict')
    const events: SessionFormatEvent[] = []
    const output = context(events)

    decoder.decodeRow(releasedV5SessionFormatCodec.encodeEvent(event), output)

    expect(encodedHeader.version).toBe(5)
    expect(decoder.finish(output)).toBe(0)
    expect(events).toEqual([event])
  })
})
