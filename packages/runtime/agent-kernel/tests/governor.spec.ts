/**
 * Governor specs: the progress, loop, and liveness functions, the per-session
 * state they read, and the decisions the kernel records at a step boundary.
 *
 * @module @deepseek-ai/dsh-agent-kernel/tests/governor.spec
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Context } from '@deepseek-ai/cordis'
import { GoalId, type GoalSnapshotChangeMeta } from '@deepseek-ai/dsh-goal'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyTimeout,
  composeGovernorDecision,
  countersOf,
  EXPECTS_PROGRESS,
  isStopDecision,
  livenessCheckMs,
  oscillationRun,
  progressScoreOf,
  RECENT_CALL_WINDOW,
  repeatedFailureKind,
  resolveGovernorThresholds,
  semanticDuplicateRun,
  SessionGovernor,
  similarityOf,
  stepDeltaOf,
  type GovernorFacts,
  type GovernorThresholds,
  type ObservedCall,
  type StepCounters,
  type StepInput,
} from '../src/governor.ts'
import type { AgentKernelService } from '../src/index.ts'
import type { CapabilityDeclaration, FailureId, FailureRef, GovernorDecision, RecoveryDecision, TaskStatus } from '../src/types.ts'
import { callTool, eventsOf, humanMessage, makeAgent, preStep, registerTool, rig, stopTurn } from './rig.ts'

/** The thresholds a default deployment runs under. */
const THRESHOLDS = resolveGovernorThresholds({})

/** A permission document allowing every declared action. */
const ALLOW_ALL = { defaults: { effect: 'allow' as const }, rules: [] }

/** The facts a task measured nothing at. */
const NOTHING: StepCounters = {
  toolCalls: 0,
  revisions: 0,
  observations: 0,
  goals: 0,
  failures: 0,
  planRevision: 0,
}

/** Distinguishes the agents this spec registers by hand. */
let sequence = 0

/**
 * One observed call.
 * @param tool - tool name.
 * @param arguments_ - canonical argument text.
 * @param digest - result digest.
 * @param seq - call position.
 * @returns the call.
 */
function callOf(tool: string, arguments_: string, digest = 'digest', seq = 1): ObservedCall {
  return { tool, signature: `${tool}:${arguments_}`, arguments: arguments_, digest, seq }
}

/**
 * One failure reference.
 * @param kind - failure kind.
 * @param id - failure identity.
 * @returns the reference.
 */
function failureOf(kind: FailureRef['kind'], id = 'f1'): FailureRef {
  return { failureId: brandString<FailureId>(id), kind }
}

/**
 * One decided recovery.
 * @param failure - failure it answers.
 * @param action - decided action.
 * @param attemptsRemaining - attempts left after the decision.
 * @returns the decision.
 */
function recoveryOf(
  failure: FailureRef,
  action: RecoveryDecision['action'],
  attemptsRemaining = 0,
): ReadonlyMap<FailureId, RecoveryDecision> {
  return new Map([[failure.failureId, {
    failureId: failure.failureId,
    action,
    retryable: attemptsRemaining > 0,
    attemptsRemaining,
    checkpointRequired: false,
    reason: 'spec',
    at: 1,
  }]])
}

/**
 * One step boundary, with the facts a spec is not exercising left unremarkable.
 * @param facts - the facts to override.
 * @returns the boundary input.
 */
function stepOf(facts: Partial<StepInput> = {}): StepInput {
  return {
    turn: 1,
    step: 1,
    counters: NOTHING,
    status: 'executing',
    remaining: {},
    failures: [],
    recoveries: new Map(),
    tokens: 0,
    delegationAllowed: true,
    at: 100,
    ...facts,
  }
}

/**
 * The decision facts a spec is not exercising, left unremarkable.
 * @param facts - the facts to override.
 * @returns the facts.
 */
function factsOf(facts: Partial<GovernorFacts> = {}): GovernorFacts {
  return {
    status: 'executing',
    remaining: {},
    progressScore: 1,
    repetition: 0,
    oscillation: 0,
    semanticDuplicates: 0,
    stagnantSteps: 0,
    narrationSteps: 0,
    tokens: 0,
    delegationAllowed: true,
    ...facts,
  }
}

/**
 * The decision one composition reached.
 * @param facts - the facts to compose.
 * @param thresholds - the thresholds; the defaults apply.
 * @returns the decision.
 */
function decided(facts: Partial<GovernorFacts>, thresholds: GovernorThresholds = THRESHOLDS): string {
  return composeGovernorDecision(factsOf(facts), thresholds).decision
}

/**
 * Register one fixture tool that stays open until the spec releases it, and
 * declare the capability its call needs.
 * @param ctx - the owning context.
 * @param kernel - the mounted kernel that records the declaration.
 * @returns the release handle.
 */
