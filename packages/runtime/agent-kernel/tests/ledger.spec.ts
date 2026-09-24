/**
 * The offline ledger reader: folding a persisted kernel log reproduces the
 * state the live kernel holds for the same events.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { EvidenceInput } from '../src/types.ts'
import { readKernelRecord } from '../src/ledger.ts'
import {
  callTool,
  eventsOf,
  humanMessage,
  makeAgent,
  preStep,
  registerTool,
  rig,
} from './rig.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount a rig and remember it for teardown. */
async function mounted(config: Parameters<typeof rig>[0] = {}): Promise<Awaited<ReturnType<typeof rig>>> {
  const result = await rig(config)
  contexts.push(result.ctx)
  return result
}

/** The evidence one fixture records. */
const EVIDENCE: EvidenceInput = {
  kind: 'test',
  contentRef: 'packages/runtime/agent-kernel/tests/ledger.spec.ts',
  digest: 'digest-of-the-reader-spec',
  provenance: { source: 'tool', locator: 'probe' },
  trust: 'trusted',
}

/** One agent whose log holds a task contract and a recorded evidence item. */
async function agentWithTask(ctx: Awaited<ReturnType<typeof rig>>['ctx']): Promise<Agent> {
  const agent = await makeAgent(ctx)
  registerTool(ctx, 'probe')
  await preStep(ctx, agent, [humanMessage('read the file')])
  ctx.agentKernel.recordEvidence(agent, EVIDENCE)
  return agent
}

describe('readKernelRecord', () => {
  it('reports no task for a log without a contract', async () => {
    const { ctx } = await mounted()
    const agent = await makeAgent(ctx)

    expect(readKernelRecord(agent.session.snapshotEvents())).toBeUndefined()
  })

  it('folds the same task state the live kernel holds', async () => {
    const { ctx } = await mounted()
    const agent = await agentWithTask(ctx)

    const record = readKernelRecord(agent.session.snapshotEvents())
    const live = await ctx.agentKernel.snapshot(agent)
    expect(live).toBeDefined()
    expect(record?.task).toEqual(live?.task)
    expect(record?.evidence).toEqual(live?.evidence)
    expect(record?.claims).toEqual(live?.claims)
    expect(record?.hypotheses).toEqual(live?.hypotheses)
    expect(record?.openActionIds).toEqual(live?.openActionIds)
    expect(record?.unresolvedFailures).toEqual(live?.unresolvedFailures)
    expect(record?.evidence[0]).toMatchObject({ kind: 'test', trust: 'trusted', digest: EVIDENCE.digest })
  })

  it('counts the steps and tool calls the log records', async () => {
    const { ctx } = await mounted()
    const agent = await agentWithTask(ctx)
    await callTool(ctx, 'probe', agent)

    const record = readKernelRecord(agent.session.snapshotEvents())

    expect(record?.steps).toBe(eventsOf(agent, 'step/start').length)
    expect(record?.toolCalls).toBe(eventsOf(agent, 'tool/call').length)
    expect(record?.wallMs).toBeGreaterThanOrEqual(0)
  })

  it('follows later records, so the reader sees the newest plan revision', async () => {
    const { ctx } = await mounted()
    const agent = await agentWithTask(ctx)
    expect(readKernelRecord(agent.session.snapshotEvents())?.plan).toBeUndefined()

    ctx.agentKernel.recordPlan(agent, ['reproduce the failure', 'repair', 'verify'])
    const after = readKernelRecord(agent.session.snapshotEvents())

    expect(after?.plan?.steps).toEqual(['reproduce the failure', 'repair', 'verify'])
    // The first plan is a producer of `planning`; the next admitted step leaves it.
    expect(after?.task.status).toBe('planning')
  })
})

describe('spend-based budgets', () => {
  /** Append one settled turn whose single attempt was billed `total` tokens. */
  function appendBilledTurn(agent: Agent, turn: number, total: number): void {
    const usage = { inputTokens: total - 20, outputTokens: 20, totalTokens: total }
    agent.session.append('turn/start', { turn })
    agent.session.append('step/start', { turn, step: 1 })
    agent.session.append('assistant/message', {
      turn,
      step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage } }],
      message: {
        id: `message-${String(turn)}`,
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      usage,
    } as never, { surfaceOp: 'append' })
    agent.session.append('step/end', { turn, step: 1 })
    agent.session.append('turn/end', { turn, reason: { kind: 'completed' } } as never)
  }

  it('reports measured spend against the token ceiling instead of an unbounded allowance', async () => {
    const { ctx } = await mounted({ budgets: { maxTokens: 1_000 } })
    const agent = await agentWithTask(ctx)
    appendBilledTurn(agent, 1, 300)
    appendBilledTurn(agent, 2, 500)

    const snapshot = ctx.agentKernel.state.view(agent.session)?.budgets

    expect(snapshot?.tokens).toBe(800)
    expect(snapshot?.remaining.maxTokens).toBe(200)
  })

  it('leaves the ceiling alone while no attempt has settled', async () => {
    const { ctx } = await mounted({ budgets: { maxTokens: 1_000 } })
    const agent = await agentWithTask(ctx)
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('step/start', { turn: 1, step: 1 })

    const snapshot = ctx.agentKernel.state.view(agent.session)?.budgets

    expect(snapshot?.tokens).toBe(0)
    expect(snapshot?.remaining.maxTokens).toBe(1_000)
  })
})
