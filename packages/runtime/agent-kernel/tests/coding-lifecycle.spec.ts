/**
 * §10.5's coding lifecycle: the phases a coding task records, the edges it may
 * take, the repair return a failed check takes, the independent reviewer the
 * REVIEW phase spawns once, the ceilings a deployment configures, and the
 * classes that run no pipeline at all.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentKernelService, CodeReviewRequest, CodeReviewReport, IndependentReviewer } from '../src/index.ts'
import { assertPhaseTransition, canAdvancePhase, resolveCodingLifecycle } from '../src/index.ts'
import type { AcceptanceCriterion, CodingPhase, CriterionResult } from '../src/index.ts'
import { eventsOf, humanMessage, makeAgent, preStep, rig, stopTurn, transitions } from './rig.ts'

/** One required assertion criterion. */
function criterion(id: string): AcceptanceCriterion {
  return { id, description: `${id} holds`, verifier: 'assertion', required: true }
}

/** Register a verifier answering each attempt from `statuses`, the last one sticky. */
function registerScriptedVerifier(kernel: AgentKernelService, statuses: readonly CriterionResult['status'][]): void {
  let attempts = 0
  kernel.verifiers.register({
    id: 'scripted',
    supports: () => true,
    verify: async (_request, subject) => {
      const status = statuses[Math.min(attempts, statuses.length - 1)] ?? 'fail'
      attempts += 1
      return { result: { criterionId: subject.id, status, evidence: [] } }
    },
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

/**
 * Open a coding task on one agent. The acceptance list is always explicit, so a
 * spec states the criteria it verifies rather than inheriting a deployment's
 * per-class defaults.
 */
function openCodingTask(kernel: AgentKernelService, agent: Agent, acceptance: readonly AcceptanceCriterion[] = []): void {
  kernel.intake(agent, {
    objective: 'change the parser',
    agentProfile: 'default',
    taskClass: 'coding',
    acceptance: [...acceptance],
  })
}

/** The phases one agent recorded, in log order. */
function phases(agent: Agent): readonly CodingPhase[] {
  return eventsOf(agent, 'task/phase').map(record => record.phase)
}

/** An independent reviewer that records every request and answers `report`. */
function reviewerStub(report: CodeReviewReport, requests: CodeReviewRequest[]): IndependentReviewer {
  return {
    review: async (request) => {
      requests.push(request)
      return report
    },
  }
}

const CLEAN_REVIEW: CodeReviewReport = { summary: 'the change is correct', findings: [] }
const DEFECT_REVIEW: CodeReviewReport = {
  summary: 'the change leaks a handle',
  findings: [{ file: 'src/a.ts', line: '4', severity: 'high', message: 'the handle is never closed' }],
}

describe('coding lifecycle phases', () => {
  it('records the pipeline a coding task traverses and cites it on completion', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx)
    openCodingTask(kernel, agent)

    await preStep(ctx, agent, [humanMessage('change the parser')])
    await stopTurn(ctx, agent)

    // The deployment runs every phase, so reaching COMPLETE records every one;
    // REVIEW is skipped because the reviewer is switched off by default.
    expect(phases(agent)).toEqual([
      'understand', 'map', 'plan', 'contract', 'implement', 'local-verify', 'regression', 'complete',
    ])
    expect(eventsOf(agent, 'task/phase')[0]).toMatchObject({ phase: 'understand', taskClass: 'coding', ordinal: 1, trigger: 'lifecycle-started' })
    expect(eventsOf(agent, 'task/phase')[0]?.from).toBeUndefined()
    expect(eventsOf(agent, 'task/phase')[1]).toMatchObject({ phase: 'map', from: 'understand', trigger: 'phase-advanced' })
    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
    const completed = transitions(agent).at(-1)
    expect(completed?.to).toBe('completed')
    expect(completed?.preconditions.some(predicate => predicate.kind === 'lifecycle-phases' && predicate.satisfied)).toBe(true)
  })

  it('records the repair return a failed local verification takes', async () => {
    const { ctx, kernel } = await rig({ maxRepairAttempts: 2 })
    registerScriptedVerifier(kernel, ['fail'])
    const agent = await makeAgent(ctx)
    const steered = captureSteers(agent)
    openCodingTask(kernel, agent, [criterion('build')])

    await preStep(ctx, agent, [humanMessage('one')])
    await stopTurn(ctx, agent)

    // One failed check is one repair: the phase returns to IMPLEMENT and the
    // existing recovery path keeps the turn open.
    expect(phases(agent).at(-1)).toBe('implement')
    expect(eventsOf(agent, 'task/phase').at(-1)?.trigger).toBe('phase-repaired')
    expect(eventsOf(agent, 'failure/recorded').map(record => record.kind)).toEqual(['verification-failed'])
    expect(kernel.state.view(agent.session)?.task.status).toBe('recovering')
    expect(steered).toHaveLength(1)

    await preStep(ctx, agent, [humanMessage('two')], 2)
    await stopTurn(ctx, agent, 2)

    // The cap is where a loop would be: the decision reaches the user instead.
    expect(kernel.state.view(agent.session)?.task.status).toBe('awaiting-user')
    expect(steered).toHaveLength(1)
    expect(eventsOf(agent, 'failure/recorded')).toHaveLength(2)
  })

  it('parks a task whose repair phase reached its configured step ceiling', async () => {
    const { ctx, kernel } = await rig({
      maxRepairAttempts: 5,
      codingLifecycle: { budgets: { implement: 1 } },
    })
    registerScriptedVerifier(kernel, ['fail'])
    const agent = await makeAgent(ctx)
    const steered = captureSteers(agent)
    openCodingTask(kernel, agent, [criterion('build')])

    await preStep(ctx, agent, [humanMessage('one')])
    agent.session.append('step/start', { turn: 1, step: 1 })
    await stopTurn(ctx, agent)
    // The forward IMPLEMENT entry and the repair return that failed the check.
    expect(phases(agent).filter(phase => phase === 'implement')).toHaveLength(2)

    await preStep(ctx, agent, [humanMessage('two')], 2)
    agent.session.append('step/start', { turn: 2, step: 1 })
    await stopTurn(ctx, agent, 2)

    // The second repair would re-enter a phase that already spent its ceiling,
    // so the task asks the user instead of running IMPLEMENT again.
    expect(phases(agent).filter(phase => phase === 'implement')).toHaveLength(2)
    // Turn 1 failed its check once; turn 2 failed again, and its repair was
    // refused by the ceiling instead of running IMPLEMENT a third time.
    expect(eventsOf(agent, 'failure/recorded').map(record => record.kind))
      .toEqual(['verification-failed', 'verification-failed', 'budget-exhausted'])
    expect(kernel.state.view(agent.session)?.task.status).toBe('awaiting-user')
    expect(steered).toHaveLength(1)
  })

  it('skips the phases a deployment does not run', async () => {
    const { ctx, kernel } = await rig({
      codingLifecycle: { phases: ['understand', 'implement', 'local-verify', 'complete'] },
    })
    const agent = await makeAgent(ctx)
    openCodingTask(kernel, agent)

    await preStep(ctx, agent, [humanMessage('change the parser')])
    await stopTurn(ctx, agent)

    expect(phases(agent)).toEqual(['understand', 'implement', 'local-verify', 'complete'])
    expect(eventsOf(agent, 'task/review')).toHaveLength(0)
    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
  })

  it('completes a task with no declared class and records no phase', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx)

    await preStep(ctx, agent, [humanMessage('summarize the change')])
    await stopTurn(ctx, agent)

    expect(kernel.state.view(agent.session)?.task.taskClass).toBe('conversational')
    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
    expect(eventsOf(agent, 'task/phase')).toHaveLength(0)
    const completed = transitions(agent).at(-1)
    expect(completed?.preconditions.some(predicate =>
      predicate.kind === 'lifecycle-phases'
      && predicate.satisfied
      && predicate.detail === 'a conversational task runs no coding lifecycle',
    )).toBe(true)
  })
})

