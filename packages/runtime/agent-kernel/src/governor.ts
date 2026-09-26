/**
 * The governor: the progress monitor, the loop detectors, the liveness monitor,
 * and the one control decision they compose per step.
 *
 * Every fact the governor reads is a count or a stamp the kernel already folds
 * from the session log, so the same decision is reached by a replay that holds
 * only the log. The module holds no seam of its own: `index.ts` observes the
 * loop and tool events, and this module answers what they mean.
 *
 * @module @deepseek-ai/dsh-agent-kernel/governor
 */

import type { LedgerEntry } from './ledger.ts'
import type {
  FailureId,
  FailureKind,
  FailureRef,
  GovernorDecision,
  RecoveryAction,
  RecoveryDecision,
  ResourceBudget,
  StepDelta,
  TaskStatus,
  TimeoutKind,
} from './types.ts'

/**
 * How many settled calls one session's history keeps. The window bounds a long
 * session's memory and holds every call the detectors look at: an alternating
 * run and a near-duplicate run are reported at their configured thresholds,
 * which are far smaller.
 */
export const RECENT_CALL_WINDOW = 32

/**
 * Settled calls at which the kernel already refuses a repeat: the third
 * identical call is the one the `no-progress` refusal answers.
 */
export const REPEATED_CALLS = 2

/** One settled tool call, as the detectors and the repetition tally read it. */
export interface ObservedCall {
  /** Tool that was called. */
  readonly tool: string
  /** `tool:argumentsDigest`; two calls with one signature asked the same question. */
  readonly signature: string
  /** Canonical argument text, for near-duplicate comparison. */
  readonly arguments: string
  /** Digest of what the call returned, when it settled with a result. */
  readonly digest: string | undefined
  /**
   * Monotone position in this session's call order. Step boundaries compare
   * positions rather than array offsets, so trimming the window cannot shift
   * which calls belong to the step being measured.
   */
  readonly seq: number
}

/** The counts one step is measured against: its movement is their difference. */
export interface StepCounters {
  /** `tool/call` events folded. */
  readonly toolCalls: number
  /** Task revision, which advances once per accepted transition. */
  readonly revisions: number
  /** Observations and claims recorded. */
  readonly observations: number
  /** `goal/change` events the session recorded. */
  readonly goals: number
  /** Failures with no accepted resolution. */
  readonly failures: number
  /** Current plan revision, 0 before a plan is recorded. */
  readonly planRevision: number
}

/** The counts of a step with nothing to measure, so a first step sees its own intake. */
const ZERO_COUNTERS: StepCounters = {
  toolCalls: 0,
  revisions: 0,
  observations: 0,
  goals: 0,
  failures: 0,
  planRevision: 0,
}

/** Deployment thresholds every detector and the liveness monitor read. */
export interface GovernorThresholds {
  /** Alternating calls at which the oscillation detector fires. */
  readonly oscillationRun: number
  /** Consecutive near-duplicate pairs at which the semantic detector fires. */
  readonly semanticDuplicateRun: number
  /** Argument similarity, in `(0, 1]`, at which two calls are near-duplicates. */
  readonly semanticSimilarity: number
  /** Consecutive steps with no movement at which the no-progress detector fires. */
  readonly stagnantStepRun: number
  /** Consecutive steps with no tool call and no movement at which the narration detector fires. */
  readonly narrationStepRun: number
  /** Recordings of one failure kind at which the repeated-failure detector fires. */
  readonly failureRun: number
  /** Share of the token ceiling at which the governor asks for compaction. */
  readonly contextPressureRatio: number
  /** Milliseconds of no progress and no activity after which a run is stalled. */
  readonly livenessWindowMs: number
}

