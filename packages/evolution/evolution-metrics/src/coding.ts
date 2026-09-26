/**
 * The §13.2 coding metric set over the events a session log already holds:
 * verified success, false completion, regression, recovery, planning,
 * verification coverage, human intervention, cost, and latency (§13.1 Layer 2
 * is the behavior these read).
 *
 * One session's log is folded into {@link CodingSessionFacts}; the readings are
 * the aggregate over a window of those folds. Every counter the kernel already
 * owns is read from `readKernelMetrics`, never re-folded, and the fold derives
 * only what no counter expresses: which completion a passing verification
 * certified, which one a later record contradicted, which criterion regressed,
 * what the newest recorded plan tracks, what the turns spent, what the session
 * lasted, which failures the trace projection reads as a detected loop, and how
 * much of the model's context window the session's own requests occupied.
 *
 * The §5.4 baseline readings the spec asks for beside §13.2's nine live here
 * too, because the same fold holds their inputs: loop rate, tool failure rate,
 * subagent waste, context utilization, average tokens, and the three
 * verified-success ratios (per dollar, per million tokens, per ten minutes).
 * Cost is priced with `dsh-budgets`' own `costUsd`/`spendOf`, so the dollar
 * figure uses the same flat price and the same billed buckets the budget
 * guard's ceilings bound; that price is the one deployment choice of this
 * module.
 *
 * The §18.3 kernel counters live here too, over the same window: the task,
 * verification, policy, approval, and checkpoint families §18.3 names and no
 * §13.2 or §5.4 id expresses. They are the kernel's own counters, read from
 * the same fold, so this is where the specification's observability list is
 * presented and no second package reads the same counters for a metric.
 *
 * A reading whose records are absent names the record, never zero. Nothing
 * here writes and nothing calls a model.
 * @module @deepseek-ai/dsh-evolution-metrics/src/coding
 */

import { readKernelMetrics, type FailureKind, type KernelMetrics } from '@deepseek-ai/dsh-agent-kernel'
import { costUsd, spendOf } from '@deepseek-ai/dsh-budgets'
import type { FeedbackCategory } from '@deepseek-ai/dsh-command-feedback/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { gainPerMillionTokens, metric, rate, ratio, unavailable } from './metrics.ts'
import type { CodingMetricId, MetricUnit, MetricValue } from './types.ts'

/** The session log every coding metric is folded from. */
const LOG_INPUT = 'ctx.sessionPersistence.list() / open(id, \'read\') / read(0): the session log'

/** The kernel fold the same log is read through, never re-folded. */
const COUNTER_INPUT = 'readKernelMetrics(events): KernelMetrics'

/** The records a contradiction of a completion would have to come from. */
const LATER_INPUT = `${LOG_INPUT} — verification/result.status and feedback/record.category`

/** The billed usage every spend reading is computed from. */
const BILLED_INPUT = `${LOG_INPUT} — assistant/message.usage (uncached prompt, cache, and completion buckets)`

/** The deployment price those buckets are priced with. */
const PRICE_INPUT = 'ctx.evolutionMetrics config: usdPerMillionTokens, priced by `dsh-budgets` costUsd'

/** The records the context-utilization ratio pairs. */
const OCCUPANCY_INPUT = `${LOG_INPUT} — assistant/message.usage (prompt side) and request/context.contextWindow`

/** Why a dollar reading is unmeasurable when the deployment states no price. */
const UNPRICED = 'the deployment states no price for billed tokens: set `usdPerMillionTokens` in the plugin '
  + 'config, or no dollar reading over this window is measurable'

/** Milliseconds in ten minutes, the denominator of the throughput ratio. */
const MS_PER_TEN_MINUTES = 600_000

/**
 * Failure kinds `dsh-evolution-trace` ends a run with as `loop_detected`: a run
 * that stopped making progress, and one whose liveness window elapsed with
 * nothing moved. Every other kind ends its run as a failure or a budget stop.
 */
const LOOP_FAILURE_KINDS: Readonly<Partial<Record<FailureKind, true>>> = {
  'no-progress': true,
  stalled: true,
}