describe('coding lifecycle phase machine', () => {
  it('refuses an edge the phase machine does not have', () => {
    expect(canAdvancePhase('local-verify', 'implement')).toBe(true)
    expect(canAdvancePhase('regression', 'complete')).toBe(true)
    expect(canAdvancePhase('complete', 'implement')).toBe(false)
    expect(() => { assertPhaseTransition('complete', 'implement') }).toThrow('illegal coding-lifecycle transition complete -> implement')
  })

  it('refuses the repair return from a phase with no repair edge', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx)
    openCodingTask(kernel, agent)
    kernel.lifecycle.advance(agent.session, 'understand')

    expect(() => kernel.lifecycle.repair(agent.session, 'the check failed'))
      .toThrow('illegal coding-lifecycle transition understand -> implement')
  })

  it('validates a deployment phase list at load', () => {
    expect(resolveCodingLifecycle(undefined).phases).toEqual([
      'understand', 'map', 'plan', 'contract', 'implement', 'local-verify', 'review', 'regression', 'complete',
    ])
    expect(resolveCodingLifecycle({ phases: ['understand', 'implement', 'complete'] }).phases)
      .toEqual(['understand', 'implement', 'complete'])
    expect(() => resolveCodingLifecycle({ phases: ['implement', 'complete'] })).toThrow('starts at understand')
    expect(() => resolveCodingLifecycle({ phases: ['understand', 'local-verify'] })).toThrow('ends at complete')
    expect(() => resolveCodingLifecycle({ phases: ['understand', 'map', 'map', 'complete'] })).toThrow('names map twice')
    expect(() => resolveCodingLifecycle({ phases: ['understand', 'complete'], budgets: { review: 2 } }))
      .toThrow('does not run')
    expect(() => resolveCodingLifecycle({ budgets: { review: 2 } }))
      .toThrow('while the review is switched off')
    expect(() => resolveCodingLifecycle({ budgets: { map: 0 } })).toThrow('must be a positive integer')
    expect(() => resolveCodingLifecycle({ phases: ['understand', 'complete'], review: { enabled: true, ref: 'HEAD~1' } }))
      .toThrow('do not include review')
    expect(resolveCodingLifecycle({ budgets: { map: 2 }, review: { ref: 'origin/main' } }))
      .toMatchObject({ budgets: { map: 2 }, review: { enabled: false, ref: 'origin/main' } })
  })
})