/** The configured values {@link GovernorThresholds} resolves from, before validation. */
export interface GovernorThresholdInput {
  /** @see GovernorThresholds.oscillationRun */
  readonly loopOscillationRun?: number
  /** @see GovernorThresholds.semanticDuplicateRun */
  readonly loopSemanticDuplicateRun?: number
  /** @see GovernorThresholds.semanticSimilarity */
  readonly loopSemanticSimilarity?: number
  /** @see GovernorThresholds.stagnantStepRun */
  readonly loopStagnantStepRun?: number
  /** @see GovernorThresholds.narrationStepRun */
  readonly loopNarrationStepRun?: number
  /** @see GovernorThresholds.failureRun */
  readonly loopFailureRun?: number
  /** @see GovernorThresholds.contextPressureRatio */
  readonly contextPressureRatio?: number
  /** @see GovernorThresholds.livenessWindowMs */
  readonly livenessWindowMs?: number
}

/** Every fact one step's decision is composed from. */
export interface GovernorFacts {
  /** Task lifecycle status at the step boundary. */
  readonly status: TaskStatus
  /** Remaining allowance per configured ceiling. */
  readonly remaining: ResourceBudget
  /** Timeout kind the liveness monitor reported, when the window elapsed. */
  readonly timeout?: TimeoutKind
  /** Movement of the step that just ended, in `[0, 1]`. */
  readonly progressScore: number
  /** Trailing run of identical calls with identical results. */
  readonly repetition: number
  /** Trailing run of calls alternating between two tools. */
  readonly oscillation: number
  /** Trailing run of near-duplicate calls. */
  readonly semanticDuplicates: number
  /** Consecutive steps that moved nothing. */
  readonly stagnantSteps: number
  /** Consecutive steps with no tool call and no movement. */
  readonly narrationSteps: number
  /** Recordings of the most repeated unresolved failure kind. */
  readonly repeatedFailure?: { readonly kind: FailureKind; readonly count: number }
  /** Session tokens the task spent. */
  readonly tokens: number
  /** Configured token ceiling, when the task declared one. */
  readonly maxTokens?: number
  /** The newest unresolved failure's decided recovery, when one exists. */
  readonly correction?: {
    readonly kind: FailureKind
    readonly action: RecoveryAction
    readonly attemptsRemaining: number
  }
  /** Whether the task's budget and receipt admit another child run. */
  readonly delegationAllowed: boolean
}

/** The governor's answer for one step. */
export interface GovernorDecisionResult {
  /** Decision composed for the step that follows. */
  readonly decision: GovernorDecision
  /** Every fact that produced the decision, in evaluation order. */
  readonly reasons: readonly string[]
  /** Loop a detector found, when the decision answers one. */
  readonly loop?: string
}

/** What one step boundary measures. */
export interface StepInput {
  /** Turn the boundary belongs to, for the decision record. */
  readonly turn: number
  /** Step the boundary belongs to, for the decision record. */
  readonly step: number
  /** The ledger entry's counts at this boundary. */
  readonly counters: StepCounters
  /** Task lifecycle status at this boundary. */
  readonly status: TaskStatus
  /** Remaining allowance per configured ceiling. */
  readonly remaining: ResourceBudget
  /** Failures with no accepted resolution, in log order. */
  readonly failures: readonly FailureRef[]
  /** Decided recovery per failure, as the ledger folded it. */
  readonly recoveries: ReadonlyMap<FailureId, RecoveryDecision>
  /** Session tokens the task spent. */
  readonly tokens: number
  /** Configured token ceiling, when the task declared one. */
  readonly maxTokens?: number
  /** Whether the task may hand work to another child. */
  readonly delegationAllowed: boolean
  /** Unix epoch milliseconds of the boundary. */
  readonly at: number
}

/** One step's measured movement and the decision it produced. */
export interface GovernorEvaluation {
  /** The record to append; its `timeout` is the stall the decision answers. */
  readonly record: {
    readonly decision: GovernorDecision
    readonly reasons: readonly string[]
    readonly delta: StepDelta
    readonly progressScore: number
    readonly turn: number
    readonly step: number
    readonly timeout?: TimeoutKind
    readonly at: number
  }
  /** Loop a detector found, when one did. */
  readonly loop?: string
}

/**
 * Whether each task status expects progress without another input. A task
 * waiting on a human answer, or parked by a stop, is not stalled.
 */
