/**
 * The §8.5 regression leg: after a repair's targeted verification, the criteria
 * an earlier verification of the task passed must still pass, and a repair that
 * breaks nothing re-runs no criterion it need not re-run.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceChangesSummary } from '@deepseek-ai/dsh-workspace-changes/types'
import { describe, expect, it } from 'vitest'
import type { AgentKernelService } from '../src/index.ts'
import { regressedCriteria, regressionDetail } from '../src/regression.ts'
import type { AcceptanceCriterion, CriterionResult, TaskId, VerificationResult } from '../src/types.ts'
import { eventsOf, humanMessage, makeAgent, preStep, rig, stopTurn } from './rig.ts'

/** One required criterion of the `assertion` family. */
function criterion(id: string): AcceptanceCriterion {
  return { id, description: `${id} holds`, verifier: 'assertion', required: true }
}

/** One verification result over the given per-criterion statuses. */
function verification(task: string, results: readonly (readonly [string, CriterionResult['status']])[]): VerificationResult {
  return {
    taskId: brandString<TaskId>(task),
    revision: 1,
    status: results.every(([, status]) => status === 'pass') ? 'pass' : 'fail',
    criterionResults: results.map(([criterionId, status]) => ({ criterionId, status, evidence: [] })),
    commands: [],
    verifierVersion: 'test',
  }
}

/** One attempt's outcome per criterion id. */
type Attempt = Readonly<Record<string, CriterionResult['status']>>

/**
 * Register a verifier that answers each criterion from the attempt script, one
 * attempt per criterion, and count how often each criterion was verified.
 * @param kernel - the mounted kernel whose registry takes the verifier.
 * @param script - the per-attempt outcomes, indexed by how many times that criterion was verified.
 * @returns every criterion's verification count.
 */
function registerScriptedVerifier(kernel: AgentKernelService, script: readonly Attempt[]): Map<string, number> {
  const invoked = new Map<string, number>()
  const attempts = new Map<string, number>()
  kernel.verifiers.register({
    id: 'scripted',
    supports: () => true,
    verify: async (_request, subject) => {
      invoked.set(subject.id, (invoked.get(subject.id) ?? 0) + 1)
      const attempt = attempts.get(subject.id) ?? 0
      attempts.set(subject.id, attempt + 1)
      const status = script[attempt]?.[subject.id] ?? 'fail'
      return { result: { criterionId: subject.id, status, evidence: [], detail: `${subject.id} ${status}` } }
    },
  })
  return invoked
}

/**
 * Provide the workspace-changes summaries this suite's turns announce, so the
 * kernel reads a changed scope and a repository digest from them.
 * @param ctx - the rig's context.
 * @returns the summary table, keyed by the seq of the event announcing each one.
 */
function provideChanges(ctx: Context): Map<number, WorkspaceChangesSummary> {
  const summaries = new Map<number, WorkspaceChangesSummary>()
  ctx.provide('workspaceChanges', {
    summary: (_sessionId, seq) => summaries.get(seq),
    diff: () => Promise.resolve(undefined),
    applyHunks: () => Promise.resolve(undefined),
    restore: () => Promise.resolve(undefined),
  })
  return summaries
}

/**
 * Record one turn's changed file and its own repository state: a repair edits
 * the file, so the next verification reads a different digest than the last.
 * @param agent - the agent whose session announces the change.
 * @param summaries - the summary table the provided service reads.
 * @param turn - the turn that changed it.
 */
function recordChanges(agent: Agent, summaries: Map<number, WorkspaceChangesSummary>, turn: number): void {
  const event = agent.session.append('workspace/changes', { turn })
  summaries.set(event.seq, {
    turn,
    cwd: '/repo',
    total: 1,
    added: 1,
    deleted: 0,
    files: [{ path: 'src/a.ts', display: 'src/a.ts', added: 1, deleted: 0 }],
    snapshot: { before: `tree-before-${String(turn)}`, after: `tree-after-${String(turn)}` },
  })
}