describe('coding lifecycle independent review', () => {
  it('spawns the reviewer once per REVIEW entry and consumes its report', async () => {
    const requests: CodeReviewRequest[] = []
    const { ctx, kernel } = await rig({ codingLifecycle: { review: { enabled: true } } })
    kernel.lifecycle.registerReviewer(reviewerStub(CLEAN_REVIEW, requests))
    const agent = await makeAgent(ctx)
    openCodingTask(kernel, agent)

    await preStep(ctx, agent, [humanMessage('change the parser')])
    await stopTurn(ctx, agent)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.ref).toBe('')
    expect(requests[0]?.objective).toBe('change the parser')
    expect(eventsOf(agent, 'task/review')).toHaveLength(1)
    expect(eventsOf(agent, 'task/review')[0]?.report).toEqual(CLEAN_REVIEW)
    expect(phases(agent)).toEqual([
      'understand', 'map', 'plan', 'contract', 'implement', 'local-verify', 'review', 'regression', 'complete',
    ])
    expect(kernel.state.view(agent.session)?.task.status).toBe('completed')
  })

  it('answers a repeated review of the same entry from the log instead of spawning again', async () => {
    const requests: CodeReviewRequest[] = []
    const { ctx, kernel } = await rig({ codingLifecycle: { review: { enabled: true } } })
    kernel.lifecycle.registerReviewer(reviewerStub(DEFECT_REVIEW, requests))
    const agent = await makeAgent(ctx)
    openCodingTask(kernel, agent)
    kernel.lifecycle.advance(agent.session, 'review')

    const first = await kernel.lifecycle.review(agent, new AbortController().signal)
    const second = await kernel.lifecycle.review(agent, new AbortController().signal)

    expect(requests).toHaveLength(1)
    expect(first).toEqual(DEFECT_REVIEW)
    expect(second).toEqual(first)
    expect(eventsOf(agent, 'task/review')).toHaveLength(1)
  })

  it('routes review findings back into work instead of completing', async () => {
    const requests: CodeReviewRequest[] = []
    const { ctx, kernel } = await rig({
      maxRepairAttempts: 3,
      codingLifecycle: { review: { enabled: true, ref: 'origin/main' } },
    })
    registerScriptedVerifier(kernel, ['pass'])
    kernel.lifecycle.registerReviewer(reviewerStub(DEFECT_REVIEW, requests))
    const agent = await makeAgent(ctx)
    const steered = captureSteers(agent)
    openCodingTask(kernel, agent, [criterion('build')])

    await preStep(ctx, agent, [humanMessage('one')])
    await stopTurn(ctx, agent)

    expect(requests[0]?.ref).toBe('origin/main')
    expect(eventsOf(agent, 'task/review')[0]?.report.findings).toHaveLength(1)
    expect(phases(agent).at(-1)).toBe('implement')
    expect(eventsOf(agent, 'task/phase').at(-1)?.trigger).toBe('phase-repaired')
    expect(kernel.state.view(agent.session)?.task.status).toBe('recovering')
    expect(steered[0]).toContain('the handle is never closed')
  })

  it('asks the user rather than completing when the review is enabled without a reviewer', async () => {
    const { ctx, kernel } = await rig({ codingLifecycle: { review: { enabled: true } } })
    const agent = await makeAgent(ctx)
    openCodingTask(kernel, agent)

    await preStep(ctx, agent, [humanMessage('change the parser')])
    await stopTurn(ctx, agent)

    expect(eventsOf(agent, 'failure/recorded').map(record => record.kind)).toEqual(['workflow-failed'])
    expect(eventsOf(agent, 'failure/recorded')[0]?.detail).toContain('no independent reviewer is registered')
    expect(kernel.state.view(agent.session)?.task.status).toBe('awaiting-user')
    expect(phases(agent).at(-1)).toBe('review')
  })
})