export const EXPECTS_PROGRESS: Readonly<Record<TaskStatus, boolean>> = {
  intake: true,
  planning: true,
  ready: true,
  executing: true,
  observing: true,
  verifying: true,
  recovering: true,
  'awaiting-approval': false,
  'awaiting-user': false,
  paused: false,
  completed: false,
  failed: false,
  cancelled: false,
}

/**
 * The step-level decision each recovery action implies, so the governor asks
 * for what the recovery engine already decided rather than classifying a second
 * time. `settle-child` reads as `delegate` and is refused when no depth remains,
 * `checkpoint-pause` reads as the budget stop the pause implements, and the
 * two refusals read as a failed run.
 */
const GOVERNOR_BY_RECOVERY: Readonly<Record<RecoveryAction, GovernorDecision>> = {
  retry: 'retry',
  compact: 'compact',
  reread: 'retry',
  'ask-user': 'ask_user',
  replan: 'replan',
  diagnose: 'retry',
  'checkpoint-pause': 'stop_budget',
  'settle-child': 'delegate',
  quarantine: 'stop_failure',
  'fail-closed': 'stop_failure',
}

/**
 * The first spend axis the task has exhausted, read inside the composition.
 * The depth and concurrency axes are not spend, so an exhausted depth never
 * stops a run that is otherwise spending nothing.
 */
const SPEND_AXES = ['maxSteps', 'maxToolCalls', 'maxTokens', 'maxWallMs', 'maxCostUsd'] as const satisfies readonly (keyof ResourceBudget)[]

/**
 * Resolve one `at least two` run threshold.
 * @param configured - the value the deployment supplied, when it supplied one.
 * @param fallback - the default the kernel runs under.
 * @param field - configuration field name, for the failure message.
 * @returns the threshold.
 * @throws When the supplied value is not an integer of at least 2.
 */
function resolveRun(configured: number | undefined, fallback: number, field: string): number {
  if (configured === undefined) return fallback
  if (!Number.isInteger(configured) || configured < 2) {
    throw new Error(`agent-kernel: ${field} must be an integer of at least 2, got ${String(configured)}`)
  }
  return configured
}

/**
 * Resolve one unit-interval threshold.
 * @param configured - the value the deployment supplied, when it supplied one.
 * @param fallback - the default the kernel runs under.
 * @param field - configuration field name, for the failure message.
 * @returns the threshold.
 * @throws When the supplied value is not greater than 0 and at most 1.
 */
function resolveRatio(configured: number | undefined, fallback: number, field: string): number {
  if (configured === undefined) return fallback
  if (!(configured > 0 && configured <= 1)) {
    throw new Error(`agent-kernel: ${field} must be greater than 0 and at most 1, got ${String(configured)}`)
  }
  return configured
}

/**
 * Resolve the liveness window.
 * @param configured - the value the deployment supplied, when it supplied one.
 * @returns the window in milliseconds.
 * @throws When the supplied value is not a positive integer number of milliseconds.
 */
function resolveWindow(configured: number | undefined): number {
  if (configured === undefined) return 180_000
  if (!Number.isInteger(configured) || configured < 1) {
    throw new Error(`agent-kernel: livenessWindowMs must be a positive integer number of milliseconds, got ${String(configured)}`)
  }
  return configured
}

/**
 * Resolve and validate every governor threshold. A threshold that cannot mean
 * what it says fails plugin load rather than silently disabling a detector.
 * @param values - the configured thresholds.
 * @returns the thresholds the governor runs under.
 * @throws When any supplied threshold is outside its valid range.
 */
export function resolveGovernorThresholds(values: GovernorThresholdInput): GovernorThresholds {
  return {
    oscillationRun: resolveRun(values.loopOscillationRun, 4, 'loopOscillationRun'),
    semanticDuplicateRun: resolveRun(values.loopSemanticDuplicateRun, 3, 'loopSemanticDuplicateRun'),
    semanticSimilarity: resolveRatio(values.loopSemanticSimilarity, 0.8, 'loopSemanticSimilarity'),
    stagnantStepRun: resolveRun(values.loopStagnantStepRun, 3, 'loopStagnantStepRun'),
    narrationStepRun: resolveRun(values.loopNarrationStepRun, 3, 'loopNarrationStepRun'),
    failureRun: resolveRun(values.loopFailureRun, 3, 'loopFailureRun'),
    contextPressureRatio: resolveRatio(values.contextPressureRatio, 0.8, 'contextPressureRatio'),
    livenessWindowMs: resolveWindow(values.livenessWindowMs),
  }
}