function registerBlockingTool(ctx: Context, kernel: AgentKernelService): { readonly release: () => void } {
  const gate = Promise.withResolvers<undefined>()
  kernel.capabilities.register({
    tool: 'blocking',
    capabilities: ['process.exec'],
    resources: () => 'workspace/a.ts',
  } satisfies CapabilityDeclaration)
  registerTool(ctx, 'blocking', async () => {
    await gate.promise
    return [{ type: 'text', text: 'done' }]
  })
  return { release: () => { gate.resolve(undefined) } }
}

/**
 * Declare the capability one fixture tool's calls need, so `mode: 'enforce'`
 * evaluates a call instead of refusing it for being undeclared.
 * @param ctx - the owning context.
 * @param tool - the registered tool name.
 */
function declareTool(ctx: Context, tool: string): void {
  ctx.agentKernel.capabilities.register({
    tool,
    capabilities: ['fs.read'],
    resources: () => 'workspace/a.ts',
  } satisfies CapabilityDeclaration)
}

/**
 * Append the `tool/call` record the loop writes for an admitted call. The rig
 * drives the registry pipeline, so a spec that needs the budget observation to
 * count a call appends the record itself.
 * @param agent - the agent whose session owns the call.
 * @param name - the called tool.
 */
function recordToolCall(agent: Agent, name: string): void {
  agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(`call-${name}`), name, arguments: '{}' })
}

/**
 * Enter one agent whose removal the spec owns, so a tracked session can
 * disappear between two liveness checks.
 * @param ctx - the owning context.
 * @returns the agent and its removal handle.
 */
function enterAgent(ctx: Context): { readonly agent: Agent; readonly detach: () => void } {
  sequence += 1
  const id = SessionId(`settled-${String(sequence)}`)
  const session = ctx.sessions.create(id)
  const agent: Agent = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: ctx.plugin(() => {}).ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent, detach: ctx.agents.enter(agent, undefined) }
}

describe('governor thresholds', () => {
  it('defaults every threshold', () => {
    expect(THRESHOLDS).toEqual({
      oscillationRun: 4,
      semanticDuplicateRun: 3,
      semanticSimilarity: 0.8,
      stagnantStepRun: 3,
      narrationStepRun: 3,
      failureRun: 3,
      contextPressureRatio: 0.8,
      livenessWindowMs: 180_000,
    })
  })

  it('takes configured thresholds', () => {
    expect(resolveGovernorThresholds({
      loopOscillationRun: 6,
      loopSemanticDuplicateRun: 5,
      loopSemanticSimilarity: 0.5,
      loopStagnantStepRun: 4,
      loopNarrationStepRun: 2,
      loopFailureRun: 7,
      contextPressureRatio: 1,
      livenessWindowMs: 1_000,
    })).toEqual({
      oscillationRun: 6,
      semanticDuplicateRun: 5,
      semanticSimilarity: 0.5,
      stagnantStepRun: 4,
      narrationStepRun: 2,
      failureRun: 7,
      contextPressureRatio: 1,
      livenessWindowMs: 1_000,
    })
  })

  it('refuses thresholds that cannot mean what they say', () => {
    expect(() => resolveGovernorThresholds({ loopOscillationRun: 1 })).toThrow(/loopOscillationRun/)
    expect(() => resolveGovernorThresholds({ loopSemanticDuplicateRun: 2.5 })).toThrow(/loopSemanticDuplicateRun/)
    expect(() => resolveGovernorThresholds({ loopSemanticSimilarity: 0 })).toThrow(/loopSemanticSimilarity/)
    expect(() => resolveGovernorThresholds({ loopSemanticSimilarity: 1.5 })).toThrow(/loopSemanticSimilarity/)
    expect(() => resolveGovernorThresholds({ loopStagnantStepRun: 0 })).toThrow(/loopStagnantStepRun/)
    expect(() => resolveGovernorThresholds({ loopNarrationStepRun: 1 })).toThrow(/loopNarrationStepRun/)
    expect(() => resolveGovernorThresholds({ loopFailureRun: -3 })).toThrow(/loopFailureRun/)
    expect(() => resolveGovernorThresholds({ contextPressureRatio: 0 })).toThrow(/contextPressureRatio/)
    expect(() => resolveGovernorThresholds({ livenessWindowMs: 0 })).toThrow(/livenessWindowMs/)
    expect(() => resolveGovernorThresholds({ livenessWindowMs: 1.5 })).toThrow(/livenessWindowMs/)
  })

  it('checks liveness at a quarter of the window, never below a millisecond', () => {
    expect(livenessCheckMs(180_000)).toBe(45_000)
    expect(livenessCheckMs(2)).toBe(1)
  })

  it('reads the progress expectation of every task status', () => {
    const expected: readonly TaskStatus[] = ['intake', 'planning', 'ready', 'executing', 'observing', 'verifying', 'recovering']
    for (const status of expected) expect(EXPECTS_PROGRESS[status]).toBe(true)
    for (const status of ['awaiting-approval', 'awaiting-user', 'paused', 'completed', 'failed', 'cancelled'] as const) {
      expect(EXPECTS_PROGRESS[status]).toBe(false)
    }
  })
})

