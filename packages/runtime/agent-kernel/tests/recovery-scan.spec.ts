/**
 * The §17.2 boot-time recovery scanner over persisted sessions: a
 * non-terminal task with no open turn is resumable, one with an
 * unterminated turn is repairable, and a terminal task needs no recovery
 * decision at all.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { CheckpointId, FailureId, RunId, TaskContract, TaskId } from '../src/types.ts'
import { AgentKernelService } from '../src/index.ts'
import { scanForRecovery } from '../src/recovery-scan.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** A durable task contract with only status varied. */
function contract(status: TaskContract['status']): TaskContract {
  return {
    taskId: brandString<TaskId>('task-1'),
    runId: brandString<RunId>('run-1'),
    objective: 'repair the failing reader',
    constraints: [],
    acceptance: [],
    agentProfile: 'worker',
    policyProfile: 'default',
    budget: {},
    status,
    revision: 1,
  }
}

/** Mount a fresh JSONL persistence backend over a temp directory. */
async function mountedPersistence(): Promise<Context> {
  const root = await mkdtemp(join(tmpdir(), 'recovery-scan-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  return ctx
}

/** Write one session's fixture log and flush it durably. */
async function writeSession(ctx: Context, id: SessionId, events: readonly SessionEvent[]): Promise<void> {
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false }
  const handle = await ctx.sessionPersistence.create(header)
  await handle.append(events.map((event, index) => ({ ...event, seq: SessionSeq(index) })))
  await handle.flush()
  await handle.close()
}

describe('scanForRecovery', () => {
  it('classifies a non-terminal task with a closed tail as resumable', async () => {
    const ctx = await mountedPersistence()
    const id = SessionId('clean-session')
    await writeSession(ctx, id, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'task/created', seq: SessionSeq(1), time: 2, data: contract('executing') },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'stop' } } },
    ])

    const entries = await scanForRecovery(ctx.sessionPersistence)

    expect(entries).toEqual([{
      sessionId: id,
      classification: 'resumable',
      status: 'executing',
      reason: "status 'executing' with no open turn",
    }])
  })

  it('classifies a non-terminal task with an unterminated turn as repairable', async () => {
    const ctx = await mountedPersistence()
    const id = SessionId('crashed-session')
    await writeSession(ctx, id, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'task/created', seq: SessionSeq(1), time: 2, data: contract('executing') },
      // The process died mid-turn: no matching turn/end.
    ])

    const entries = await scanForRecovery(ctx.sessionPersistence)

    expect(entries).toEqual([{
      sessionId: id,
      classification: 'repairable',
      status: 'executing',
      reason: "status 'executing' with an unterminated turn",
    }])
  })

  it('excludes a task that already reached a terminal status', async () => {
    const ctx = await mountedPersistence()
    await writeSession(ctx, SessionId('done-session'), [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'task/created', seq: SessionSeq(1), time: 2, data: contract('completed') },
      // No turn/end either — but a terminal status excludes it regardless.
    ])

    expect(await scanForRecovery(ctx.sessionPersistence)).toEqual([])
  })

  it('excludes a session that recorded no task at all', async () => {
    const ctx = await mountedPersistence()
    await writeSession(ctx, SessionId('bare-session'), [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'stop' } } },
    ])

    expect(await scanForRecovery(ctx.sessionPersistence)).toEqual([])
  })

  it('scans every stored session independently', async () => {
    const ctx = await mountedPersistence()
    await writeSession(ctx, SessionId('a-resumable'), [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'task/created', seq: SessionSeq(1), time: 2, data: contract('paused') },
      { type: 'turn/end', seq: SessionSeq(2), time: 3, data: { turn: 1, reason: { kind: 'stop' } } },
    ])
    await writeSession(ctx, SessionId('b-repairable'), [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'task/created', seq: SessionSeq(1), time: 2, data: contract('awaiting-user') },
    ])

    const entries = await scanForRecovery(ctx.sessionPersistence)

    expect(entries.map(entry => [entry.sessionId, entry.classification]).sort()).toEqual([
      ['a-resumable', 'resumable'],
      ['b-repairable', 'repairable'],
    ])
  })
})

describe('checkpoint-aware recovery scan', () => {
  it('classifies a retry as repairable until its required checkpoint is recorded', async () => {
    const ctx = await mountedPersistence()
    const task = contract('executing')
    const retryEvents = (id: SessionId, checkpointed: boolean): SessionEvent[] => [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'task/created', seq: SessionSeq(1), time: 2, data: task },
      {
        type: 'failure/recorded', seq: SessionSeq(2), time: 3,
        data: { failureId: brandString<FailureId>('failure-1'), kind: 'timeout', detail: 'request stalled', at: 3 },
      },
      {
        type: 'recovery/decided', seq: SessionSeq(3), time: 4,
        data: {
          failureId: brandString<FailureId>('failure-1'), action: 'retry', retryable: true,
          attemptsRemaining: 1, checkpointRequired: true, reason: 'checkpoint before retry', at: 4,
        },
      },
      ...(checkpointed ? [{
        type: 'checkpoint/created' as const, seq: SessionSeq(4), time: 5,
        data: {
          checkpointId: brandString<CheckpointId>('checkpoint-1'), taskId: task.taskId, runId: task.runId,
          agentSessionId: id, sessionSeq: SessionLogOffset(4), status: 'executing' as const, revision: 1,
          budgets: { steps: 1, toolCalls: 0, tokens: 0, wallMs: 4, remaining: {} },
          openActionIds: [], unresolvedFailures: [], reason: 'before-pause' as const, createdAt: 5,
        },
      }] : []),
      {
        type: 'turn/end', seq: SessionSeq(checkpointed ? 5 : 4), time: checkpointed ? 6 : 5,
        data: { turn: 1, reason: { kind: 'stop' } },
      },
    ]
    const pendingId = SessionId('checkpoint-pending')
    const checkpointedId = SessionId('checkpoint-recorded')
    await writeSession(ctx, pendingId, retryEvents(pendingId, false))
    await writeSession(ctx, checkpointedId, retryEvents(checkpointedId, true))

    const entries = await scanForRecovery(ctx.sessionPersistence)

    expect(entries.map(entry => [entry.sessionId, entry.classification, entry.reason])).toEqual([
      [pendingId, 'repairable', "status 'executing' with a retry awaiting checkpoint"],
      [checkpointedId, 'resumable', "status 'executing' with no open turn"],
    ])
  })
})

describe('agent-kernel startup recovery scan', () => {
  it('classifies persisted sessions as soon as the kernel boots', async () => {
    const ctx = await mountedPersistence()
    const id = SessionId('boot-session')
    await writeSession(ctx, id, [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'task/created', seq: SessionSeq(1), time: 2, data: contract('executing') },
    ])

    await ctx.plugin(AgentKernelService, {})

    await expect(ctx.agentKernel.startupRecovery).resolves.toEqual([{
      sessionId: id,
      classification: 'repairable',
      status: 'executing',
      reason: "status 'executing' with an unterminated turn",
    }])
  })
})