/**
 * How often the liveness monitor checks the tracked sessions. A stall is
 * therefore reported within a quarter of the window of its start.
 * @param windowMs - the configured liveness window.
 * @returns the check period in milliseconds.
 */
export function livenessCheckMs(windowMs: number): number {
  return Math.max(1, Math.floor(windowMs / 4))
}

/**
 * The counts one ledger entry currently holds.
 * @param entry - the session's folded ledger entry.
 * @returns the counters a step delta is measured between.
 */
export function countersOf(entry: LedgerEntry): StepCounters {
  return {
    toolCalls: entry.toolCalls,
    revisions: entry.task?.revision ?? 0,
    observations: entry.evidence.size + entry.claims.size,
    goals: entry.goalChanges,
    failures: entry.failures.size,
    planRevision: entry.plan?.revision ?? 0,
  }
}

/**
 * The movement one step made, as the difference between two count readings.
 * @param previous - counts at the previous step boundary.
 * @param current - counts at this boundary.
 * @param calls - the calls that settled during the step, in order.
 * @param seen - signatures already used before the step.
 * @returns the step's delta; every axis is 0 or 1 except `toolNovelty`, which is
 *   the share of the step's calls that were new.
 */
export function stepDeltaOf(
  previous: StepCounters,
  current: StepCounters,
  calls: readonly ObservedCall[],
  seen: ReadonlySet<string>,
): StepDelta {
  const novel = calls.filter(call => !seen.has(call.signature)).length
  return {
    toolNovelty: calls.length === 0 ? 0 : novel / calls.length,
    stateDelta: current.revisions > previous.revisions ? 1 : 0,
    evidenceGain: current.observations > previous.observations ? 1 : 0,
    goalProgress: current.goals > previous.goals ? 1 : 0,
    errorReduction: current.failures < previous.failures ? 1 : 0,
    planProgress: current.planRevision > previous.planRevision ? 1 : 0,
  }
}

/**
 * The step's normalized progress: the mean of its six axes, so 0 is a step that
 * moved nothing the harness can observe and 1 is a step that moved on every
 * axis. No axis dominates: a model that only calls novel tools and one that
 * only records evidence both score a fraction, which is what the stall and loop
 * thresholds are calibrated against.
 * @param delta - the step's measured movement.
 * @returns the score, in `[0, 1]`.
 */
export function progressScoreOf(delta: StepDelta): number {
  return (delta.toolNovelty + delta.stateDelta + delta.evidenceGain + delta.goalProgress + delta.errorReduction + delta.planProgress) / 6
}

/**
 * The length of the trailing run of calls alternating between two tools, which
 * is the A-B-A-B pattern: every call but the first two repeats the one two
 * before it and differs from the one immediately before it.
 * @param signatures - settled call signatures, oldest first.
 * @returns the run length in calls; 1 for a repeated pair, 2 for one alternation.
 */
export function oscillationRun(signatures: readonly string[]): number {
  let priorPrior: string | undefined
  let prior: string | undefined
  let run = 0
  for (const signature of signatures) {
    run = prior === undefined || signature === prior
      ? 1
      : priorPrior !== undefined && signature === priorPrior ? run + 1 : 2
    priorPrior = prior
    prior = signature
  }
  return run
}

/**
 * How similar two canonical argument texts are: the Jaccard ratio of their
 * token sets, so argument order and punctuation do not hide an equivalent call.
 * @param left - one call's canonical arguments.
 * @param right - the other's.
 * @returns the ratio, in `[0, 1]`.
 */