describe('step delta', () => {
  it('measures no movement from identical counters', () => {
    const delta = stepDeltaOf(NOTHING, NOTHING, [], new Set())
    expect(delta).toEqual({
      toolNovelty: 0,
      stateDelta: 0,
      evidenceGain: 0,
      goalProgress: 0,
      errorReduction: 0,
      planProgress: 0,
    })
    expect(progressScoreOf(delta)).toBe(0)
  })

  it('measures the share of calls the history had not seen', () => {
    const first = callOf('read', '{"path":"a"}', 'digest', 1)
    const second = callOf('read', '{"path":"b"}', 'digest', 2)
    expect(stepDeltaOf(NOTHING, NOTHING, [first, first], new Set([first.signature])).toolNovelty).toBe(0)
    expect(stepDeltaOf(NOTHING, NOTHING, [first, second], new Set(['other:{}'])).toolNovelty).toBe(1)
    expect(stepDeltaOf(NOTHING, NOTHING, [first, second], new Set([first.signature, second.signature])).toolNovelty).toBe(0)
    expect(stepDeltaOf(NOTHING, NOTHING, [first, second], new Set([second.signature])).toolNovelty).toBe(0.5)
  })

  it('measures movement on every counter axis', () => {
    const previous: StepCounters = { toolCalls: 1, revisions: 2, observations: 3, goals: 4, failures: 5, planRevision: 6 }
    const current: StepCounters = { toolCalls: 2, revisions: 3, observations: 4, goals: 5, failures: 4, planRevision: 7 }
    const delta = stepDeltaOf(previous, current, [], new Set())
    expect(delta).toEqual({
      toolNovelty: 0,
      stateDelta: 1,
      evidenceGain: 1,
      goalProgress: 1,
      errorReduction: 1,
      planProgress: 1,
    })
    expect(progressScoreOf(delta)).toBeCloseTo(5 / 6)
  })

  it('reads the counts a folded session holds', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx)
    // A session with no task yet holds no counts at all.
    expect(countersOf(kernel.state.entryOf(agent.session))).toEqual(NOTHING)
    await preStep(ctx, agent, [humanMessage('count the work')])
    agent.session.append('step/start', { turn: 1, step: 1 })
    registerTool(ctx, 'read')
    await callTool(ctx, 'read', agent)
    // The loop appends `tool/call` after an admitted step; the rig drives the
    // registry pipeline alone.
    agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('call-1'), name: 'read', arguments: '{}' })
    kernel.recordEvidence(agent, { kind: 'file', contentRef: 'spec', sourceRef: { source: 'repo' }, trust: 'trusted' })
    kernel.recordPlan(agent, ['read the spec'])
    const goal: GoalSnapshotChangeMeta = {
      kind: 'goal/change',
      version: 1,
      operation: 'create',
      goal: {
        id: GoalId('goal-1'),
        revision: 1,
        objective: 'count the work',
        phase: 'active',
        maxGoalRounds: 4,
      },
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 2,
    }
    agent.session.append('goal/change', goal)

    expect(countersOf(kernel.state.entryOf(agent.session))).toEqual({
      toolCalls: 1,
      // intake, ready, executing, and the plan's own `planning` transition.
      revisions: 4,
      observations: 1,
      goals: 1,
      failures: 0,
      planRevision: 1,
    })
  })
})

