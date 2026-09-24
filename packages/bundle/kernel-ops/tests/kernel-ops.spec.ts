/**
 * The kernel command line over a real stored session: each command folds the
 * persisted log and prints what it records, and the exit code reports the
 * finding rather than the command's fortune.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import { brandString } from '@deepseek-ai/dsh-brand'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { SessionId, SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import EvolutionLineage from '@deepseek-ai/dsh-evolution-lineage'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { apply } from '../src/index.ts'
import { internals } from '../src/internals.ts'

const TASK_ID = brandString<TaskId>('task-1')
const RUN_ID = brandString<RunId>('run-1')
const ACTION_ID = brandString<ActionId>('call-1')
const CALL_ID = brandString<ToolCallId>('call-1')
const SESSION_ID = SessionId('kernel-ops-fixture')

/** The task contract the fixture log opens with. */
const AUTHORIZATION: AuthorizationDecision = {
  effect: 'allow',
  decisionId: brandString<PolicyDecisionId>('decision-1'),
  capabilityGrants: ['fs.read'],
  sandbox: { mode: 'workspace-write', workspaceRoot: 'C:\\ws' },
  enforced: true,
  reasons: ['rule 2 allows fs.read under workspace/**'],
}

const CONTRACT: TaskContract = {
  taskId: TASK_ID,
  runId: RUN_ID,
  objective: 'repair the failing reader',
  constraints: [],
  acceptance: [{ id: 'crit-1', description: 'the reader spec passes', verifier: 'test', required: true }],
  agentProfile: 'worker',
  policyProfile: 'default',
  budget: { maxSteps: 4 },
  status: 'executing',
  revision: 2,
}

/** The proposal the fixture log records for one tool call. */
const PROPOSAL = {
  actionId: ACTION_ID,
  agentId: SESSION_ID,
  callId: CALL_ID,
  toolName: 'read',
  arguments: { file_path: 'ledger.ts' },
  source: 'model',
  taskRevision: 2,
  trust: 'untrusted',
} as const

const POLICY: PolicyDecision = {
  decisionId: brandString<PolicyDecisionId>('decision-1'),
  actionId: PROPOSAL.actionId,
  effect: 'allow',
  matchedRuleIndex: 2,
  capabilities: [{ capability: 'fs.read', resource: 'workspace/**' }],
  reasons: ['rule 2 allows fs.read under workspace/**'],
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/**
 * The stored fixture log, in sequence order. Written as literals so the
 * compiler checks every payload against the event map.
 * @returns the events.
 */
function fixtureLog(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1_000, data: { turn: 1 } },
    { type: 'task/created', seq: SessionSeq(1), time: 1_001, data: CONTRACT },
    { type: 'task/plan', seq: SessionSeq(2), time: 1_002, data: { revision: 1, steps: ['reproduce', 'repair'], createdAt: 1_002 } },
    { type: 'step/start', seq: SessionSeq(3), time: 1_003, data: { turn: 1, step: 1 } },
    { type: 'action/decided', seq: SessionSeq(4), time: 1_004, data: { proposal: PROPOSAL, policy: POLICY, decision: AUTHORIZATION } },
    {
      type: 'failure/recorded',
      seq: SessionSeq(5),
      time: 1005,
      data: {
        failureId: brandString<FailureId>('failure-1'),
        kind: 'tool-transient',
        detail: 'the reader threw while folding',
        at: 1_006,
      },
    },
    {
      type: 'verification/result',
      seq: SessionSeq(6),
      time: 1006,
      data: {
        taskId: TASK_ID,
        revision: 2,
        status: 'pass',
        criterionResults: [{ criterionId: 'crit-1', status: 'pass', evidence: ['digest-1'] }],
        commands: ['pnpm exec vitest run packages/runtime/agent-kernel/tests/ledger.spec.ts'],
        verifierVersion: 'kernel-1',
      },
    },
    {
      type: 'checkpoint/created',
      seq: SessionSeq(7),
      time: 1007,
      data: {
        checkpointId: brandString<CheckpointId>('checkpoint-1'),
        taskId: TASK_ID,
        runId: RUN_ID,
        agentSessionId: SESSION_ID,
        sessionSeq: SessionLogOffset(0),
        status: 'executing',
        revision: 2,
        budgets: { steps: 1, toolCalls: 0, tokens: 0, wallMs: 8, remaining: { maxSteps: 3 } },
        openActionIds: [],
        unresolvedFailures: [],
        reason: 'turn-boundary',
        createdAt: 1_008,
      },
    },
  ]
}