/** Whether a plan item counts as done. */
const PLANNED_DONE: TodoItem['status'] = 'completed'

/**
 * Feedback categories whose remark contradicts the completion before it: the
 * human is reporting the result or the instructions back, not filing a note.
 */
const CONTRADICTING_REMARKS: Readonly<Partial<Record<FeedbackCategory, true>>> = {
  'task-result': true,
  'instruction-following': true,
}

/** One criterion's observed statuses inside one task, in log order. */
type CriterionStatus = 'pass' | 'fail' | 'unknown'

/** What one session's log contributes to the coding metrics. */
export interface CodingSessionFacts {
  /** Session identity. */
  sessionId: string
  /** ISO-8601 instant of the newest recorded event, or null for an empty log. */
  updatedAt: string | null
  /** The kernel's own counters over the same log. */
  kernel: KernelMetrics
  /** Completions a passing verification of the same task certified. */
  certifiedCompletions: number
  /**
   * Completions a later failing verification of the same task, or a later
   * human remark, contradicted.
   */
  contradictedCompletions: number
  /**
   * Verifications and human remarks recorded after a completion: the
   * observations a contradiction would have to come from.
   */
  laterObservations: number
  /** Criteria that failed after they had passed. */
  regressedCriteria: number
  /** Criteria observed at least twice, the population a regression appears in. */
  checkedCriteria: number
  /** Items the newest recorded plan holds. */
  plannedItems: number
  /** Items the newest recorded plan marks completed. */
  plannedDone: number
  /** Approval prompts put to a human for a decision. */
  interventions: number
  /**
   * Billed input and output tokens the settled assistant messages reported,
   * cache traffic included: the four buckets the token meter's `tokenUsage`
   * projection accumulates, which are the buckets the budget guard prices.
   */
  tokens: number
  /**
   * The same billed spend priced at the deployment's flat price, or null when
   * the deployment states no price.
   */
  spendUsd: number | null
  /** Failures the trace projection ends a run with as a detected loop. */
  loopFailures: number
  /** Delegated child runs this log received, one per `delegation/received`. */
  delegatedRuns: number
  /** Largest prompt side one settled message reported, cache traffic included. */
  promptPeakTokens: number
  /** Newest context window the session's own `request/context` records advertised, or null. */
  contextWindow: number | null
  /** Milliseconds the session's closed turns spanned. */
  latencyMs: number
}

/**
 * Fold one session's committed events into the facts the coding metrics read.
 * The kernel counters come from `readKernelMetrics` over the same events; the
 * rest is the ordered evidence no counter keeps.
 * @param sessionId - session identity.
 * @param events - the session's committed events, in sequence order.
 * @param usdPerMillionTokens - the deployment's price of one million billed tokens, or undefined when unpriced.
 * @returns the facts this log implies.
 */