describe('loop detectors', () => {
  it('reads the trailing alternating run', () => {
    expect(oscillationRun([])).toBe(0)
    expect(oscillationRun(['a'])).toBe(1)
    expect(oscillationRun(['a', 'a'])).toBe(1)
    expect(oscillationRun(['a', 'b'])).toBe(2)
    expect(oscillationRun(['a', 'b', 'c'])).toBe(2)
    expect(oscillationRun(['a', 'b', 'a', 'b'])).toBe(4)
    expect(oscillationRun(['a', 'b', 'a', 'b', 'a'])).toBe(5)
    expect(oscillationRun(['a', 'b', 'a', 'a', 'b', 'a', 'b'])).toBe(4)
  })

  it('compares arguments by token overlap', () => {
    expect(similarityOf('{"path":"a/b"}', '{"path":"a/b"}')).toBe(1)
    expect(similarityOf('{}', '{}')).toBe(1)
    expect(similarityOf('{"path":"a/b"}', '{"host":"example"}')).toBe(0)
    expect(similarityOf('{"path":"a/b","mode":"read"}', '{"PATH":"a/b","mode":"write"}')).toBeCloseTo(2 / 3)
    expect(similarityOf('{"path":"a/b"}', '{"path":"a/b","mode":"read"}')).toBeCloseTo(3 / 5)
  })

  it('reads the trailing run of near-duplicate calls', () => {
    expect(semanticDuplicateRun([], 0.8)).toBe(0)
    expect(semanticDuplicateRun([callOf('read', '{"path":"a"}')], 0.8)).toBe(0)
    expect(semanticDuplicateRun([callOf('read', '{"path":"a"}'), callOf('read', '{"path":"a"}')], 0.8)).toBe(0)
    expect(semanticDuplicateRun([
      callOf('read', '{"path":"a","mode":"read"}'),
      callOf('read', '{"path":"a","mode":"writing"}'),
    ], 0.5)).toBe(1)
    expect(semanticDuplicateRun([
      callOf('read', '{"path":"a","mode":"read"}'),
      callOf('read', '{"path":"a","mode":"writing"}'),
      callOf('read', '{"path":"a","mode":"writing!"}'),
    ], 0.5)).toBe(2)
    expect(semanticDuplicateRun([
      callOf('read', '{"path":"a"}'),
      callOf('write', '{"path":"a"}'),
    ], 0.5)).toBe(0)
    expect(semanticDuplicateRun([
      callOf('read', '{"path":"a"}'),
      callOf('read', '{"host":"b"}'),
    ], 0.8)).toBe(0)
  })

  it('reads the most repeated unresolved failure kind', () => {
    expect(repeatedFailureKind([])).toBeUndefined()
    expect(repeatedFailureKind([failureOf('tool-transient')])).toBeUndefined()
    expect(repeatedFailureKind([failureOf('tool-transient'), failureOf('no-progress')])).toBeUndefined()
    expect(repeatedFailureKind([
      failureOf('tool-transient', 'a'),
      failureOf('no-progress', 'b'),
      failureOf('no-progress', 'c'),
      failureOf('no-progress', 'd'),
      failureOf('tool-transient', 'e'),
    ])).toEqual({ kind: 'no-progress', count: 3 })
  })

  it('classifies the layer that went quiet', () => {
    const base = { openActions: 0, stepOpen: false, frames: false, child: false }
    expect(classifyTimeout({ ...base, openActions: 1 })).toBe('tool')
    expect(classifyTimeout({ ...base, stepOpen: true })).toBe('transport')
    expect(classifyTimeout({ ...base, stepOpen: true, frames: true })).toBe('stream')
    expect(classifyTimeout(base)).toBe('agent')
    expect(classifyTimeout({ ...base, child: true })).toBe('child-agent')
  })
})

