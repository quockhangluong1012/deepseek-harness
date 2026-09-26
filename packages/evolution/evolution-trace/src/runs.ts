/**
 * Projection of one committed session log into its runs' execution traces
 * (§5.1 Agent Trace): the run's identity and bounds, its steps with the §5.2
 * telemetry, its tool calls, delegated subagents, spend, context placements,
 * verification results, and how it ended.
 *
 * The run boundary is the kernel's `task/created` record: a log that never
 * recorded one holds no run, and a conversation that opened several tasks holds
 * one trace per run. Nothing is written: the session log stays the single
 * authoritative copy, and this module derives the trace from it on every read.
 * @module @deepseek-ai/dsh-evolution-trace/src/runs
 */

import type { LlmModelCost, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventType } from '@deepseek-ai/dsh-session'
import type { FailureKind, ResourceBudget, TaskStatus, TransitionKind } from '@deepseek-ai/dsh-agent-kernel'
import { project, sumUsage } from './project.ts'
import type {
  AgentRunStatus,
  AgentTrace,
  BudgetTrace,
  TraceStep,
  TraceSubagent,
  VerificationTrace,
} from './types.ts'

/**
 * Events that show a run doing new work. A stop record stops deciding the run's
 * status once one of these follows it: the run recovered or continued. The
 * kernel's own reaction records (`recovery/*`, transitions, checkpoints) do not
 * count, or every recorded failure would erase its own reading.
 */
const ACTIVITY_EVENTS: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
  'step/start',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
])

/**
 * The budget guard's ceiling record: the step the guard rejected at a reached
 * ceiling, written immediately before the turn closes `blocked`.
 * `dsh-budgets` merges this event into `SessionEventMap`, but its package entry
 * does not surface that module, so a consumer reading the built package cannot
 * name the payload type. The trace reads the record's event name and instant,
 * both fixed by the log format.
 */
const BUDGET_EXCEEDED_EVENT = 'budget/exceeded'

/** One run under construction while the log is walked. */
interface BuildRun {
  runId: string
  taskId: string
  profile: string
  startedAt: string
  limits: ResourceBudget
  /** Newest event time inside the run's span. */
  newestTime: number
  /** The run's current task status, from the newest transition. */
  status: TaskStatus
  /** The newest transition's trigger. */
  statusTrigger: TransitionKind
  /** ISO-8601 instant of the newest transition. */
  statusAt: string | null
  /** `turn`.`step` keys of the run's steps, in open order. */
  stepKeys: string[]
  subagents: TraceSubagent[]
  verifications: VerificationTrace[]
  digests: string[]
  peakTokens: number
  /** The newest `turn/end` of the run that still stands. */
  lastTurnEnd: { kind: string; code: string | null; at: string } | null
  /** The newest stop record of the run that still stands. */
  lastStop: { status: AgentRunStatus; at: string } | null
}

/** One ending a run's records give it, with the record's instant. */
interface RunEnd {
  status: AgentRunStatus
  endedAt: string
}

/** The status one settled task status gives an ended run, or null when it ends nothing. */
function statusOfTask(status: TaskStatus, trigger: TransitionKind): AgentRunStatus | null {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'failure'
    case 'cancelled':
      return 'cancelled'
    // The completion gate refused every criterion it was given and handed the
    // task to a human: the run ended without meeting its criteria.
    case 'awaiting-user':
      return 'failure'
    case 'paused':
      return trigger === 'budget-exhausted' ? 'budget_exceeded' : null
    case 'intake':
    case 'planning':
    case 'ready':
    case 'executing':
    case 'observing':
    case 'verifying':
    case 'recovering':
    case 'awaiting-approval':
      return null
  }
}

/**
 * The status one turn end gives an ended run, or null when the reason ends
 * nothing by itself. `max-steps` is the loop's step ceiling and `max-tokens` its
 * output ceiling: both cut the run short at a configured limit, which is the
 * budget member of the status vocabulary.
 */
