import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContextCompilationRecord } from '@deepseek-ai/dsh-agent-context'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { project, replayTrace } from '../src/index.ts'
import type { ReplayArtifact, TraceRecord } from '../src/index.ts'

const seq = (n: number): SessionSeq => SessionSeq(n)
const mid = (n: number): MessageId => brandString<MessageId>(`m${n}`)
const cid = (n: string): ToolCallId => ToolCallId(`c${n}`)

const BASELINE: ReplayArtifact = { id: 'release-notes', version: 'r1', body: 'roll back with dsh --revert' }
const CANDIDATE: ReplayArtifact = { id: 'release-notes', version: 'r2', body: 'roll back with dsh rollback' }

function turnStart(turn: number, s: number, time: number): SessionEvent {
  return { type: 'turn/start', seq: seq(s), time, data: { turn } }
}

function turnEnd(turn: number, s: number, time: number): SessionEvent {
  return { type: 'turn/end', seq: seq(s), time, data: { turn, reason: { kind: 'completed' } } }
}

function stepStart(turn: number, step: number, s: number, time: number): SessionEvent {
  return { type: 'step/start', seq: seq(s), time, data: { turn, step } }
}

function stepEnd(turn: number, step: number, s: number, time: number): SessionEvent {
  return { type: 'step/end', seq: seq(s), time, data: { turn, step } }
}

function compilation(digest: string): ContextCompilationRecord {
  return {
    digest,
    compilerVersion: 'c1',
    maxTokens: null,
    tokenEstimate: 10,
    included: [],
    omitted: [],
    conflicts: [],
  }
}

function contextCompiled(s: number, time: number, digest: string): SessionEvent {
  return { type: 'context/compiled', seq: seq(s), time, data: compilation(digest) }
}

function toolCall(turn: number, step: number, id: string, s: number, time: number, name: string, args = '{}'): SessionEvent {
  return { type: 'tool/call', seq: seq(s), time, data: { turn, step, callId: cid(id), name, arguments: args } }
}

function toolResult(turn: number, step: number, id: string, s: number, time: number, options: {
  isError?: boolean
  text?: string
} = {}): SessionEvent {
  const call = cid(id)
  return {
    type: 'tool/result',
    seq: seq(s),
    time,
    data: {
      turn,
      step,
      message: {
        id: mid(s),
        role: 'tool',
        content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
        toolCallId: call,
        ...(options.isError === true ? { isError: true } : {}),
        source: { kind: 'tool', callId: call },
      },
    },
    surfaceOp: 'append',
  }
}

/** A trace of one turn: step 0 retrieves the artifact, step 1 calls an unrelated tool. */
function retrievedTrace(): TraceRecord {
  return project('s1', [
    contextCompiled(0, 1000, 'd0'),
    turnStart(0, 1, 1001),
    stepStart(0, 0, 2, 1002),
    toolCall(0, 0, 's1', 3, 1003, 'skill', '{"name":"release-notes"}'),
    toolResult(0, 0, 's1', 4, 1004, { text: 'recorded r1 body' }),
    stepEnd(0, 0, 5, 1005),
    stepStart(0, 1, 6, 1006),
    toolCall(0, 1, 'r1', 7, 1007, 'read', '{"path":"notes.md"}'),
    toolResult(0, 1, 'r1', 8, 1008, { text: 'notes.md contents' }),
    stepEnd(0, 1, 9, 1009),
    turnEnd(0, 10, 1010),
  ], 500)
}

const request = (trace: TraceRecord, baseline = BASELINE, candidate = CANDIDATE) => {
  return replayTrace({ trace, baseline, candidate })
}