describe('governor decisions', () => {
  it('names every decision that ends a run', () => {
    const stops: readonly GovernorDecision[] = ['stop_success', 'stop_failure', 'stop_budget', 'stop_loop', 'stop_timeout']
    const continues: readonly GovernorDecision[] = ['continue', 'retry', 'replan', 'compact', 'delegate', 'ask_user']
    for (const decision of stops) expect(isStopDecision(decision)).toBe(true)
    for (const decision of continues) expect(isStopDecision(decision)).toBe(false)
  })

  it('answers a terminal task, a stall, and an exhausted ceiling with a stop', () => {
    expect(decided({ status: 'completed' })).toBe('stop_success')
    expect(decided({ status: 'failed' })).toBe('stop_failure')
    expect(decided({ status: 'cancelled' })).toBe('stop_failure')
    expect(decided({ timeout: 'stream' })).toBe('stop_timeout')
    expect(decided({ remaining: { maxSteps: 0 } })).toBe('stop_budget')
    expect(decided({ remaining: { maxSubagentDepth: 0 } })).toBe('continue')
    expect(decided({})).toBe('continue')
  })

  it('reasons from the facts it read', () => {
    expect(composeGovernorDecision(factsOf({ timeout: 'tool' }), THRESHOLDS).reasons).toEqual([
      'no progress for the 180000ms liveness window (tool timeout)',
    ])
    expect(composeGovernorDecision(factsOf({ remaining: { maxWallMs: 0 } }), THRESHOLDS).reasons).toEqual([
      'the maxWallMs ceiling is exhausted',
    ])
    expect(composeGovernorDecision(factsOf({ status: 'failed' }), THRESHOLDS).reasons).toEqual([
      'the task is failed; the run has no work left to admit',
    ])
    expect(composeGovernorDecision(factsOf({}), THRESHOLDS).reasons).toEqual([
      'no budget, loop, liveness, or failure fact asks for a different step',
    ])
  })

  it('stops a run every loop detector found', () => {
    const hit = (facts: Partial<GovernorFacts>, thresholds: GovernorThresholds = THRESHOLDS): string => {
      const result = composeGovernorDecision(factsOf(facts), thresholds)
      expect(result.decision).toBe('stop_loop')
      if (result.loop === undefined) throw new Error('spec: a loop decision carries its detector')
      return result.loop
    }
    expect(hit({ oscillation: 4 })).toBe('the last 4 calls alternate between two tools')
    expect(hit({ repetition: 2 })).toBe('2 identical calls returned the same result')
    expect(hit({ semanticDuplicates: 3 })).toBe('3 consecutive calls repeat the same arguments without repeating them exactly')
    expect(hit({ stagnantSteps: 3 })).toBe('3 consecutive steps made no measurable progress')
    expect(hit({ narrationSteps: 3 })).toBe('3 consecutive steps produced no tool call and no state change')
    expect(hit({ repeatedFailure: { kind: 'no-progress', count: 3 } })).toBe('no-progress was recorded 3 times without resolution')
    expect(hit({ oscillation: 2 }, resolveGovernorThresholds({ loopOscillationRun: 2 }))).toBe('the last 2 calls alternate between two tools')
  })

  it('asks for compaction only under context pressure', () => {
    expect(decided({ tokens: 800, maxTokens: 1_000 })).toBe('compact')
    expect(composeGovernorDecision(factsOf({ tokens: 800, maxTokens: 1_000 }), THRESHOLDS).reasons).toEqual([
      'context pressure is 80% of the 1000-token ceiling',
    ])
    expect(decided({ tokens: 100, maxTokens: 1_000 })).toBe('continue')
    expect(decided({ tokens: 100 })).toBe('continue')
    expect(decided({ tokens: 100, maxTokens: 0 })).toBe('continue')
  })

  it('continues the recovery the newest unresolved failure was decided for', () => {
    const failure = failureOf('tool-transient')
    const decidedBy = (action: RecoveryDecision['action'], attemptsRemaining = 0, over: Partial<GovernorFacts> = {}): string => decided({
      correction: { kind: failure.kind, action, attemptsRemaining },
      ...over,
    })
    expect(decidedBy('retry', 2)).toBe('retry')
    expect(decidedBy('retry', 0)).toBe('replan')
    expect(decidedBy('reread', 1)).toBe('retry')
    expect(decidedBy('compact')).toBe('compact')
    expect(decidedBy('replan')).toBe('replan')
    expect(decidedBy('ask-user')).toBe('ask_user')
    expect(decidedBy('diagnose')).toBe('retry')
    expect(decidedBy('checkpoint-pause')).toBe('stop_budget')
    expect(decidedBy('settle-child')).toBe('delegate')
    expect(decidedBy('settle-child', 0, { delegationAllowed: false })).toBe('ask_user')
    expect(decidedBy('quarantine')).toBe('stop_failure')
    expect(decidedBy('fail-closed')).toBe('stop_failure')
    expect(composeGovernorDecision(factsOf({
      correction: { kind: failure.kind, action: 'ask-user', attemptsRemaining: 0 },
    }), THRESHOLDS).reasons[0]).toContain('its recovery is ask-user with 0 attempt(s) remaining')
    expect(decided({})).toBe('continue')
  })

  it('answers the recovery it was given for a failure it cannot attribute', () => {
    expect(decided({ correction: { kind: 'stalled', action: 'diagnose', attemptsRemaining: 0 } })).toBe('retry')
    expect(decided({ correction: { kind: 'unknown', action: 'fail-closed', attemptsRemaining: 0 } })).toBe('stop_failure')
  })
})

