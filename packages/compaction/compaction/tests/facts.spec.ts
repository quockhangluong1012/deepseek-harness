import { describe, expect, it } from 'vitest'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { deriveCompactionCheckpoint } from '../src/facts.ts'

/** One log event with the payload a case needs. */
function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq: SessionSeq(seq), time: seq, type, data } as unknown as SessionEvent
}

/** The log a compaction would fold: a task, its plan, a policy decision, an approval, evidence, work, and a failure. */
const LOG: SessionEvent[] = [
  event(1, 'task/created', { taskId: 'task-1', objective: 'repair the reader' }),
  event(2, 'action/decided', { proposal: { actionId: 'a-1', toolName: 'write' }, policy: { effect: 'allow' } }),
  event(3, 'task/plan', { revision: 2, steps: ['reproduce', 'repair'] }),
  event(4, 'approval/asked', { id: 'approval-1' }),
  event(5, 'evidence/recorded', { evidenceId: 'e-1', contentRef: 'packages/fs/fs/src/index.ts' }),
  event(6, 'tool/call', { callId: 'c-1', name: 'read' }),
  event(7, 'tool/result', { callId: 'c-1' }),
  event(8, 'tool/call', { callId: 'c-2', name: 'write' }),
  event(9, 'failure/recorded', { failureId: 'f-1', kind: 'tool-transient', actionId: 'a-2' }),
]

describe('deriveCompactionCheckpoint', () => {
  it('records the facts, open work, dropped results, and summary digest of one compaction', () => {
    const checkpoint = deriveCompactionCheckpoint({
      checkpointId: 'compaction-1',
      shadowedSeqs: [6, 7],
      summaryText: 'The reader was repaired.',
      summarizer: { provider: 'deepseek', model: 'deepseek-chat' },
      events: LOG,
      droppedToolResultIds: ['c-1'],
    })

    expect(checkpoint).toMatchObject({
      checkpointId: 'compaction-1',
      sourceSeqRange: { start: 6, end: 7 },
      droppedToolResultIds: ['c-1'],
      summarizer: { provider: 'deepseek', model: 'deepseek-chat' },
    })
    expect(checkpoint.retainedFacts).toEqual([
      { id: 'task-1', kind: 'task', statement: 'repair the reader' },
      { id: 'a-1', kind: 'policy', statement: 'policy allow for write' },
      { id: 'plan-2', kind: 'plan', statement: 'plan revision 2: reproduce → repair' },
      { id: 'approval-1', kind: 'approval', statement: 'approval requested and not yet answered' },
      { id: 'e-1', kind: 'evidence', statement: 'packages/fs/fs/src/index.ts' },
    ])
    // c-1 was shadowed whole — its call and its dropped result — so the only
    // work the retained log leaves open is c-2.
    expect(checkpoint.openWork).toEqual([{ callId: 'c-2', toolName: 'write' }])
    expect(checkpoint.unresolvedFailures).toEqual([{ failureId: 'f-1', kind: 'tool-transient' }])
    expect(checkpoint.contextDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('drops a failure the log later resolved and keeps the digest stable for identical text', () => {
    const resolved = [...LOG, event(10, 'verification/result', { status: 'pass' })]
    const input = {
      checkpointId: 'compaction-2',
      shadowedSeqs: [],
      summaryText: 'same text',
      summarizer: { provider: 'p', model: 'm' },
      events: resolved,
      droppedToolResultIds: [],
    }

    const first = deriveCompactionCheckpoint(input)

    expect(first.unresolvedFailures).toEqual([])
    expect(first.sourceSeqRange).toEqual({ start: 0, end: 0 })
    expect(deriveCompactionCheckpoint(input).contextDigest).toBe(first.contextDigest)
    expect(deriveCompactionCheckpoint({ ...input, summaryText: 'other text' }).contextDigest)
      .not.toBe(first.contextDigest)
  })
})