/** Run one invocation against a stored log. */
async function invoke(
  argv: string[],
  log: readonly SessionEvent[] = fixtureLog(),
): Promise<{ stdout: string, stderr: string, code: number }> {
  const root = await mkdtemp(join(tmpdir(), 'kernel-ops-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SESSION_ID, createdAt: 1, isSeeded: false }
  const handle = await ctx.sessionPersistence.create(header)
  // A filtered fixture keeps a legal log: storage requires contiguous seq from 0.
  await handle.append(log.map((entry, index) => ({ ...entry, seq: SessionSeq(index) })))
  await handle.flush()
  await handle.close()
  await ctx.plugin(AgentKernel, {})

  let stdout = ''
  let stderr = ''
  let code = -1
  const write = internals.write
  const writeError = internals.writeError
  internals.write = text => { stdout += text }
  internals.writeError = text => { stderr += text }
  try {
    provideCmdline(ctx, { args: argv, exit: value => { code = value } })
    apply(ctx)
    // A command action settles on its own promise chain; the exit request is
    // what says the command finished.
    const idle = Promise.withResolvers<void>()
    const timer = setInterval(() => { if (code !== -1) idle.resolve() }, 5)
    const timeout = setTimeout(() => { idle.resolve() }, 2_000)
    try {
      await idle.promise
    } finally {
      clearInterval(timer)
      clearTimeout(timeout)
    }
  } finally {
    internals.write = write
    internals.writeError = writeError
  }
  return { stdout, stderr, code }
}

describe('dsh task show', () => {
  it('prints the folded record and its counts', async () => {
    const { stdout, code } = await invoke(['task', 'show', SESSION_ID])

    expect(code).toBe(0)
    expect(stdout).toContain('objective: repair the failing reader')
    expect(stdout).toContain('status: executing')
    expect(stdout).toContain('steps: 1')
    expect(stdout).toContain('toolCalls: 0')
    expect(stdout).toContain('planSteps: 2')
    expect(stdout).toContain('unresolvedFailures: tool-transient')
    expect(stdout).toContain('checkpoint: checkpoint-1')
  })

  it('prints JSON on request', async () => {
    const { stdout, code } = await invoke(['task', 'show', SESSION_ID, '--json'])

    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as { task: { objective: string }, steps: number }
    expect(parsed.task.objective).toBe('repair the failing reader')
    expect(parsed.steps).toBe(1)
  })

  it('fails when the session holds no kernel record', async () => {
    const { stderr, code } = await invoke(['task', 'show', SESSION_ID], fixtureLog().filter(entry => entry.type !== 'task/created'))

    expect(code).toBe(1)
    expect(stderr).toContain('holds no task record')
  })
})

describe('dsh task recover-scan', () => {
  it('reports the fixture session as repairable when its tail leaves an open turn', async () => {
    const { stdout, code } = await invoke(['task', 'recover-scan'])

    expect(code).toBe(1)
    expect(stdout).toContain(`${SESSION_ID}: repairable`)
    expect(stdout).toContain('unterminated turn')
  })

  it('reports resumable and exits clean when the tail closes its turn', async () => {
    const log = [
      ...fixtureLog().filter(entry => entry.type !== 'action/decided'),
      { type: 'step/end' as const, seq: SessionSeq(8), time: 1008, data: { turn: 1, step: 1 } },
      { type: 'turn/end' as const, seq: SessionSeq(9), time: 1009, data: { turn: 1, reason: { kind: 'stop' as const } } },
    ]
    const { stdout, code } = await invoke(['task', 'recover-scan'], log)

    expect(code).toBe(0)
    expect(stdout).toContain(`${SESSION_ID}: resumable`)
  })
  it('keeps a closed turn repairable while a durable action has no outcome', async () => {
    const log = [
      ...fixtureLog(),
      { type: 'step/end' as const, seq: SessionSeq(8), time: 1008, data: { turn: 1, step: 1 } },
      { type: 'turn/end' as const, seq: SessionSeq(9), time: 1009, data: { turn: 1, reason: { kind: 'stop' as const } } },
    ]
    const { stdout, code } = await invoke(['task', 'recover-scan'], log)

    expect(code).toBe(1)
    expect(stdout).toContain(`${SESSION_ID}: repairable`)
    expect(stdout).toContain('open action')
  })

  it('reports nothing to recover once the task reaches a terminal status', async () => {
    const log = fixtureLog().map(event => event.type === 'task/created' ? { ...event, data: { ...CONTRACT, status: 'completed' as const } } : event)
    const { stdout, code } = await invoke(['task', 'recover-scan'], log)

    expect(code).toBe(0)
    expect(stdout).toContain('nothing to recover')
  })
})

describe('dsh task metrics', () => {
  it('prints the counters the fixture log implies', async () => {
    const { stdout, code } = await invoke(['task', 'metrics', SESSION_ID])

    expect(code).toBe(0)
    expect(stdout).toContain('tasksCreated: 1')
    expect(stdout).toContain('verifications: 1 (1 passed)')
    expect(stdout).toContain('actions: proposed=1 succeeded=0 failed=0 denied=0')
    expect(stdout).toContain('failures: tool-transient=1')
    expect(stdout).toContain('checkpoints: 1 (resumed 0)')
  })

  it('prints JSON on request', async () => {
    const { stdout, code } = await invoke(['task', 'metrics', SESSION_ID, '--json'])

    expect(code).toBe(0)
    const parsed = JSON.parse(stdout) as { tasksCreated: number, steps: number, verificationPassRate: number }
    expect(parsed.tasksCreated).toBe(1)
    expect(parsed.steps).toBe(1)
    expect(parsed.verificationPassRate).toBe(1)
  })

  it('reports zeroes for a session with no kernel activity', async () => {
    const { stdout, code } = await invoke(['task', 'metrics', SESSION_ID], fixtureLog().filter(entry => entry.type === 'turn/start'))

    expect(code).toBe(0)
    expect(stdout).toContain('tasksCreated: 0')
    // A rate with no denominator is absent, never zero.
    expect(stdout).not.toContain('taskSuccessRate')
  })
})

describe('dsh task verify', () => {
  it('reports the recorded outcome and blocks the gate on an unresolved failure', async () => {
    const { stdout, code } = await invoke(['task', 'verify', SESSION_ID])

    expect(code).toBe(1)
    expect(stdout).toContain('verification: pass')
    expect(stdout).toContain('criterion crit-1: pass')
    expect(stdout).toContain('unresolvedFailures: tool-transient')
    expect(stdout).toContain('gate: blocked')
  })

  it('passes the gate once nothing is unresolved', async () => {
    const { stdout, code } = await invoke(['task', 'verify', SESSION_ID], fixtureLog().filter(entry => entry.type !== 'failure/recorded'))

    expect(code).toBe(0)
    expect(stdout).toContain('gate: pass')
  })

  it('reports a session that never verified', async () => {
    const { stdout, code } = await invoke(['task', 'verify', SESSION_ID], fixtureLog().filter(entry => entry.type !== 'verification/result'))

    expect(code).toBe(1)
    expect(stdout).toContain('verification: never run')
    expect(stdout).toContain('criteria: 1 declared')
  })
})

describe('dsh task checkpoint', () => {
  it('prints the newest checkpoint', async () => {
    const { stdout, code } = await invoke(['task', 'checkpoint', SESSION_ID])

    expect(code).toBe(0)
    expect(stdout).toContain('checkpoint: checkpoint-1')
    expect(stdout).toContain('reason: turn-boundary')
    expect(stdout).toContain('sessionSeq: 0')
  })

  it('reports a session with no checkpoint', async () => {
    const { stdout, code } = await invoke(['task', 'checkpoint', SESSION_ID], fixtureLog().filter(entry => entry.type !== 'checkpoint/created'))

    expect(code).toBe(1)
    expect(stdout).toContain('recorded no checkpoint')
  })
})

describe('dsh policy explain', () => {
  it('prints the proposal, its decision, and the reasons', async () => {
    const { stdout, code } = await invoke(['policy', 'explain', SESSION_ID, 'call-1'])

    expect(code).toBe(0)
    expect(stdout).toContain('tool: read')
    expect(stdout).toContain('trust: untrusted')
    expect(stdout).toContain('effect: allow')
    expect(stdout).toContain('capabilities: fs.read')
    expect(stdout).toContain('sandboxMode: workspace-write')
    expect(stdout).toContain('reason: rule 2 allows fs.read under workspace/**')
  })

  it('fails when the log holds no such action', async () => {
    const { stderr, code } = await invoke(['policy', 'explain', SESSION_ID, 'call-9'])

    expect(code).toBe(1)
    expect(stderr).toContain('no action "call-9"')
  })
})

describe('kernel-ops command line', () => {
  it('rejects an unknown command through the launcher exit', async () => {
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const { code } = await invoke(['task', 'summarize', SESSION_ID])
      expect(code).toBe(1)
    } finally {
      errors.mockRestore()
    }
  })
})

describe('dsh evolution replay', () => {
  it('prints a recorded experiment envelope by id', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(EvolutionLineage, {})
    await ctx.evolutionLineage.record({
      experimentId: 'exp-1',
      skill: 'writer',
      candidate: 'v2',
      operator: 'rewrite',
      tasks: ['s1'],
      metrics: { pass: true, tokens: 3, wallTimeMs: 5 },
      outcome: 'improved',
      regressions: [],
      dependencies: { skill: 'sha-abc', model: 'deepseek-chat' },
      seeds: [1, 2, 3],
    })

    let stdout = ''
    const write = internals.write
    internals.write = text => { stdout += text }
    let code = -1
    try {
      provideCmdline(ctx, { args: ['evolution', 'replay', 'exp-1'], exit: value => { code = value } })
      apply(ctx)
      const idle = Promise.withResolvers<void>()
      const timer = setInterval(() => { if (code !== -1) idle.resolve() }, 5)
      const timeout = setTimeout(() => { idle.resolve() }, 2_000)
      try {
        await idle.promise
      } finally {
        clearInterval(timer)
        clearTimeout(timeout)
      }
    } finally {
      internals.write = write
    }

    expect(code).toBe(0)
    expect(stdout).toContain('exp-1')
    expect(stdout).toContain('writer')
    expect(stdout).toContain('improved')
    expect(stdout).toContain('rewrite')
    expect(stdout).toContain('seeds: 1, 2, 3')
  })

  it('reports an unknown experiment id', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(new MemoryMediaPool()))
    const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    await ctx.plugin(EvolutionLineage, {})

    let code = -1
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      provideCmdline(ctx, { args: ['evolution', 'replay', 'nope'], exit: value => { code = value } })
      apply(ctx)
      const idle = Promise.withResolvers<void>()
      const timer = setInterval(() => { if (code !== -1) idle.resolve() }, 5)
      const timeout = setTimeout(() => { idle.resolve() }, 2_000)
      try {
        await idle.promise
      } finally {
        clearInterval(timer)
        clearTimeout(timeout)
      }
    } finally {
      errors.mockRestore()
    }
    expect(code).toBe(1)
  })

  it('reports when no lineage store is mounted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kernel-ops-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })

    let code = -1
    const errors = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      provideCmdline(ctx, { args: ['evolution', 'replay', 'exp-1'], exit: value => { code = value } })
      apply(ctx)
      const idle = Promise.withResolvers<void>()
      const timer = setInterval(() => { if (code !== -1) idle.resolve() }, 5)
      const timeout = setTimeout(() => { idle.resolve() }, 2_000)
      try {
        await idle.promise
      } finally {
        clearInterval(timer)
        clearTimeout(timeout)
      }
    } finally {
      errors.mockRestore()
    }
    expect(code).toBe(1)
  })
})