export function similarityOf(left: string, right: string): number {
  const a = tokensOf(left)
  const b = tokensOf(right)
  if (a.size === 0 && b.size === 0) return 1
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

/**
 * Tokenize canonical JSON arguments into a set of lower-case words.
 * @param text - the canonical argument text.
 * @returns the token set.
 */
function tokensOf(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token !== ''))
}

/**
 * The trailing run of calls that repeat a previous call's intent without
 * repeating its text: same tool, similar arguments, different text.
 * @param calls - settled calls, oldest first.
 * @param similarity - the ratio at which two calls count as the same intent.
 * @returns the number of consecutive pairs that are near-duplicates.
 */
export function semanticDuplicateRun(calls: readonly ObservedCall[], similarity: number): number {
  let pairs = 0
  let previous: ObservedCall | undefined
  for (const call of calls) {
    const duplicate = previous !== undefined
      && call.tool === previous.tool
      && call.arguments !== previous.arguments
      && similarityOf(call.arguments, previous.arguments) >= similarity
    pairs = duplicate ? pairs + 1 : 0
    previous = call
  }
  return pairs
}

/**
 * The unresolved failure kind recorded most often, when one kind is unresolved
 * more than once.
 * @param failures - failures with no accepted resolution.
 * @returns the kind and its count, or undefined when no kind repeats.
 */
export function repeatedFailureKind(failures: readonly FailureRef[]): { kind: FailureKind; count: number } | undefined {
  const counts = new Map<FailureKind, number>()
  for (const failure of failures) counts.set(failure.kind, (counts.get(failure.kind) ?? 0) + 1)
  let repeated: { kind: FailureKind; count: number } | undefined
  for (const [kind, count] of counts) {
    if (count > 1 && (repeated === undefined || count > repeated.count)) repeated = { kind, count }
  }
  return repeated
}

/**
 * How much of the token ceiling the session has spent. A ceiling that never
 * applies reads as no pressure, so the compact rule can never fire from an
 * unconfigured budget.
 * @param facts - the step's facts.
 * @returns the ratio, in `[0, 1]` while the task is within its ceiling.
 */
function contextPressure(facts: GovernorFacts): number {
  if (facts.maxTokens === undefined || facts.maxTokens <= 0) return 0
  return facts.tokens / facts.maxTokens
}

/**
 * Which layer went quiet for a session whose liveness window elapsed.
 * @param input - what was in flight when the window elapsed.
 * @returns the timeout kind the stall is reported as.
 */
export function classifyTimeout(input: {
  /** Actions proposed and not yet committed. */
  readonly openActions: number
  /** Whether a step was admitted and has not closed. */
  readonly stepOpen: boolean
  /** Whether the in-flight step produced a model frame. */
  readonly frames: boolean
  /** Whether this session is a delegated child. */
  readonly child: boolean
}): TimeoutKind {
  if (input.openActions > 0) return 'tool'
  if (input.stepOpen) return input.frames ? 'stream' : 'transport'
  return input.child ? 'child-agent' : 'agent'
}

/**
 * The loop a detector found, when one did. Detectors are read most specific
 * first: an alternating run, then a repeated identical call, then a run of
 * near-duplicates, then a run of steps that moved nothing, then a run of steps
 * that did nothing at all, then one failure kind recurring.
 * @param facts - the step's facts.
 * @param thresholds - the configured detector thresholds.
 * @returns the hit, or undefined when the run is not looping yet.
 */
function detectLoop(facts: GovernorFacts, thresholds: GovernorThresholds): string | undefined {
  if (facts.oscillation >= thresholds.oscillationRun) {
    return `the last ${String(facts.oscillation)} calls alternate between two tools`
  }
  if (facts.repetition >= REPEATED_CALLS) {
    return `${String(facts.repetition)} identical calls returned the same result`
  }
  if (facts.semanticDuplicates >= thresholds.semanticDuplicateRun) {
    return `${String(facts.semanticDuplicates)} consecutive calls repeat the same arguments without repeating them exactly`
  }
  if (facts.stagnantSteps >= thresholds.stagnantStepRun) {
    return `${String(facts.stagnantSteps)} consecutive steps made no measurable progress`
  }
  if (facts.narrationSteps >= thresholds.narrationStepRun) {
    return `${String(facts.narrationSteps)} consecutive steps produced no tool call and no state change`
  }
  const repeated = facts.repeatedFailure
  if (repeated !== undefined && repeated.count >= thresholds.failureRun) {
    return `${repeated.kind} was recorded ${String(repeated.count)} times without resolution`
  }
  return undefined
}