export function readCodingSession(
  sessionId: string,
  events: readonly SessionEvent[],
  usdPerMillionTokens?: number,
): CodingSessionFacts {
  const kernel = readKernelMetrics(events)
  const passes = new Map<string, number[]>()
  const failures = new Map<string, number[]>()
  const completions: { taskId: string; at: number }[] = []
  const criteria = new Map<string, CriterionStatus[]>()
  const verifications: number[] = []
  const remarks: { at: number; contradicts: boolean }[] = []
  const openTurns = new Map<number, number>()
  const billed = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  let latencyMs = 0
  let plannedItems = 0
  let plannedDone = 0
  let interventions = 0
  let loopFailures = 0
  let delegatedRuns = 0
  let promptPeakTokens = 0
  let contextWindow: number | null = null
  let newestTime: number | null = null

  for (const event of events) {
    if (newestTime === null || event.time > newestTime) newestTime = event.time
    switch (event.type) {
      case 'task/transitioned':
        if (event.data.to === 'completed') {
          completions.push({ taskId: String(event.data.taskId), at: event.time })
        }
        break
      case 'verification/result': {
        verifications.push(event.time)
        const taskId = String(event.data.taskId)
        const status = event.data.status
        if (status === 'pass' || status === 'fail') {
          const times = status === 'pass' ? passes : failures
          const recorded = times.get(taskId)
          if (recorded === undefined) times.set(taskId, [event.time])
          else recorded.push(event.time)
        }
        for (const criterion of event.data.criterionResults) {
          const key = `${taskId}\u0000${criterion.criterionId}`
          const statuses = criteria.get(key)
          if (statuses === undefined) criteria.set(key, [criterion.status])
          else statuses.push(criterion.status)
        }
        break
      }
      case 'failure/recorded':
        if (LOOP_FAILURE_KINDS[event.data.kind] === true) loopFailures += 1
        break
      case 'delegation/received':
        delegatedRuns += 1
        break
      case 'request/context':
        if (event.data.contextWindow !== undefined) contextWindow = event.data.contextWindow
        break
      case 'feedback/record':
        remarks.push({
          at: event.time,
          contradicts: CONTRADICTING_REMARKS[event.data.category ?? 'other'] === true,
        })
        break
      case 'approval/asked':
        interventions += 1
        break
      case 'todo/write':
        plannedItems = event.data.todos.length
        plannedDone = event.data.todos.filter(todo => todo.status === PLANNED_DONE).length
        break
      case 'assistant/message': {
        const usage = event.data.usage
        if (usage !== undefined) {
          // The four billed buckets `dsh-token-meter` accumulates: its uncached
          // input is the prompt side, and a bucket the adapter omitted is zero.
          billed.uncachedInputTokens += usage.inputTokens
          billed.outputTokens += usage.outputTokens
          billed.cacheReadTokens += usage.cacheReadTokens ?? 0
          billed.cacheWriteTokens += usage.cacheWriteTokens ?? 0
          const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
          if (prompt > promptPeakTokens) promptPeakTokens = prompt
        }
        break
      }
      case 'turn/start':
        openTurns.set(event.data.turn, event.time)
        break
      case 'turn/end': {
        const started = openTurns.get(event.data.turn)
        if (started !== undefined) latencyMs += event.time - started
        break
      }
      default:
        break
    }
  }

  let regressedCriteria = 0
  let checkedCriteria = 0
  for (const statuses of criteria.values()) {
    if (statuses.length < 2) continue
    checkedCriteria += 1
    let passed = false
    for (const status of statuses) {
      if (status === 'pass') passed = true
      else if (status === 'fail' && passed) {
        regressedCriteria += 1
        break
      }
    }
  }

  const spend = spendOf(billed)
  return {
    sessionId,
    updatedAt: newestTime === null ? null : new Date(newestTime).toISOString(),
    kernel,
    certifiedCompletions: completions.filter(completion =>
      (passes.get(completion.taskId) ?? []).some(at => at <= completion.at)).length,
    contradictedCompletions: completions.filter(completion =>
      (failures.get(completion.taskId) ?? []).some(at => at > completion.at)
      || remarks.some(remark => remark.contradicts && remark.at > completion.at)).length,
    laterObservations: completions.reduce((total, completion) =>
      total
      + verifications.filter(at => at > completion.at).length
      + remarks.filter(remark => remark.at > completion.at).length, 0),
    regressedCriteria,
    checkedCriteria,
    plannedItems,
    plannedDone,
    interventions,
    tokens: spend?.totalTokens ?? 0,
    spendUsd: costUsd(spend, usdPerMillionTokens) ?? null,
    loopFailures,
    delegatedRuns,
    promptPeakTokens,
    contextWindow,
    latencyMs,
  }
}

/** Unit and order of the readings: the nine §13.2 coding metrics, the §5.4 baseline readings, then the §18.3 kernel counters. */
const CODING_UNITS: readonly (readonly [CodingMetricId, MetricUnit])[] = [
  ['verified-success', 'share'],
  ['false-completion', 'share'],
  ['regression-rate', 'share'],
  ['recovery-efficiency', 'ratio'],
  ['planning-fidelity', 'share'],
  ['verification-coverage', 'share'],
  ['human-intervention', 'ratio'],
  ['cost', 'usd'],
  ['average-tokens', 'tokens'],
  ['latency', 'milliseconds'],
  ['loop-rate', 'share'],
  ['tool-failure-rate', 'share'],
  ['subagent-waste', 'share'],
  ['context-utilization', 'share'],
  ['verified-success-per-usd', 'count-per-usd'],
  ['verified-success-per-million-tokens', 'count-per-million-tokens'],
  ['verified-success-per-10-minutes', 'count-per-10-minutes'],
  ['task-success-rate', 'share'],
  ['verification-pass-rate', 'share'],
  ['steps', 'count'],
  ['tool-calls', 'count'],
  ['policy-denials', 'count'],
  ['approval-rejections', 'count'],
  ['checkpoint-resume-rate', 'share'],
]