describe('counterfactual trace replay', () => {
  it('reports the artifact identity, both revisions, and one report per step in trace order', () => {
    const report = request(retrievedTrace())
    expect(report).toMatchObject({ sessionId: 's1', artifact: 'release-notes', baseline: 'r1', candidate: 'r2' })
    expect(report.steps.map(step => [step.turn, step.step])).toEqual([[0, 0], [0, 1]])
  })

  it('reconstructs each step from its recorded context digest, null when the log recorded none', () => {
    const trace = project('s1', [
      turnStart(0, 1, 1001),
      stepStart(0, 0, 2, 1002),
      stepEnd(0, 0, 3, 1003),
      turnEnd(0, 4, 1004),
    ], 500)
    expect(request(trace).steps.map(step => step.context)).toEqual([null])

    const withContext = request(retrievedTrace()).steps
    expect(withContext[0]?.context).toBe('d0')
    expect(withContext[1]?.context).toBe('d0')
  })

  it('restores each revision over the retrieval it names and compares the two per step', () => {
    const report = request(retrievedTrace())
    const retrieving = report.steps[0]
    expect(retrieving?.baseline).toEqual([
      { tool: 'skill', source: 'artifact', output: 'roll back with dsh --revert' },
    ])
    expect(retrieving?.candidate).toEqual([
      { tool: 'skill', source: 'artifact', output: 'roll back with dsh rollback' },
    ])
    expect(retrieving?.differs).toBe(true)
    expect(report.changedSteps).toEqual(['0.0'])
  })

  it('replays a step the artifact never reaches from its recorded snapshot, and names it', () => {
    const report = request(retrievedTrace())
    expect(report.steps[1]?.baseline).toEqual([
      { tool: 'read', source: 'snapshot', output: 'notes.md contents' },
    ])
    expect(report.steps[1]?.differs).toBe(false)
    expect(report.snapshotSteps).toEqual(['0.1'])
    expect(report.changedSteps).toEqual(['0.0'])
    expect(report.unreplayableSteps).toEqual([])
  })

  it('reports parity when both revisions restore the same body', () => {
    const same = { ...BASELINE, version: 'r3' }
    const report = request(retrievedTrace(), BASELINE, same)
    expect(report.steps[0]?.differs).toBe(false)
    expect(report.steps[0]?.baseline).toEqual([
      { tool: 'skill', source: 'artifact', output: 'roll back with dsh --revert' },
    ])
    expect(report.changedSteps).toEqual([])
    expect(report.snapshotSteps).toEqual(['0.1'])
  })

  it('reports a step unreplayable when a call recorded no output, never as unchanged', () => {
    const trace = project('s1', [
      turnStart(0, 1, 1001),
      stepStart(0, 0, 2, 1002),
      toolCall(0, 0, 's1', 3, 1003, 'skill', '{"name":"release-notes"}'),
      toolResult(0, 0, 's1', 4, 1004, {}),
      stepEnd(0, 0, 5, 1005),
      turnEnd(0, 6, 1006),
    ], 500)
    const report = request(trace)
    const step = report.steps[0]
    expect(step?.status).toBe('unreplayable')
    expect(step?.unreplayableTools).toEqual(['skill'])
    expect(step?.differs).toBe(false)
    // The artifact body never stands in for a call the log recorded no output
    // for: the restored revision would be a guess about what that run saw.
    expect(step?.baseline).toEqual([{ tool: 'skill', source: 'missing', output: null }])
    expect(step?.candidate).toEqual([{ tool: 'skill', source: 'missing', output: null }])
    expect(report.unreplayableSteps).toEqual(['0.0'])
    expect(report.changedSteps).toEqual([])
    expect(report.snapshotSteps).toEqual([])
  })

  it('reports only the calls that recorded no output as unreplayable tools', () => {
    const trace = project('s1', [
      turnStart(0, 1, 1001),
      stepStart(0, 0, 2, 1002),
      toolCall(0, 0, 'a', 3, 1003, 'read', '{"path":"a"}'),
      toolResult(0, 0, 'a', 4, 1004, {}),
      toolCall(0, 0, 'b', 5, 1005, 'bash', '{}'),
      toolResult(0, 0, 'b', 6, 1006, {}),
      stepEnd(0, 0, 7, 1007),
      turnEnd(0, 8, 1008),
    ], 500)
    expect(request(trace).steps[0]?.unreplayableTools).toEqual(['read', 'bash'])
  })

  it('leaves a retrieval of a different artifact on its recorded snapshot', () => {
    const trace = project('s1', [
      turnStart(0, 1, 1001),
      stepStart(0, 0, 2, 1002),
      toolCall(0, 0, 's1', 3, 1003, 'skill', '{"name":"other-skill"}'),
      toolResult(0, 0, 's1', 4, 1004, { text: 'other body' }),
      stepEnd(0, 0, 5, 1005),
      turnEnd(0, 6, 1006),
    ], 500)
    expect(request(trace).steps[0]?.baseline).toEqual([
      { tool: 'skill', source: 'snapshot', output: 'other body' },
    ])
    expect(request(trace).snapshotSteps).toEqual(['0.0'])
  })

  it('leaves a failed retrieval on its recorded snapshot: nothing was restored from it', () => {
    const trace = project('s1', [
      turnStart(0, 1, 1001),
      stepStart(0, 0, 2, 1002),
      toolCall(0, 0, 's1', 3, 1003, 'skill', '{"name":"release-notes"}'),
      toolResult(0, 0, 's1', 4, 1004, { isError: true, text: 'skill unavailable' }),
      stepEnd(0, 0, 5, 1005),
      turnEnd(0, 6, 1006),
    ], 500)
    const report = request(trace)
    expect(report.steps[0]?.baseline).toEqual([
      { tool: 'skill', source: 'snapshot', output: 'skill unavailable' },
    ])
    expect(report.changedSteps).toEqual([])
  })

  it('compares each revision over the retrieval the revision names, not the baseline id alone', () => {
    const renamed = { id: 'release-notes-v2', version: 'r2', body: 'roll back with dsh rollback' }
    const report = request(retrievedTrace(), BASELINE, renamed)
    expect(report.artifact).toBe('release-notes')
    expect(report.steps[0]?.candidate).toEqual([
      { tool: 'skill', source: 'snapshot', output: 'recorded r1 body' },
    ])
    expect(report.changedSteps).toEqual(['0.0'])
  })

  it('replays a trace with no turns into an empty comparison', () => {
    const report = request(project('s1', [], 500))
    expect(report).toMatchObject({ steps: [], changedSteps: [], unreplayableSteps: [], snapshotSteps: [] })
  })
})