/**
 * Whether a decision ends the run at the boundary it was composed for.
 * @param decision - the composed decision.
 * @returns whether the kernel refuses the next step for it.
 */
export function isStopDecision(decision: GovernorDecision): boolean {
  switch (decision) {
    case 'stop_success':
    case 'stop_failure':
    case 'stop_budget':
    case 'stop_loop':
    case 'stop_timeout':
      return true
    case 'continue':
    case 'retry':
    case 'replan':
    case 'compact':
    case 'delegate':
    case 'ask_user':
      return false
  }
}

/**
 * The decision one step's facts compose, with the reasons that produced it.
 * @param facts - what the ledger, the detectors, and the liveness monitor read.
 * @param thresholds - the configured thresholds.
 * @returns the decision, its reasons, and the loop it answers when one fired.
 */
export function composeGovernorDecision(facts: GovernorFacts, thresholds: GovernorThresholds): GovernorDecisionResult {
  if (facts.status === 'completed') {
    return { decision: 'stop_success', reasons: ['the task is completed; no further step is admitted'] }
  }
  if (facts.status === 'failed' || facts.status === 'cancelled') {
    return { decision: 'stop_failure', reasons: [`the task is ${facts.status}; the run has no work left to admit`] }
  }
  if (facts.timeout !== undefined) {
    const window = String(thresholds.livenessWindowMs)
    return {
      decision: 'stop_timeout',
      reasons: [`no progress for the ${window}ms liveness window (${facts.timeout} timeout)`],
    }
  }
  const exhausted = SPEND_AXES.find(axis => facts.remaining[axis] === 0)
  if (exhausted !== undefined) {
    return { decision: 'stop_budget', reasons: [`the ${exhausted} ceiling is exhausted`] }
  }
  const loop = detectLoop(facts, thresholds)
  if (loop !== undefined) return { decision: 'stop_loop', reasons: [loop], loop }
  const pressure = contextPressure(facts)
  if (pressure >= thresholds.contextPressureRatio) {
    const percent = String(Math.round(pressure * 100))
    return { decision: 'compact', reasons: [`context pressure is ${percent}% of the ${String(facts.maxTokens)}-token ceiling`] }
  }
  const correction = facts.correction
  if (correction !== undefined) {
    const reason = `the newest unresolved failure is ${correction.kind}; its recovery is ${correction.action} with ${String(correction.attemptsRemaining)} attempt(s) remaining`
    if (correction.action === 'retry' || correction.action === 'reread') {
      return correction.attemptsRemaining > 0
        ? { decision: 'retry', reasons: [reason] }
        : { decision: 'replan', reasons: [reason, 'no attempt remains, so the step needs a different plan'] }
    }
    const decided = GOVERNOR_BY_RECOVERY[correction.action]
    if (decided === 'delegate' && !facts.delegationAllowed) {
      return { decision: 'ask_user', reasons: [reason, 'the delegation depth is exhausted, so a human decides'] }
    }
    return { decision: decided, reasons: [reason] }
  }
  return { decision: 'continue', reasons: ['no budget, loop, liveness, or failure fact asks for a different step'] }
}

/**
 * One session's process-local governor state: the call history the detectors
 * read, the counters the previous step was measured at, the liveness stamps,
 * and the stall the monitor reported.
 *
 * The state is process-local on purpose. Its durable halves are the events it
 * causes — a `no-progress` or `stalled` failure, and the `governor/decided`
 * record — so a resumed process starts a fresh window instead of refusing a
 * step for a history it no longer counts.
 */