/** Capture every steering message the kernel sends. */
function captureSteers(agent: Agent): string[] {
  const steered: string[] = []
  agent.steer = (message) => {
    steered.push(message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  }
  return steered
}

describe('the regression comparison', () => {
  it('names the criteria a later verification stopped passing', () => {
    const regressed = regressedCriteria(
      verification('task-1', [['a', 'pass'], ['b', 'fail']]),
      verification('task-1', [['a', 'fail'], ['b', 'pass']]),
    )
    expect(regressed.map(result => result.criterionId)).toEqual(['a'])
    expect(regressionDetail(regressed)).toBe('regression: a passed before this repair and no longer pass')
  })

  it('treats a criterion that already failed as no regression', () => {
    expect(regressedCriteria(
      verification('task-1', [['a', 'fail'], ['b', 'pass']]),
      verification('task-1', [['a', 'fail'], ['b', 'fail']]),
    ).map(result => result.criterionId)).toEqual(['b'])
  })

  it('has no baseline to regress from on a first verification, or against another task', () => {
    const current = verification('task-1', [['a', 'fail']])
    expect(regressedCriteria(undefined, current)).toEqual([])
    expect(regressedCriteria(verification('task-0', [['a', 'pass']]), current)).toEqual([])
    expect(regressedCriteria(verification('task-1', [['a', 'pass']]), current)).toHaveLength(1)
    expect(regressionDetail([])).toBeUndefined()
  })
})

describe('the regression leg in the repair loop', () => {
  it('catches a repair that broke a criterion an earlier verification passed', async () => {
    const { ctx, kernel } = await rig({
      acceptance: [criterion('build-check'), criterion('lint-check')],
      maxRepairAttempts: 3,
    })
    const summaries = provideChanges(ctx)
    const invoked = registerScriptedVerifier(kernel, [
      { 'build-check': 'pass', 'lint-check': 'fail' },
      { 'build-check': 'fail', 'lint-check': 'pass' },
    ])
    const agent = await makeAgent(ctx)
    const steered = captureSteers(agent)

    await preStep(ctx, agent, [humanMessage('one')])
    recordChanges(agent, summaries, 1)
    await stopTurn(ctx, agent)
    expect(kernel.state.view(agent.session)?.task.status).toBe('recovering')

    await preStep(ctx, agent, [humanMessage('two')], 2)
    recordChanges(agent, summaries, 2)
    await stopTurn(ctx, agent, 2)

    // The repair made its own target pass and broke what already passed: the
    // task is still recovering, and the failure says which criterion regressed.
    expect(kernel.state.view(agent.session)?.task.status).toBe('recovering')
    expect(eventsOf(agent, 'failure/recorded').map(event => event.kind))
      .toEqual(['verification-failed', 'verification-regressed'])
    expect(eventsOf(agent, 'failure/recorded').at(-1)?.detail).toContain('regression: build-check passed before this repair and no longer pass')
    expect(steered).toHaveLength(2)
    expect(steered[1]).toContain('regression: build-check passed before this repair and no longer pass')
    // One verification per criterion per turn: build-check was verified on both
    // turns, and the pass that caught its regression stopped there — the gate
    // runs no criterion after the first failed required one — so the criterion
    // ordered after it was verified only on the first turn.
    expect(invoked.get('build-check')).toBe(2)
    expect(invoked.get('lint-check')).toBe(1)
  })

  it('completes a repair that broke nothing, verifying no criterion twice for one turn', async () => {
    const { ctx, kernel } = await rig({
      acceptance: [criterion('build-check'), criterion('lint-check')],
      maxRepairAttempts: 2,
    })
    const summaries = provideChanges(ctx)
    const invoked = registerScriptedVerifier(kernel, [
      { 'build-check': 'pass', 'lint-check': 'fail' },
      { 'build-check': 'pass', 'lint-check': 'pass' },
    ])
    const agent = await makeAgent(ctx)
    const steered = captureSteers(agent)

    await preStep(ctx, agent, [humanMessage('one')])
    recordChanges(agent, summaries, 1)
    await stopTurn(ctx, agent)
    expect(kernel.state.view(agent.session)?.task.status).toBe('recovering')

    await preStep(ctx, agent, [humanMessage('two')], 2)
    recordChanges(agent, summaries, 2)
    await stopTurn(ctx, agent, 2)

    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
    expect(eventsOf(agent, 'failure/recorded').map(event => event.kind)).toEqual(['verification-failed'])
    expect(steered).toHaveLength(1)
    // One verification per turn: a regression leg that re-ran the criterion the
    // repair left passing would have verified it a third time.
    expect(invoked.get('build-check')).toBe(2)
    expect(invoked.get('lint-check')).toBe(2)
  })

  it('counts a regressed repair against the same repair budget', async () => {
    const { ctx, kernel } = await rig({
      acceptance: [criterion('build-check'), criterion('lint-check')],
      maxRepairAttempts: 2,
    })
    const summaries = provideChanges(ctx)
    registerScriptedVerifier(kernel, [
      { 'build-check': 'pass', 'lint-check': 'fail' },
      { 'build-check': 'fail', 'lint-check': 'pass' },
    ])
    const agent = await makeAgent(ctx)
    captureSteers(agent)

    await preStep(ctx, agent, [humanMessage('one')])
    recordChanges(agent, summaries, 1)
    await stopTurn(ctx, agent)
    expect(kernel.state.view(agent.session)?.task.status).toBe('recovering')

    await preStep(ctx, agent, [humanMessage('two')], 2)
    recordChanges(agent, summaries, 2)
    await stopTurn(ctx, agent, 2)

    // One attempt was allowed, so the regression is the last one: the decision
    // goes to the user instead of steering another repair.
    expect(kernel.state.view(agent.session)?.task.status).toBe('awaiting-user')
  })
})