function statusOfTurnEnd(kind: string, code: string | null): AgentRunStatus | null {
  switch (kind) {
    case 'aborted':
      return 'cancelled'
    case 'max-steps':
    case 'max-tokens':
      return 'budget_exceeded'
    case 'error':
      return code === 'TIMEOUT' ? 'timeout' : 'failure'
    case 'completed':
    case 'blocked':
    case 'interrupted':
    case 'forked':
      return null
    // The reason map is merge-extensible: a reason this module does not know
    // ends no run by itself, and the run's stop records decide instead.
    default:
      return null
  }
}

/** The status one classified failure gives an ended run. */
function statusOfFailure(kind: FailureKind): AgentRunStatus {
  switch (kind) {
    case 'budget-exhausted':
    case 'step-ceiling':
      return 'budget_exceeded'
    case 'no-progress':
    case 'stalled':
      return 'loop_detected'
    case 'timeout':
      return 'timeout'
    // Every other kind — model, tool, sandbox, approval, stale write,
    // verification, subagent, workflow, persistence, injection, truncation —
    // ends the run as a failure.
    default:
      return 'failure'
  }
}

/**
 * The ending the run's own records give it, or null while none does: the
 * status the kernel last moved it to when that status is decisive, else the
 * run's newest standing turn end, else its newest standing stop record.
 * @param run - the run after the log was walked.
 * @returns the ending and the instant of the record that decided it, or null.
 */
function endOfRun(run: BuildRun): RunEnd | null {
  const byStatus = statusOfTask(run.status, run.statusTrigger)
  if (byStatus !== null) return { status: byStatus, endedAt: run.statusAt ?? run.startedAt }
  if (run.lastTurnEnd !== null) {
    const byTurn = statusOfTurnEnd(run.lastTurnEnd.kind, run.lastTurnEnd.code)
    if (byTurn !== null) return { status: byTurn, endedAt: run.lastTurnEnd.at }
  }
  if (run.lastStop !== null) return { status: run.lastStop.status, endedAt: run.lastStop.at }
  return null
}

/**
 * Billed tokens of one summed usage sample: prompt plus completion, with the
 * cache buckets the provider reported. The same billed total `dsh-usage-ledger`
 * prices.
 * @param usage - the run's summed usage, or null when no step reported one.
 * @returns the billed token count.
 */
function billedTokens(usage: TokenUsage | null): number {
  if (usage === null) return 0
  return usage.inputTokens
    + usage.outputTokens
    + (usage.cacheReadTokens ?? 0)
    + (usage.cacheWriteTokens ?? 0)
}

/** Sum the run's steps into the spend the trace reports. */
function budgetOfRun(run: BuildRun, steps: readonly TraceStep[], newestTime: number): BudgetTrace {
  const priced = steps.map(step => step.estimatedCostUsd).filter(cost => cost !== null)
  return {
    limits: run.limits,
    steps: steps.length,
    toolCalls: steps.reduce((total, step) => total + step.calls.length, 0),
    tokens: billedTokens(sumUsage(steps.map(step => step.usage))),
    wallMs: Math.max(0, newestTime - Date.parse(run.startedAt)),
    costUsd: priced.length === 0 ? null : priced.reduce((total, cost) => total + cost, 0),
    childDepth: run.subagents.reduce((deepest, subagent) => Math.max(deepest, subagent.depth), 0),
  }
}

/**
 * Project one session's committed log into its runs' execution traces.
 * @param sessionId - session identity.
 * @param events - committed events in sequence order.
 * @param maxChars - character budget for one step gist, as {@link project} applies it.
 * @param prices - catalog price of each route the log ran under, keyed by `routeKey`; absent leaves every step unpriced.
 * @returns one trace per run the log recorded, oldest first; empty when it recorded no task.
 */