describe('session governor', () => {
  it('counts the trailing run of identical calls within its window', () => {
    const governor = new SessionGovernor(() => 1_000)
    expect(governor.runOf('read:x')).toEqual({ count: 0, digest: undefined })
    expect(governor.identicalRun()).toBe(0)
    governor.noteCall(callOf('read', 'x', 'one'))
    expect(governor.runOf('read:x')).toEqual({ count: 1, digest: 'one' })
    expect(governor.identicalRun()).toBe(1)
    expect(governor.runOf('read:y').count).toBe(0)
    governor.noteCall(callOf('read', 'x', 'two'))
    expect(governor.runOf('read:x')).toEqual({ count: 1, digest: 'two' })
    governor.noteCall(callOf('read', 'x', 'two'))
    expect(governor.identicalRun()).toBe(2)
    expect(governor.runOf('read:x')).toEqual({ count: 2, digest: 'two' })
    // The history is bounded, so a run longer than the window reports the bound.
    for (let index = 0; index < RECENT_CALL_WINDOW * 2; index += 1) governor.noteCall(callOf('read', 'x', 'two'))
    expect(governor.identicalRun()).toBe(RECENT_CALL_WINDOW)
    governor.noteCall(callOf('write', 'x', 'two'))
    expect(governor.identicalRun()).toBe(1)
  })

  it('reports one refusal per identical run', () => {
    const governor = new SessionGovernor(() => 1_000)
    expect(governor.alreadyReported('read:x', 'one')).toBe(false)
    governor.markReported('read:x', 'one')
    expect(governor.alreadyReported('read:x', 'one')).toBe(true)
    expect(governor.alreadyReported('read:x', 'two')).toBe(false)
    expect(governor.alreadyReported('read:y', 'one')).toBe(false)
  })

  it('reports a stall once per stalled progress stamp', () => {
    const clock = 1_000
    const governor = new SessionGovernor(() => clock)
    const input = { at: 1_400, windowMs: 500, openActions: 0, child: false }
    expect(governor.stall(input)).toBeUndefined()
    expect(governor.stall({ ...input, at: 1_500 })).toBe('agent')
    governor.markStall('agent')
    expect(governor.stall({ ...input, at: 1_600 })).toBeUndefined()
    // Progress starts a new episode, which the monitor reports again.
    expect(governor.evaluate(stepOf({ counters: { ...NOTHING, revisions: 1 } }), THRESHOLDS).record.progressScore).toBeCloseTo(1 / 6)
    expect(governor.stall({ ...input, at: 1_600 })).toBe('agent')
  })

  it('classifies a stall by what was in flight', () => {
    const governor = new SessionGovernor(() => 1_000)
    const input = { at: 90_000, windowMs: 1_000, openActions: 0, child: false }
    governor.openStep()
    expect(governor.stall(input)).toBe('transport')
    governor.noteFrame()
    expect(governor.stall(input)).toBe('stream')
    governor.closeStep()
    expect(governor.stall(input)).toBe('agent')
  })

  it('reads activity as liveness while the window has not elapsed', () => {
    let clock = 1_000
    const governor = new SessionGovernor(() => clock)
    // A frame that keeps arriving holds the run live even when no step moved.
    clock = 5_000
    governor.noteFrame()
    governor.noteToolEvent()
    const input = { at: 5_200, windowMs: 500, openActions: 1, child: true }
    expect(governor.stall(input)).toBeUndefined()
    expect(governor.stall({ ...input, at: 1_100, windowMs: 1_000 })).toBeUndefined()
  })

  it('measures a step and records the decision for the next one', () => {
    const governor = new SessionGovernor(() => 1_000)
    const first = governor.evaluate(stepOf({ counters: { ...NOTHING, revisions: 1 } }), THRESHOLDS)
    expect(first.record).toMatchObject({ decision: 'continue', turn: 1, step: 1, at: 100 })
    expect(first.record.delta.stateDelta).toBe(1)
    expect(first.record.progressScore).toBeCloseTo(1 / 6)
    expect(first.record.timeout).toBeUndefined()
    expect(first.loop).toBeUndefined()

    governor.noteCall(callOf('read', '{"path":"a"}'))
    const second = governor.evaluate(stepOf({
      step: 2,
      counters: { ...NOTHING, revisions: 1, toolCalls: 1, observations: 1 },
    }), THRESHOLDS)
    expect(second.record.delta.toolNovelty).toBe(1)
    expect(second.record.delta.evidenceGain).toBe(1)

    const third = governor.evaluate(stepOf({ step: 3, counters: { ...NOTHING, revisions: 1, toolCalls: 1, observations: 1 } }), THRESHOLDS)
    expect(third.record.progressScore).toBe(0)
  })

  it('reads a loop out of the steps it measured', () => {
    const governor = new SessionGovernor(() => 1_000)
    const quiet = stepOf({ counters: { ...NOTHING, revisions: 1 } })
    expect(governor.evaluate(quiet, THRESHOLDS).loop).toBeUndefined()
    expect(governor.evaluate(quiet, THRESHOLDS).loop).toBeUndefined()
    expect(governor.evaluate(quiet, THRESHOLDS).loop).toBeUndefined()
    expect(governor.evaluate(quiet, THRESHOLDS).loop).toBe('3 consecutive steps made no measurable progress')
    expect(governor.evaluate(quiet, THRESHOLDS).record.decision).toBe('stop_loop')
  })

  it('reads a narration loop, an oscillation, and a near-duplicate loop out of its history', () => {
    const thresholds = resolveGovernorThresholds({ loopNarrationStepRun: 2, loopSemanticDuplicateRun: 2, loopSemanticSimilarity: 0.5 })
    const governor = new SessionGovernor(() => 1_000)
    const moved = stepOf({ counters: { ...NOTHING, revisions: 1, toolCalls: 1 } })
    expect(governor.evaluate(stepOf({ counters: { ...NOTHING, revisions: 1 } }), thresholds).loop).toBeUndefined()
    governor.noteCall(callOf('read', 'a'))
    expect(governor.evaluate(moved, thresholds).loop).toBeUndefined()
    expect(governor.evaluate(moved, thresholds).loop).toBeUndefined()
    expect(governor.evaluate(moved, thresholds).loop)
      .toBe('2 consecutive steps produced no tool call and no state change')

    const alternating = new SessionGovernor(() => 1_000)
    for (const [index, tool] of ['read', 'write', 'read', 'write'].entries()) {
      alternating.noteCall(callOf(tool, '{"path":"a"}', `digest-${String(index)}`))
    }
    expect(alternating.evaluate(stepOf(), THRESHOLDS).loop).toBe('the last 4 calls alternate between two tools')

    const duplicating = new SessionGovernor(() => 1_000)
    for (const mode of ['reading', 'writing', 'writing!']) {
      duplicating.noteCall(callOf('read', `{"path":"a","mode":"${mode}"}`))
    }
    expect(duplicating.evaluate(stepOf(), thresholds).loop)
      .toBe('2 consecutive calls repeat the same arguments without repeating them exactly')
  })

  it('reads a repeated failure loop out of the failures it folded', () => {
    const governor = new SessionGovernor(() => 1_000)
    expect(governor.evaluate(stepOf({
      failures: [failureOf('tool-transient', 'a'), failureOf('tool-transient', 'b'), failureOf('tool-transient', 'c')],
    }), THRESHOLDS).loop).toBe('tool-transient was recorded 3 times without resolution')
  })

  it('clears the stall and advances the progress stamp when a step moves', () => {
    const governor = new SessionGovernor(() => 1_000)
    governor.evaluate(stepOf({ counters: { ...NOTHING, revisions: 1 } }), THRESHOLDS)
    governor.markStall('agent')
    const stalled = governor.evaluate(stepOf({ counters: { ...NOTHING, revisions: 1 } }), THRESHOLDS)
    expect(stalled.record.decision).toBe('stop_timeout')
    expect(stalled.record.timeout).toBe('agent')
    const moved = governor.evaluate(stepOf({ counters: { ...NOTHING, revisions: 2 } }), THRESHOLDS)
    expect(moved.record.decision).toBe('continue')
    expect(moved.record.timeout).toBeUndefined()
  })

  it('reads the recovery decided for the newest unresolved failure', () => {
    const governor = new SessionGovernor(() => 1_000)
    const orphan = failureOf('stalled', 'orphan')
    const decidedFailure = failureOf('no-progress', 'decided')
    const result = governor.evaluate(stepOf({
      failures: [orphan, decidedFailure],
      recoveries: recoveryOf(decidedFailure, 'replan'),
    }), THRESHOLDS)
    expect(result.record.decision).toBe('replan')
    expect(result.record.reasons[0]).toContain('no-progress')
  })
})

