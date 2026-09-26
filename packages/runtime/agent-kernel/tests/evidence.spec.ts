import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { KernelLedger } from '../src/ledger.ts'
import type { EvidenceId, TaskId } from '../src/types.ts'
import { currentTask, eventsOf, humanMessage, makeAgent, preStep, rig } from './rig.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Mount a rig with a task already open, and remember it for teardown. */
async function opened(config: Parameters<typeof rig>[0] = {}) {
  const mounted = await rig(config)
  contexts.push(mounted.ctx)
  const agent = await makeAgent(mounted.ctx)
  await preStep(mounted.ctx, agent, [humanMessage('diagnose the failure')])
  return { ...mounted, agent }
}

describe('evidence records', () => {
  it('records one observation with its digest and source reference', async () => {
    const { kernel, agent } = await opened()

    const evidence = kernel.recordEvidence(agent, {
      kind: 'tool-result',
      contentRef: 'call-7',
      digest: 'a'.repeat(64),
      sourceRef: { source: 'tool', locator: 'call-7' },
      trust: 'untrusted',
    })

    expect(evidence).toMatchObject({
      kind: 'tool-result',
      contentRef: 'call-7',
      digest: 'a'.repeat(64),
      trust: 'untrusted',
      sourceRef: { source: 'tool', locator: 'call-7' },
    })
    expect(eventsOf(agent, 'evidence/recorded')[0]).toMatchObject({
      evidenceId: evidence.evidenceId,
      metadata: { actor: 'model', taskId: currentTask(agent).taskId, sourceRef: { source: 'tool' } },
    })
    expect(kernel.state.view(agent.session)?.evidence).toEqual([evidence])
  })

  it('refuses an observation that names no content', async () => {
    const { kernel, agent } = await opened()

    expect(() => kernel.recordEvidence(agent, {
      kind: 'file',
      contentRef: '   ',
      sourceRef: { source: 'repo' },
      trust: 'untrusted',
    })).toThrow('must name where its content lives')
  })

  it('records a claim only against observations this session recorded', async () => {
    const { kernel, agent } = await opened()
    const evidence = kernel.recordEvidence(agent, {
      kind: 'test',
      contentRef: 'vitest run evidence.spec.ts',
      sourceRef: { source: 'tool', locator: 'call-9' },
      trust: 'trusted',
    })

    const claim = kernel.recordClaim(agent, {
      statement: 'the fold reproduces the log',
      evidence: [evidence.evidenceId],
      confidence: 0.8,
      status: 'supported',
    })

    expect(claim).toMatchObject({ status: 'supported', confidence: 0.8, evidence: [evidence.evidenceId] })
    expect(kernel.state.view(agent.session)?.claims).toEqual([claim])

    expect(() => kernel.recordClaim(agent, {
      statement: 'unsupported by anything recorded',
      evidence: ['made-up-evidence' as EvidenceId],
      confidence: 0.5,
    })).toThrow('this session never recorded')
  })

  it('refuses a supported claim with no evidence and a confidence outside the unit interval', async () => {
    const { kernel, agent } = await opened()

    expect(() => kernel.recordClaim(agent, { statement: 'asserted', confidence: 0.9, status: 'supported' }))
      .toThrow('must cite at least one observation')
    expect(() => kernel.recordClaim(agent, { statement: 'asserted', confidence: 1.5 }))
      .toThrow('outside [0, 1]')
    expect(() => kernel.recordClaim(agent, { statement: '  ', confidence: 0.5 }))
      .toThrow('needs a statement')
    expect(eventsOf(agent, 'claim/updated')).toHaveLength(0)
  })

  it('records a hypothesis over recorded claims and this task s verifications', async () => {
    const { kernel, agent } = await opened()
    const claim = kernel.recordClaim(agent, { statement: 'the digest is stable', confidence: 0.6 })
    const task = currentTask(agent)

    const hypothesis = kernel.recordHypothesis(agent, {
      question: 'does the digest survive a replay?',
      claims: [claim.claimId],
      tests: [{ taskId: task.taskId, revision: task.revision, criteria: [], changedScopes: [], repositoryDigest: 'digest-1' }],
      status: 'inconclusive',
    })

    expect(hypothesis).toMatchObject({
      question: 'does the digest survive a replay?',
      claims: [claim.claimId],
      status: 'inconclusive',
    })
    expect(kernel.state.view(agent.session)?.hypotheses).toEqual([hypothesis])

    expect(() => kernel.recordHypothesis(agent, {
      question: 'does an unknown claim hold?',
      claims: ['made-up-claim' as never],
    })).toThrow('this session never asserted')
    expect(() => kernel.recordHypothesis(agent, {
      question: 'does another task s revision hold?',
      tests: [{ taskId: 'other-task' as TaskId, revision: 1, criteria: [], changedScopes: [], repositoryDigest: 'digest-1' }],
    })).toThrow('not "')
  })

  it('rebuilds evidence, claims, and hypotheses from the log alone', async () => {
    const { kernel, agent } = await opened()
    const evidence = kernel.recordEvidence(agent, {
      kind: 'web',
      contentRef: 'https://example.invalid/spec',
      sourceRef: { source: 'web', locator: 'https://example.invalid/spec' },
      trust: 'untrusted',
    })
    const claim = kernel.recordClaim(agent, {
      statement: 'the specification requires an evidence ledger',
      evidence: [evidence.evidenceId],
      confidence: 0.7,
    })
    const hypothesis = kernel.recordHypothesis(agent, { question: 'is the ledger replayable?', claims: [claim.claimId] })

    // A fresh reader over the same log — what a replay starts from — rebuilds
    // every record without the live service having handed them over.
    const replayed = new KernelLedger().view(agent.session)

    expect(replayed?.evidence).toEqual([evidence])
    expect(replayed?.claims).toEqual([claim])
    expect(replayed?.hypotheses).toEqual([hypothesis])
  })
})