/**
 * The readings over one window of folded sessions. A metric whose records the
 * window does not hold is returned unmeasurable with the missing record named,
 * so a reader can tell "nothing went wrong" from "nothing observed it".
 * @param sessions - the window's folded sessions, in any order.
 * @param gap - why the window is empty, reported by every metric when it is.
 * @returns the readings, in spec order.
 */
export function codingMetrics(sessions: readonly CodingSessionFacts[], gap: string): readonly MetricValue[] {
  if (sessions.length === 0) return CODING_UNITS.map(([id, unit]) => unavailable(id, unit, [LOG_INPUT], gap))
  const sum = (of: (facts: CodingSessionFacts) => number): number =>
    sessions.reduce((total, facts) => total + of(facts), 0)
  const terminal = sum(facts => Object.values(facts.kernel.taskOutcomes).reduce((total, count) => total + count, 0))
  const completed = sum(facts => facts.kernel.taskOutcomes.completed ?? 0)
  const tasksCreated = sum(facts => facts.kernel.tasksCreated)
  const recordedFailures = sum(facts =>
    Object.values(facts.kernel.failuresByKind).reduce((total, count) => total + count, 0))
  const answeredFailures = recordedFailures - sum(facts => facts.kernel.failuresWithoutRecovery)
  const certified = sum(facts => facts.certifiedCompletions)
  const contradicted = sum(facts => facts.contradictedCompletions)
  const laterObservations = sum(facts => facts.laterObservations)
  const regressedCriteria = sum(facts => facts.regressedCriteria)
  const checkedCriteria = sum(facts => facts.checkedCriteria)
  const plannedItems = sum(facts => facts.plannedItems)
  const plannedDone = sum(facts => facts.plannedDone)
  const interventions = sum(facts => facts.interventions)
  const verifiedSessions = sessions.filter(facts => facts.kernel.verifications > 0).length
  const taskSessions = sessions.filter(facts => facts.kernel.tasksCreated > 0).length
  const loopSessions = sessions.filter(facts => facts.loopFailures > 0).length
  const toolCalls = sum(facts => facts.kernel.toolCalls)
  const actionsFailed = sum(facts => facts.kernel.actionsFailed)
  const steps = sum(facts => facts.kernel.steps)
  const verifications = sum(facts => facts.kernel.verifications)
  const verificationsPassed = sum(facts => facts.kernel.verificationsPassed)
  const policyDenied = sum(facts => facts.kernel.policyDenied)
  const approvalsRejected = sum(facts => facts.kernel.approvalsRejected)
  const checkpoints = sum(facts => facts.kernel.checkpoints)
  const checkpointResumes = sum(facts => facts.kernel.checkpointResumes)
  const delegatedRuns = sum(facts => facts.delegatedRuns)
  // A child log that reached no completed task spent its delegation without a
  // result to hand back; the receipt and the task it opened share one session.
  const wastedRuns = sessions.reduce((total, facts) =>
    facts.delegatedRuns > 0 && (facts.kernel.taskOutcomes.completed ?? 0) === 0
      ? total + facts.delegatedRuns
      : total, 0)
  const measuredOccupancy = sessions.filter(facts => facts.contextWindow !== null && facts.promptPeakTokens > 0)
  const occupiedTokens = measuredOccupancy.reduce((total, facts) => total + facts.promptPeakTokens, 0)
  const windowTokens = measuredOccupancy.reduce((total, facts) => total + (facts.contextWindow ?? 0), 0)
  const tokens = sum(facts => facts.tokens)
  const usd = sum(facts => facts.spendUsd ?? 0)
  // The price is one deployment choice, so a window with no priced session is
  // unpriced rather than partially billed.
  const unpriced = sessions.some(facts => facts.spendUsd === null)
  const latencyMs = sum(facts => facts.latencyMs)
  const successGap = terminal === 0
    ? 'no task in the window reached a terminal status: `task/transitioned` records the statuses this rate counts over'
    : null
  // A zero denominator is not a measurement: each ratio is undefined there, so
  // the reading names the missing record instead of reporting an infinity.
  const perUsd = unpriced ? undefined : ratio(certified, usd)
  const perMillionTokens = gainPerMillionTokens(certified, tokens)
  const perTenMinutes = ratio(certified * MS_PER_TEN_MINUTES, latencyMs)

  return [
    rate(
      'verified-success',
      'share',
      certified,
      terminal,
      [`${LOG_INPUT} — task/transitioned to completed, paired by taskId with a passing verification/result`,
        `${COUNTER_INPUT}.taskOutcomes`],
      'no task in the window reached a terminal status: `task/transitioned` records the statuses this rate counts over',
      'the pairing is per taskId inside one session, and a completion whose class required no criterion '
      + 'counts against the rate because no verification certified it',
    ),
    completed === 0
      ? unavailable(
        'false-completion',
        'share',
        [LATER_INPUT],
        'no completion is recorded: `task/transitioned` to `completed` is the record a contradiction is paired with',
      )
      : laterObservations === 0
        ? unavailable(
          'false-completion',
          'share',
          [LATER_INPUT],
          'no verification or human remark was recorded after a completion, so nothing could contradict one: the '
          + 'kernel appends `verification/result` only when its completion gate runs again, and `feedback/record` '
          + 'only when a human files a remark after the work was reported done',
        )
        : metric(
          'false-completion',
          // The denominator is nonzero on this path: the branch above returned
          // for a window that recorded no completion.
          contradicted / completed,
          'share',
          [LATER_INPUT],
          'a completion counts as false when a later `verification/result` for the same task failed, or when a '
          + 'remark filed under `task-result` or `instruction-following` followed it; a contradiction nobody '
          + 'recorded is not counted',
        ),
    rate(
      'regression-rate',
      'share',
      regressedCriteria,
      checkedCriteria,
      [`${LOG_INPUT} — verification/result.criterionResults, one criterion\'s statuses in log order`],
      'no criterion is observed twice in the window: a regression needs a second run of the same criterion, '
      + 'recorded as another `verification/result`',
      'each criterion counts once per session, and the statuses come from the verifiers the deployment '
      + 'registered — with none registered every criterion reports `unknown` and no regression is visible',
    ),
    rate(
      'recovery-efficiency',
      'ratio',
      answeredFailures,
      recordedFailures,
      [`${COUNTER_INPUT}.failuresByKind / failuresWithoutRecovery`],
      'no failure is recorded: `failure/recorded` is the record this rate counts over',
      'the rate is the share of failures a `recovery/decided` record answered; nothing records whether the '
      + 'recorded action repaired the failure',
    ),
    rate(
      'planning-fidelity',
      'share',
      plannedDone,
      plannedItems,
      [`${LOG_INPUT} — todo/write.todos.status`],
      'no plan with tracked statuses is recorded: the reading needs a `todo/write` snapshot, and the kernel’s '
      + '`task/plan` revision carries steps without a per-step status',
      'the statuses are the model’s own `todo_write` bookkeeping, not an observation of the work, and the '
      + 'newest snapshot of a session is the one read',
    ),
    rate(
      'verification-coverage',
      'share',
      verifiedSessions,
      taskSessions,
      [`${COUNTER_INPUT}.verifications`, `${COUNTER_INPUT}.tasksCreated`],
      'no session in the window opened a task: `task/created` is the record this rate counts over',
      'the rate is session-scoped: the kernel counters do not pair a verification with the task it examined, '
      + 'so a session counts as covered once any verification ran in it',
    ),
    rate(
      'human-intervention',
      'ratio',
      interventions,
      tasksCreated,
      [`${LOG_INPUT} — approval/asked`, `${COUNTER_INPUT}.tasksCreated`],
      'no task is recorded in the window: `task/created` is the record this rate counts over',
      'the rate counts the approval questions put to a human, so an answerer that decided without a person '
      + 'still counts; a remark filed after the fact is not counted',
    ),
    tokens === 0
      ? unavailable(
        'cost',
        'usd',
        [BILLED_INPUT, PRICE_INPUT],
        'no settled assistant message reported usage: `assistant/message.usage` is the record this reading prices',
      )
      : unpriced
        ? unavailable('cost', 'usd', [BILLED_INPUT, PRICE_INPUT], UNPRICED)
        : metric(
          'cost',
          usd / sessions.length,
          'usd',
          [BILLED_INPUT, PRICE_INPUT],
          'billed spend per session at the deployment\'s one flat price, cache traffic included; a session whose '
          + 'adapter reported no usage contributes zero, and a per-route catalog price is not applied',
        ),
    tokens === 0
      ? unavailable(
        'average-tokens',
        'tokens',
        [BILLED_INPUT],
        'no settled assistant message reported usage: `assistant/message.usage` is the record this reading sums',
      )
      : metric(
        'average-tokens',
        tokens / sessions.length,
        'tokens',
        [BILLED_INPUT],
        'billed input, cache, and completion tokens per session; a session whose adapter reported no usage '
        + 'contributes zero',
      ),
    latencyMs === 0
      ? unavailable(
        'latency',
        'milliseconds',
        [`${LOG_INPUT} — turn/start and turn/end timestamps`],
        'no closed turn is recorded: `turn/start` and `turn/end` are the records this reading spans',
      )
      : metric(
        'latency',
        latencyMs / sessions.length,
        'milliseconds',
        [`${LOG_INPUT} — turn/start and turn/end timestamps`],
        'the summed span of closed turns per session; an open turn and the time outside turns are excluded',
      ),
    rate(
      'loop-rate',
      'share',
      loopSessions,
      taskSessions,
      [`${COUNTER_INPUT}.failuresByKind`, `${COUNTER_INPUT}.tasksCreated`],
      'no session in the window opened a task: `task/created` is the record this rate counts over',
      'the rate is session-scoped: the kernel counters do not pair a failure with the run it ended, so a session '
      + 'counts once when it recorded a `no-progress` or `stalled` failure — the two kinds the trace projection '
      + 'reads as `loop_detected`',
    ),
    rate(
      'tool-failure-rate',
      'share',
      actionsFailed,
      toolCalls,
      [`${COUNTER_INPUT}.toolCalls / actionsFailed`],
      'no tool call is recorded: `tool/call` is the record this rate counts over',
      'the denominator is every `tool/call` the window recorded and the numerator every `action/committed` '
      + 'receipt that reported `failed`; a call refused before any action existed and an action a workflow or '
      + 'subagent proposed are counted on one side only',
    ),
    rate(
      'subagent-waste',
      'share',
      wastedRuns,
      delegatedRuns,
      [`${LOG_INPUT} — delegation/received`, `${COUNTER_INPUT}.taskOutcomes`],
      'no delegated child run is recorded: `delegation/received` is the record this rate counts over',
      'a delegated child counts as waste when the session that received it reached no `completed` task status; '
      + 'nothing records whether the parent used a completed child\'s result',
    ),
    rate(
      'context-utilization',
      'share',
      occupiedTokens,
      windowTokens,
      [OCCUPANCY_INPUT],
      'no request reported both a prompt size and a context window: `assistant/message.usage` and '
      + '`request/context.contextWindow` are the records this reading pairs',
      'the numerator is the largest prompt side one settled message reported and the denominator the newest '
      + 'window the log advertised, so the two are not one request observation',
    ),
    successGap !== null
      ? unavailable('verified-success-per-usd', 'count-per-usd', [BILLED_INPUT, PRICE_INPUT], successGap)
      : perUsd === undefined
        ? unavailable(
          'verified-success-per-usd',
          'count-per-usd',
          [BILLED_INPUT, PRICE_INPUT],
          unpriced ? UNPRICED : 'the window recorded no priced spend',
        )
        : metric(
          'verified-success-per-usd',
          perUsd,
          'count-per-usd',
          [BILLED_INPUT, PRICE_INPUT],
          'verified successes per dollar of billed spend at the deployment\'s flat price; the numerator is the '
          + 'certified completions of the verified-success rate and carries its pairing caveat',
        ),
    successGap !== null
      ? unavailable('verified-success-per-million-tokens', 'count-per-million-tokens', [BILLED_INPUT], successGap)
      : perMillionTokens === undefined
        ? unavailable(
          'verified-success-per-million-tokens',
          'count-per-million-tokens',
          [BILLED_INPUT],
          'the window spent no billed tokens',
        )
        : metric(
          'verified-success-per-million-tokens',
          perMillionTokens,
          'count-per-million-tokens',
          [BILLED_INPUT],
          'verified successes per million billed tokens; the numerator is the certified completions of the '
          + 'verified-success rate and carries its pairing caveat',
        ),
    successGap !== null
      ? unavailable(
        'verified-success-per-10-minutes',
        'count-per-10-minutes',
        [`${LOG_INPUT} — turn/start and turn/end timestamps`],
        successGap,
      )
      : perTenMinutes === undefined
        ? unavailable(
          'verified-success-per-10-minutes',
          'count-per-10-minutes',
          [`${LOG_INPUT} — turn/start and turn/end timestamps`],
          'no closed turn is recorded: `turn/start` and `turn/end` are the records this reading spans',
        )
        : metric(
          'verified-success-per-10-minutes',
          perTenMinutes,
          'count-per-10-minutes',
          [`${LOG_INPUT} — turn/start and turn/end timestamps`],
          'verified successes per ten minutes of closed turns; the denominator is the summed span of closed '
          + 'turns, not elapsed clock time, and the numerator carries the verified-success pairing caveat',
        ),
    rate(
      'task-success-rate',
      'share',
      completed,
      terminal,
      [`${COUNTER_INPUT}.taskOutcomes`],
      'no task in the window reached a terminal status: `task/transitioned` records the statuses this rate counts over',
      'every task that reached a terminal status counts, certified or not; the share of completions a passing '
      + 'verification certified is the verified-success rate beside it',
    ),
    rate(
      'verification-pass-rate',
      'share',
      verificationsPassed,
      verifications,
      [`${COUNTER_INPUT}.verifications / verificationsPassed`],
      'no verification result is recorded: `verification/result` is the record this rate counts over',
      'a `pass` and a `fail` count alike, and a status of neither moves neither side, so the rate moves only '
      + 'where a verifier judged the work',
    ),
    metric(
      'steps',
      steps,
      'count',
      [`${COUNTER_INPUT}.steps`],
      'model steps (`step/start`) summed over the window, so a longer window counts more; the window\'s '
      + '`sessions` is the population to divide by for a per-session figure',
    ),
    metric(
      'tool-calls',
      toolCalls,
      'count',
      [`${COUNTER_INPUT}.toolCalls`],
      'every `tool/call` the window recorded, including a call no action ever settled; the tool-failure rate '
      + 'beside it counts only the actions whose own receipt reported a verdict',
    ),
    metric(
      'policy-denials',
      policyDenied,
      'count',
      [`${COUNTER_INPUT}.policyDenied`],
      'composed policy decisions whose effect was `deny`; a capability refusal and a sandbox refusal both arrive '
      + 'as one policy decision, so the two families are not separable from the log',
    ),
    metric(
      'approval-rejections',
      approvalsRejected,
      'count',
      [`${COUNTER_INPUT}.approvalsRejected`],
      'human answers that were not `allowed-once`; an answerer that decided without a person is not counted, and '
      + 'the prompts behind them are the human-intervention rate',
    ),
    rate(
      'checkpoint-resume-rate',
      'share',
      checkpointResumes,
      checkpoints,
      [`${COUNTER_INPUT}.checkpoints / checkpointResumes`],
      'no checkpoint is recorded: `checkpoint/recorded` is the record this rate counts over',
      'the counters do not pair a resume with the checkpoint it resumed, so a session that checkpointed and '
      + 'resumed more than once contributes both sides more than once',
    ),
  ]
}
