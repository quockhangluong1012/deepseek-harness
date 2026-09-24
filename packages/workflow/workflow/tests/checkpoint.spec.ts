/**
 * Workflow checkpointing: a run captures what a resume needs, and the engine
 * refuses to resume a run that has not stopped.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import WorkflowEngine, {
  WorkflowError,
  type WorkflowCheckpointRef,
  type WorkflowMeta,
  type WorkflowResumeRequest,
  type WorkflowRun,
  type WorkflowRunId,
  type WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'

const META: WorkflowMeta = { name: 'checkpoint-probe', description: 'records what it was asked to run' }

/** An engine that records the requests it is asked to start and settles them on demand. */
class RecordingEngine extends WorkflowEngine {
  readonly requests: WorkflowStartRequest[] = []

  start(request: WorkflowStartRequest): WorkflowRun {
    this.requests.push(request)
    const id = `run-${String(this.requests.length)}` as WorkflowRunId
    return {
      id,
      meta: request.meta,
      status: 'completed',
      result: Promise.resolve({ value: null, stopReason: 'completed', agentsStarted: 0 }),
      checkpoint: () => Promise.resolve({
        checkpointId: `checkpoint-${id}`,
        runId: id,
        status: 'completed',
        createdAt: 1,
        script: request.script,
        meta: request.meta,
        ...request.args === undefined ? {} : { args: request.args },
      }),
      cancel: () => {},
      dispose: () => Promise.resolve(),
    }
  }
}

/** Options for {@link engine}: a mounted engine over its own context. */
async function engine(): Promise<RecordingEngine> {
  const ctx = new Context()
  return new RecordingEngine(ctx)
}

/** A parent agent stand-in: the engine only reads identity off it. */
const parent = { id: 'parent-agent', session: { id: 'parent-session' } } as unknown as Agent

/** A checkpoint of a stopped run over the given inputs. */
function stoppedCheckpoint(overrides: Partial<WorkflowCheckpointRef> = {}): WorkflowCheckpointRef {
  return {
    checkpointId: 'checkpoint-1',
    runId: 'checkpointed-run' as WorkflowRunId,
    status: 'cancelled',
    createdAt: 1,
    script: 'return args.round + 1',
    meta: META,
    args: { round: 2 },
    ...overrides,
  }
}

describe('workflow run checkpoints', () => {
  it('captures the script, inputs, and status a resume needs', async () => {
    const instance = await engine()
    const run = instance.start({ script: 'return 1', meta: META, args: { round: 1 }, parent, maxTotalAgents: 3 })

    const checkpoint = await run.checkpoint()

    expect(checkpoint).toMatchObject({
      runId: run.id,
      status: run.status,
      script: 'return 1',
      meta: META,
      args: { round: 1 },
    })
    expect(typeof checkpoint.checkpointId).toBe('string')
    expect(checkpoint.createdAt).toBeGreaterThan(0)
  })
})

describe('workflow resume', () => {
  it('starts the checkpointed script again over its recorded inputs', async () => {
    const instance = await engine()

    const resumed = instance.resume({ checkpoint: stoppedCheckpoint(), parent })

    expect(resumed.id).not.toBe('checkpointed-run')
    expect(instance.requests).toEqual([
      { script: 'return args.round + 1', meta: META, args: { round: 2 }, parent },
    ])
  })

  it('refuses a checkpoint whose run is still live', async () => {
    const instance = await engine()

    expect(() => instance.resume({ checkpoint: stoppedCheckpoint({ status: 'running' }), parent }))
      .toThrow(WorkflowError)
    expect(instance.requests).toEqual([])
    try {
      instance.resume({ checkpoint: stoppedCheckpoint({ status: 'running' }), parent })
    } catch (error) {
      expect((error as WorkflowError).code).toBe('CHECKPOINT_LIVE')
      expect((error as Error).message).toContain('still live')
    }
  })

  it('carries the child-provider override and ceiling a checkpoint recorded', async () => {
    const instance = await engine()
    const request: WorkflowResumeRequest = {
      checkpoint: stoppedCheckpoint({ subagentProvider: 'probe', maxTotalAgents: 4, args: undefined }),
      parent,
    }

    instance.resume(request)

    expect(instance.requests[0]).toMatchObject({ subagentProvider: 'probe', maxTotalAgents: 4 })
    expect(instance.requests[0]).not.toHaveProperty('args')
  })
})
