import { describe, expect, it } from 'vitest'
import { SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { fuseSessionRankings, RECIPROCAL_RANK_K } from '../src/index.ts'
import type { SessionSearchHit } from '../src/index.ts'

/** Minimal hit carrying only what ranking reads. */
function hit(id: string): SessionSearchHit {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    isSeeded: false,
  }
  return {
    header,
    live: false,
    persisted: true,
    bestMatch: {
      sessionId: header.id,
      seq: 0 as SessionSearchHit['bestMatch']['seq'],
      type: 'user/message',
      time: 1,
      surface: 'current',
      snippet: id,
    },
  }
}

describe('reciprocal rank fusion', () => {
  it('returns nothing when neither ranking found anything', () => {
    expect(fuseSessionRankings([], [])).toEqual([])
    expect(RECIPROCAL_RANK_K).toBe(60)
  })

  it('keeps a session only one ranking found', () => {
    const fused = fuseSessionRankings([hit('only')], [])
    expect(fused.map(entry => entry.header.id)).toEqual(['only'])
  })

  it('ranks a session both channels agree on above either channel alone', () => {
    const fused = fuseSessionRankings([hit('a'), hit('shared')], [hit('shared'), hit('b')])
    expect(fused[0]?.header.id).toBe('shared')
    expect(fused.map(entry => entry.header.id).sort()).toEqual(['a', 'b', 'shared'])
  })

  it('breaks a tied fused score by session id so the order is stable', () => {
    // One ranking per session gives every session the same single contribution.
    const three = fuseSessionRankings([hit('c')], [hit('b')], [hit('a')])
    expect(three.map(entry => entry.header.id)).toEqual(['a', 'b', 'c'])
    // Both input orders reach the same order, whichever way the sort compares them.
    expect(fuseSessionRankings([hit('b')], [hit('a')]).map(entry => entry.header.id)).toEqual(['a', 'b'])
    expect(fuseSessionRankings([hit('a')], [hit('b')]).map(entry => entry.header.id)).toEqual(['a', 'b'])
  })
})