export class SessionGovernor {
  /** Recent settled calls, oldest first. */
  private readonly recent: ObservedCall[] = []
  /** Counters of the previous step boundary. */
  private counters: StepCounters = ZERO_COUNTERS
  /** Call position at the previous boundary. */
  private mark = 0
  /** Next call position. */
  private sequence = 0
  /** The exact run already reported as a `no-progress` failure. */
  private reported: { readonly signature: string; readonly digest: string | undefined } | undefined
  /** Consecutive steps that moved nothing. */
  private stagnantSteps = 0
  /** Consecutive steps with no tool call and no movement. */
  private narrationSteps = 0
  /** Unix epoch milliseconds of the last model frame. */
  private lastFrameAt: number
  /** Unix epoch milliseconds of the last tool pipeline event. */
  private lastToolEventAt: number
  /** Unix epoch milliseconds of the last step that moved something. */
  private lastProgressAt: number
  /** Whether a step was admitted and has not closed. */
  private stepOpen = false
  /** Whether the in-flight step produced a model frame. */
  private framesThisStep = false
  /** Timeout kind the monitor reported and no later progress answered. */
  private stalled: TimeoutKind | undefined
  /** Progress stamp the current stall was reported for, so it is reported once. */
  private reportedFor: number | undefined

  /**
   * @param now - wall-clock reading; injected so the liveness window is testable.
   */
  constructor(private readonly now: () => number = Date.now) {
    const at = this.now()
    this.lastFrameAt = at
    this.lastToolEventAt = at
    this.lastProgressAt = at
  }

  /**
   * Record one settled call.
   * @param call - the call and the digest of what it returned.
   */
  noteCall(call: Omit<ObservedCall, 'seq'>): void {
    this.sequence += 1
    this.recent.push({ ...call, seq: this.sequence })
    if (this.recent.length > RECENT_CALL_WINDOW) this.recent.shift()
  }

  /** Record one model-stream frame. */
  noteFrame(): void {
    this.lastFrameAt = this.now()
    this.framesThisStep = true
  }

  /** Record one tool pipeline event: a call was proposed or settled. */
  noteToolEvent(): void {
    this.lastToolEventAt = this.now()
  }

  /**
   * The trailing run a call with this signature extends, when the session's
   * last call asked the same question and the run returned one result.
   * @param signature - the candidate call's signature.
   * @returns the run length and the result digest it repeated.
   */
  runOf(signature: string): { readonly count: number; readonly digest: string | undefined } {
    const trailing = this.recent.at(-1)
    if (trailing === undefined || trailing.signature !== signature) return { count: 0, digest: undefined }
    let count = 0
    for (const call of this.recent.toReversed()) {
      if (call.signature !== signature || call.digest !== trailing.digest) break
      count += 1
    }
    return { count, digest: trailing.digest }
  }

  /**
   * The trailing run of calls that repeated one question and one answer.
   * @returns the run length in calls.
   */
  identicalRun(): number {
    const trailing = this.recent.at(-1)
    return trailing === undefined ? 0 : this.runOf(trailing.signature).count
  }

  /**
   * Whether this exact run was already reported as a `no-progress` failure.
   * @param signature - the run's call signature.
   * @param digest - the result digest the run repeated.
   * @returns whether the failure is already recorded for this run.
   */
  alreadyReported(signature: string, digest: string | undefined): boolean {
    return this.reported?.signature === signature && this.reported.digest === digest
  }

  /**
   * Remember that this exact run's refusal was reported.
   * @param signature - the run's call signature.
   * @param digest - the result digest the run repeated.
   */
  markReported(signature: string, digest: string | undefined): void {
    this.reported = { signature, digest }
  }

