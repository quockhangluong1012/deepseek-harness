/**
 * The research tools write through the kernel's own knowledge API: what the
 * model records is what the session log holds, and a deployment without a
 * kernel is refused rather than silently dropping the record.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentKernel from '@deepseek-ai/dsh-agent-kernel'
import * as toolEvidence from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** One context with the loop, the kernel, and the research tools mounted. */
async function mounted(config: toolEvidence.Config = {}): Promise<{ ctx: Context; agent: Awaited<ReturnType<Awaited<ReturnType<typeof mountAgentLoopTestHarness>>['create']>> }> {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentKernel, {})
  await ctx.plugin(toolEvidence, config)
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('evidence-tools'), { provider: 'mock', model: 'mock' }, { cwd: process.cwd() })
  // A record needs a task to answer to, so the fixture opens one the same way a
  // caller does.
  ctx.agentKernel.intake(agent, { objective: 'record what the reader does', agentProfile: 'default' })
  return { ctx, agent }
}

/** Call one registered tool through the real registry pipeline. */
function call(ctx: Context, name: string, agent: unknown, args: Record<string, unknown>, callId: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    arguments: args,
    agent,
  } as never)
}

describe('research tools', () => {
  it('records evidence the session log holds, then the claim citing it', async () => {
    const { ctx, agent } = await mounted()

    const evidence = await call(ctx, 'record_evidence', agent, {
      kind: 'file', contentRef: 'packages/core/tools/src/index.ts', trust: 'trusted',
    }, 'call-evidence')
    expect(evidence.isError).toBe(false)

    const recorded = agent.session.snapshotEvents().filter(event => event.type === 'evidence/recorded')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.data).toMatchObject({
      kind: 'file',
      contentRef: 'packages/core/tools/src/index.ts',
      trust: 'trusted',
      sourceRef: { source: 'model', locator: 'call-evidence' },
    })

    const claim = await call(ctx, 'record_claim', agent, {
      statement: 'validation runs before the policy pipeline',
      evidenceIds: [String(recorded[0]?.data.evidenceId)],
      confidence: 0.8,
      status: 'supported',
    }, 'call-claim')
    expect(claim.isError).toBe(false)

    const claims = agent.session.snapshotEvents().filter(event => event.type === 'claim/updated')
    expect(claims).toHaveLength(1)
    expect(claims[0]?.data).toMatchObject({
      statement: 'validation runs before the policy pipeline',
      confidence: 0.8,
      status: 'supported',
    })
    expect(claims[0]?.data.evidence).toEqual([String(recorded[0]?.data.evidenceId)])
  })

  it('refuses to record without a kernel to own the record', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(toolEvidence, {})

    expect(ctx.tools.get('record_evidence')).toBeDefined()
    // No kernel is mounted, so `ctx.get('agentKernel')` is undefined and each
    // tool fails instead of writing a durable fact nobody owns.
    expect(ctx.get('agentKernel')).toBeUndefined()
    const calls = [
      ['record_evidence', { kind: 'file', contentRef: 'README.md' }],
      ['record_claim', { statement: 'unsupported', confidence: 0.5 }],
      ['record_hypothesis', { question: 'does anything hold?' }],
    ] as const
    for (const [toolName, args] of calls) {
      const result = await call(ctx, toolName, undefined, args, `call-${toolName}`)
      expect(result.isError).toBe(true)
    }
  })

  it('clamps a stated confidence into the interval the claim accepts', async () => {
    const { ctx, agent } = await mounted()
    await call(ctx, 'record_claim', agent, { statement: 'overconfident', confidence: 4 }, 'call-clamped')

    const claims = agent.session.snapshotEvents().filter(event => event.type === 'claim/updated')
    expect(claims[0]?.data.confidence).toBe(1)
  })

  it('records the question the task is testing, citing the claims behind it', async () => {
    const { ctx, agent } = await mounted()
    await call(ctx, 'record_claim', agent, { statement: 'the fold reproduces the log', confidence: 0.6 }, 'call-hypothesis-claim')
    const claimId = String(agent.session.snapshotEvents().find(event => event.type === 'claim/updated')?.data.claimId)

    const hypothesis = await call(ctx, 'record_hypothesis', agent, {
      question: 'does the digest survive a replay?',
      claimIds: [claimId],
      status: 'inconclusive',
    }, 'call-hypothesis')
    expect(hypothesis.isError).toBe(false)

    const hypotheses = agent.session.snapshotEvents().filter(event => event.type === 'hypothesis/updated')
    expect(hypotheses).toHaveLength(1)
    expect(hypotheses[0]?.data).toMatchObject({
      question: 'does the digest survive a replay?',
      claims: [claimId],
      status: 'inconclusive',
      tests: [],
    })
  })

  it('opens a hypothesis that cites no claim yet', async () => {
    const { ctx, agent } = await mounted()
    const hypothesis = await call(ctx, 'record_hypothesis', agent, { question: 'is the ledger replayable?' }, 'call-open-hypothesis')
    expect(hypothesis.isError).toBe(false)

    const hypotheses = agent.session.snapshotEvents().filter(event => event.type === 'hypothesis/updated')
    expect(hypotheses[0]?.data).toMatchObject({ question: 'is the ledger replayable?', claims: [], status: 'open' })
  })

  it('refuses a hypothesis citing a claim this session never asserted', async () => {
    const { ctx, agent } = await mounted()
    const hypothesis = await call(ctx, 'record_hypothesis', agent, {
      question: 'does an unknown claim hold?',
      claimIds: ['made-up-claim'],
    }, 'call-unknown-claim')
    expect(hypothesis.isError).toBe(true)

    expect(agent.session.snapshotEvents().filter(event => event.type === 'hypothesis/updated')).toHaveLength(0)
  })

  it('keeps a supplied digest and defaults an unstated trust label', async () => {
    const { ctx, agent } = await mounted()
    await call(ctx, 'record_evidence', agent, {
      kind: 'file', contentRef: 'README.md', digest: 'a'.repeat(64),
    }, 'call-digest')

    const recorded = agent.session.snapshotEvents().find(event => event.type === 'evidence/recorded')
    expect(recorded?.data).toMatchObject({ digest: 'a'.repeat(64), trust: 'unknown' })
  })

  it('bounds recorded text to the configured ceiling', async () => {
    const { ctx, agent } = await mounted({ maxTextChars: 8 })
    await call(ctx, 'record_hypothesis', agent, { question: 'longer than eight characters' }, 'call-bounded')

    const recorded = agent.session.snapshotEvents().find(event => event.type === 'hypothesis/updated')
    expect(recorded?.data.question).toBe('longer t')
  })
})