describe('governor at the step boundary', () => {
  it('records one decision per admitted step', async () => {
    const { ctx } = await rig()
    const agent = await makeAgent(ctx)
    await preStep(ctx, agent, [humanMessage('measure me')])
    await preStep(ctx, agent, [humanMessage('carry on')], 1, 2)

    const records = eventsOf(agent, 'governor/decided')
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({ decision: 'continue', turn: 1, step: 1 })
    expect(records[0]?.delta.stateDelta).toBe(1)
    expect(records[1]).toMatchObject({ turn: 1, step: 2 })
    expect(records[1]?.progressScore).toBe(0)
  })

  it('records a step that moved and resolves the loop failure it answered', async () => {
    const { ctx, kernel } = await rig()
    const agent = await makeAgent(ctx)
    registerTool(ctx, 'read')
    await preStep(ctx, agent, [humanMessage('loop')])
    const quiet = [humanMessage('again')]
    for (const step of [2, 3, 4]) await preStep(ctx, agent, quiet, 1, step)
    expect(eventsOf(agent, 'failure/recorded').map(record => record.kind)).toEqual(['no-progress'])
    expect(kernel.state.view(agent.session)?.unresolvedFailures).toHaveLength(1)

    await callTool(ctx, 'read', agent)
    await preStep(ctx, agent, [humanMessage('try something else')], 1, 5)
    expect(eventsOf(agent, 'governor/decided').at(-1)?.progressScore).toBeCloseTo(1 / 6)
    expect(kernel.state.view(agent.session)?.unresolvedFailures).toEqual([])
  })

  it('refuses the step of an exhausted budget only when it enforces', async () => {
    const { ctx } = await rig({ mode: 'enforce', budgets: { maxToolCalls: 1 } })
    const agent = await makeAgent(ctx)
    recordToolCall(agent, 'read')

    await expect(preStep(ctx, agent, [humanMessage('spend it')])).resolves.toEqual({ kind: 'reject' })
    expect(eventsOf(agent, 'governor/decided').at(-1)).toMatchObject({ decision: 'stop_budget' })
  })

  it('records the same stop without refusing it in shadow mode', async () => {
    const { ctx } = await rig({ budgets: { maxToolCalls: 1 } })
    const agent = await makeAgent(ctx)
    recordToolCall(agent, 'read')

    await expect(preStep(ctx, agent, [humanMessage('spend it')])).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(eventsOf(agent, 'governor/decided').at(-1)).toMatchObject({ decision: 'stop_budget' })
  })

  it('records one stop per refused step of a capped task', async () => {
    const { ctx } = await rig({ mode: 'enforce', budgets: { maxToolCalls: 1 } })
    const agent = await makeAgent(ctx)
    recordToolCall(agent, 'read')
    await preStep(ctx, agent, [humanMessage('spend it')])
    await preStep(ctx, agent, [humanMessage('again')], 1, 2)

    expect(eventsOf(agent, 'governor/decided')).toHaveLength(2)
  })

  it('refuses a repeated call past the run it recorded', async () => {
    const { ctx } = await rig({ mode: 'enforce', policy: ALLOW_ALL })
    const agent = await makeAgent(ctx)
    declareTool(ctx, 'read')
    await preStep(ctx, agent, [humanMessage('read twice')])
    await callTool(ctx, 'read', agent)
    await callTool(ctx, 'read', agent)
    const third = await callTool(ctx, 'read', agent)

    expect(third.isError).toBe(true)
    expect(eventsOf(agent, 'failure/recorded').map(record => record.kind)).toEqual(['no-progress'])
    const refusal = third.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    expect(refusal).toContain('no progress: read was called 2 times')
  })
})