  /**
   * Whether the liveness window elapsed with no progress and no activity, and
   * which layer went quiet. A stall is reported once: the monitor records it
   * against the progress stamp it started from, so it is not reported again
   * until the run moves and stalls again.
   * @param input - the boundary clock, the window, and what is in flight.
   * @returns the timeout kind to report, or undefined while the run is live.
   */
  stall(input: {
    /** Unix epoch milliseconds of the check. */
    readonly at: number
    /** The configured liveness window. */
    readonly windowMs: number
    /** Actions proposed and not yet committed. */
    readonly openActions: number
    /** Whether this session is a delegated child. */
    readonly child: boolean
  }): TimeoutKind | undefined {
    if (input.at - this.lastProgressAt < input.windowMs) return undefined
    if (input.at - Math.max(this.lastFrameAt, this.lastToolEventAt) < input.windowMs) return undefined
    if (this.reportedFor === this.lastProgressAt) return undefined
    return classifyTimeout({
      openActions: input.openActions,
      stepOpen: this.stepOpen,
      frames: this.framesThisStep,
      child: input.child,
    })
  }

  /**
   * Record a reported stall, so the governor's next decision answers it.
   * @param kind - the timeout kind the monitor reported.
   */
  markStall(kind: TimeoutKind): void {
    this.stalled = kind
    this.reportedFor = this.lastProgressAt
  }

  /**
   * Mark the step admitted: it is now the step a stall would be reported for.
   */
  openStep(): void {
    this.stepOpen = true
    this.framesThisStep = false
  }

  /** Mark the turn closed: no step is in flight. */
  closeStep(): void {
    this.stepOpen = false
    this.framesThisStep = false
  }

  /**
   * Measure the step that just ended and compose the decision for the next one.
   * The counters advance whether or not the next step is admitted, so an
   * refused step cannot be measured twice.
   * @param input - the ledger's facts at this boundary.
   * @param thresholds - the configured thresholds.
   * @returns the record to append and the loop a detector found, when one did.
   */
  evaluate(input: StepInput, thresholds: GovernorThresholds): GovernorEvaluation {
    const calls = this.recent.filter(call => call.seq > this.mark)
    const seen = new Set(this.recent.filter(call => call.seq <= this.mark).map(call => call.signature))
    const delta = stepDeltaOf(this.counters, input.counters, calls, seen)
    const progressScore = progressScoreOf(delta)
    if (progressScore > 0) {
      this.lastProgressAt = input.at
      this.stalled = undefined
    }
    this.stagnantSteps = progressScore === 0 ? this.stagnantSteps + 1 : 0
    this.narrationSteps = calls.length === 0 && progressScore === 0 ? this.narrationSteps + 1 : 0
    const repeatedFailure = repeatedFailureKind(input.failures)
    const correction = this.correctionOf(input)
    const facts: GovernorFacts = {
      status: input.status,
      remaining: input.remaining,
      ...this.stalled === undefined ? {} : { timeout: this.stalled },
      progressScore,
      repetition: this.identicalRun(),
      oscillation: oscillationRun(this.recent.map(call => call.signature)),
      semanticDuplicates: semanticDuplicateRun(this.recent, thresholds.semanticSimilarity),
      stagnantSteps: this.stagnantSteps,
      narrationSteps: this.narrationSteps,
      ...repeatedFailure === undefined ? {} : { repeatedFailure },
      tokens: input.tokens,
      ...input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens },
      ...correction === undefined ? {} : { correction },
      delegationAllowed: input.delegationAllowed,
    }
    const decided = composeGovernorDecision(facts, thresholds)
    this.counters = input.counters
    this.mark = this.sequence
    return {
      record: {
        decision: decided.decision,
        reasons: decided.reasons,
        delta,
        progressScore,
        turn: input.turn,
        step: input.step,
        ...this.stalled === undefined ? {} : { timeout: this.stalled },
        at: input.at,
      },
      ...decided.loop === undefined ? {} : { loop: decided.loop },
    }
  }

  /**
   * The newest unresolved failure's decided recovery, when the engine decided one.
   * @param input - the ledger's failures and their recovery decisions.
   * @returns the kind, action, and attempts remaining, or undefined.
   */
  private correctionOf(input: StepInput): GovernorFacts['correction'] {
    let correction: GovernorFacts['correction']
    for (const failure of input.failures) {
      const decided = input.recoveries.get(failure.failureId)
      if (decided === undefined) continue
      correction = { kind: failure.kind, action: decided.action, attemptsRemaining: decided.attemptsRemaining }
    }
    return correction
  }
}