export function projectRuns(
  sessionId: string,
  events: readonly SessionEvent[],
  maxChars: number,
  prices?: ReadonlyMap<string, LlmModelCost>,
): readonly AgentTrace[] {
  const trace = project(sessionId, events, maxChars, prices)
  const steps = new Map<string, TraceStep>()
  for (const turn of trace.turns) {
    for (const step of turn.steps) steps.set(`${String(turn.turn)}.${String(step.step)}`, step)
  }
  const runs: BuildRun[] = []
  let current: BuildRun | undefined
  let openTurn: number | null = null
  let openStep: number | null = null

  for (const event of events) {
    if (event.type === 'task/created') {
      const contract = event.data
      current = {
        runId: String(contract.runId),
        taskId: String(contract.taskId),
        profile: contract.agentProfile,
        startedAt: new Date(event.time).toISOString(),
        limits: contract.budget,
        newestTime: event.time,
        status: contract.status,
        statusTrigger: 'task-intake',
        statusAt: null,
        stepKeys: [],
        subagents: [],
        verifications: [],
        digests: [],
        peakTokens: 0,
        lastTurnEnd: null,
        lastStop: null,
      }
      runs.push(current)
      continue
    }
    if (current === undefined) continue
    current.newestTime = event.time
    if (ACTIVITY_EVENTS.has(event.type)) {
      current.lastTurnEnd = null
      current.lastStop = null
    }
    const eventType: string = event.type
    switch (event.type) {
      case 'turn/start': {
        openTurn = event.data.turn
        openStep = null
        break
      }
      case 'step/start': {
        current.stepKeys.push(`${String(event.data.turn)}.${String(event.data.step)}`)
        openStep = event.data.step
        break
      }
      case 'step/end': {
        openStep = null
        break
      }
      case 'turn/end': {
        openTurn = null
        openStep = null
        current.lastTurnEnd = {
          kind: event.data.reason.kind,
          code: event.data.reason.kind === 'error' ? event.data.reason.error.code : null,
          at: new Date(event.time).toISOString(),
        }
        break
      }
      case 'task/transitioned': {
        current.status = event.data.to
        current.statusTrigger = event.data.trigger.kind
        current.statusAt = new Date(event.time).toISOString()
        break
      }
      case 'failure/recorded': {
        current.lastStop = { status: statusOfFailure(event.data.kind), at: new Date(event.time).toISOString() }
        break
      }
      default: {
        // The budget guard's own ceiling outranks nothing and supersedes
        // nothing: it is one more stop record, and the newest one wins.
        if (eventType === BUDGET_EXCEEDED_EVENT) {
          current.lastStop = { status: 'budget_exceeded', at: new Date(event.time).toISOString() }
        }
        break
      }
      case 'delegation/issued': {
        current.subagents.push({
          delegationId: String(event.data.delegationId),
          runId: String(event.data.childRunId),
          depth: event.data.depth,
          limits: event.data.resourceLimits,
          capabilities: event.data.allowedCapabilities,
          turn: openTurn,
          step: openStep,
          issuedAt: new Date(event.time).toISOString(),
        })
        break
      }
      case 'verification/result': {
        current.verifications.push({ ...event.data, at: new Date(event.time).toISOString() })
        break
      }
      case 'context/compiled': {
        current.digests.push(event.data.digest)
        current.peakTokens = Math.max(current.peakTokens, event.data.tokenEstimate)
        break
      }
    }
  }

  return runs.map((run) => {
    const runSteps: TraceStep[] = []
    for (const key of run.stepKeys) {
      const step = steps.get(key)
      if (step !== undefined) runSteps.push(step)
    }
    const end = endOfRun(run)
    return {
      runId: run.runId,
      sessionId,
      taskId: run.taskId,
      profile: run.profile,
      startedAt: run.startedAt,
      endedAt: end?.endedAt ?? null,
      steps: runSteps,
      toolCalls: runSteps.flatMap(step => step.calls),
      subagents: run.subagents,
      budget: budgetOfRun(run, runSteps, run.newestTime),
      context: { compilations: run.digests.length, digests: run.digests, peakTokens: run.peakTokens },
      verification: run.verifications,
      finalStatus: end?.status ?? null,
    }
  })
}
