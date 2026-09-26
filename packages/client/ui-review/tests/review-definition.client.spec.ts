/**
 * The review node: the durable `review/report` a `/review` or `/security-review`
 * run wrote, folded into one Chat node — plus the malformed-record edge a log
 * written by another build can leave behind.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {
  ConversationStartMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { reviewDefinition, type ReviewPanelData } from '../src/client/review-definition.ts'

const COMMAND_ID = 'command-1'

/** One durable review report, as the two commands record it. */
function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    commandId: COMMAND_ID,
    kind: 'code',
    target: '',
    summary: 'One issue found.',
    findings: [{ file: 'a.ts', line: '10', severity: 'high', message: 'boom' }],
    ...overrides,
  }
}

/** One `review/report` event; malformed payloads are these cases' point. */
function recorded(data: unknown): SessionEvent<'review/report'> {
  return { type: 'review/report', seq: SessionSeq(7), time: 700, data } as SessionEvent<'review/report'>
}

/** The start Match the engine hands this Definition for a record it claimed. */
function startMatch(event: SessionEvent<'review/report'>): ConversationStartMatch {
  return { event, role: 'start', location: { kind: 'unresolved' } }
}

/** The Context one start Match runs with. */
function context(event: SessionEvent<'review/report'>): Parameters<typeof reviewDefinition.start>[0] {
  const start = startMatch(event)
  return {
    key: 'review:command-1',
    kind: 'review',
    id: COMMAND_ID,
    matches: [start],
    start,
    state: undefined,
    current: new Map(),
  }
}

const reader: Parameters<typeof reviewDefinition.start>[2] = { previous: () => undefined }

/** Fold one recorded payload exactly as the engine drives the Definition. */
function fold(data: unknown): ReviewPanelData {
  const event = recorded(data)
  return reviewDefinition.start(context(event), startMatch(event), reader)
}

describe('review node', () => {
  it('claims only the review reports, keyed by their command identity', () => {
    expect(reviewDefinition.match(recorded(record()))).toEqual({ id: COMMAND_ID, role: 'start' })
    const unrelated: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(1), time: 100, data: { turn: 1 } }
    expect(reviewDefinition.match(unrelated)).toBeNull()
    expect(reviewDefinition.target).toBe('chat')
  })

  it('folds a report into the panel payload, preserving an absent line', () => {
    expect(fold(record())).toStrictEqual({
      kind: 'code',
      target: '',
      summary: 'One issue found.',
      findings: [{ file: 'a.ts', line: '10', severity: 'high', message: 'boom' }],
    })
    expect(fold(record({ findings: [{ file: 'b.ts', severity: 'low', message: 'nit' }] }))).toStrictEqual({
      kind: 'code',
      target: '',
      summary: 'One issue found.',
      findings: [{ file: 'b.ts', severity: 'low', message: 'nit' }],
    })
  })

  it('refuses a record that is not a complete report', () => {
    expect(() => fold(record({ findings: [{ file: 'a.ts', severity: 'critical', message: 'boom' }] })))
      .toThrow('review/report carries no complete review report')
    expect(() => fold(record({ summary: undefined })))
      .toThrow('review/report carries no complete review report')
    expect(() => fold(undefined))
      .toThrow('review/report carries no complete review report')
  })

  it('refuses a start Match over any other event', () => {
    const unrelated: SessionEvent<'turn/start'> = { type: 'turn/start', seq: SessionSeq(1), time: 100, data: { turn: 1 } }
    expect(() => reviewDefinition.start(
      {} as never,
      { event: unrelated, role: 'start', location: { kind: 'unresolved' } } as never,
      {} as never,
    )).toThrow('review start requires review/report')
  })

  it('builds one visible Chat node from the folded report and nothing before its start', () => {
    const event = recorded(record())
    const state = fold(record())
    expect(reviewDefinition.update({ ...context(event), state }, startMatch(event))).toBe(state)

    const base = { ...context(event), state }
    expect(reviewDefinition.buildViewNode?.({ ...base, matches: [], start: undefined })).toBeNull()
    const node = reviewDefinition.buildViewNode?.(base)
    if (node === null || node === undefined) throw new Error('expected one review Chat node')
    expect(node).toMatchObject({
      kind: 'review',
      id: COMMAND_ID,
      target: 'chat',
      anchorSeq: 7,
      location: { kind: 'unresolved' },
      visibility: 'visible',
      data: { kind: 'code', target: '', summary: 'One issue found.' },
    })
  })
})