describe('liveness monitor', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a stall once, refuses the step that follows, and skips what expects no progress', async () => {
    vi.useFakeTimers()
    const { ctx, kernel } = await rig({ mode: 'enforce', livenessWindowMs: 1 })
    const running = await makeAgent(ctx)
    Object.assign(running, { status: 'running' })
    const idle = await makeAgent(ctx)
    await preStep(ctx, running, [humanMessage('stall on me')])
    await preStep(ctx, idle, [humanMessage('stay idle')])

    await vi.advanceTimersByTimeAsync(10)

    expect(eventsOf(running, 'failure/recorded').map(record => record.kind)).toEqual(['stalled'])
    expect(eventsOf(running, 'failure/recorded')[0]?.detail).toBe('nothing moved for the 1ms liveness window (transport timeout)')
    expect(eventsOf(idle, 'failure/recorded')).toEqual([])

    await vi.advanceTimersByTimeAsync(10)
    expect(eventsOf(running, 'failure/recorded')).toHaveLength(1)

    await expect(preStep(ctx, running, [humanMessage('again')], 1, 2)).resolves.toEqual({ kind: 'reject' })
    expect(eventsOf(running, 'governor/decided').at(-1)).toMatchObject({ decision: 'stop_timeout', timeout: 'transport' })

    const settled = await makeAgent(ctx)
    Object.assign(settled, { status: 'running' })
    await preStep(ctx, settled, [humanMessage('finish now')])
    await stopTurn(ctx, settled)
    expect(kernel.state.view(settled.session)?.task.status).toBe('completed')
    await vi.advanceTimersByTimeAsync(10)
    expect(eventsOf(settled, 'failure/recorded')).toEqual([])
  })

  it('reports a tool timeout for a call that never settled, and monitors no session that is gone', async () => {
    vi.useFakeTimers()
    const { ctx, kernel } = await rig({ policy: ALLOW_ALL, livenessWindowMs: 1 })
    const agent = await makeAgent(ctx)
    Object.assign(agent, { status: 'running' })
    const blocking = registerBlockingTool(ctx, kernel)
    await preStep(ctx, agent, [humanMessage('call the tool')])
    const pending = callTool(ctx, 'blocking', agent)

    await vi.advanceTimersByTimeAsync(10)
    blocking.release()
    await pending
    expect(eventsOf(agent, 'failure/recorded')[0]?.detail).toBe('nothing moved for the 1ms liveness window (tool timeout)')

    const gone = enterAgent(ctx)
    Object.assign(gone.agent, { status: 'running' })
    await preStep(ctx, gone.agent, [humanMessage('vanish')])
    gone.detach()
    await vi.advanceTimersByTimeAsync(10)
    expect(eventsOf(gone.agent, 'failure/recorded')).toEqual([])
  })
})
