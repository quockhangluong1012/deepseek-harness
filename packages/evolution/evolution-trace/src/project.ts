/**
 * Pure projection of a committed session log into its structured learning
 * trace. The session log is the authoritative immutable raw trace; this module
 * derives the machine-readable form (§3.3) and attaches ranked root-cause
 * candidates to every failed tool call (§3.2).
 *
 * Credit assignment here is a deterministic proximity heuristic, never a model
 * judgment: the failing call ranks first, then the calls that produced its
 * input (same step, then the previous step), then retrieval calls that may
 * have missed, then the turn's request. An analyst can later replace the
 * ranking with measured attribution; the schema is stable either way.
 * @module @deepseek-ai/dsh-evolution-trace/src/project
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { truncateUtf8 } from '@deepseek-ai/dsh-evolution-memory'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  TraceCause,
  TraceFailure,
  TraceRecord,
  TraceStep,
  TraceToolCall,
  TraceTurn,
} from './types.ts'

/** Whether one tool name counts as a retrieval surface for credit assignment. */
function isRetrieval(name: string): boolean {
  return /skill|memory/iu.test(name)
}

/**
 * Join the visible text of one content-block list; non-text blocks contribute
 * nothing.
 * @param content - the block list.
 * @returns the newline-joined text blocks.
 */
function textOf(content: readonly ContentBlock[]): string {
  return content
    .map(part => (part.type === 'text' ? part.text : ''))
    .filter(text => text.length > 0)
    .join('\n')
}

/** One failure pending its root-cause pass, with its call position in the step. */
interface PendingFailure {
  callId: string
  tool: string
  message: string
  at: string
  turn: number
  step: number
  /** Position of the failing call in its step's call list, for before/after ordering. */
  callIndex: number
}

/** One step under construction. */
interface BuildStep {
  turn: number
  step: number
  startedAt: string
  finishedAt: string | null
  interrupted: boolean
  retries: number
  usage: TraceStep['usage']
  calls: TraceToolCall[]
}

/** One turn under construction. */
interface BuildTurn {
  turn: number
  startedAt: string
  endedAt: string | null
  endReason: string | null
  request: string | null
  steps: Map<number, BuildStep>
  /** Steps in first-open order. */
  stepOrder: number[]
  failures: PendingFailure[]
}

/** One dispatched but not yet settled tool call. */
interface PendingCall {
  name: string
  turn: number
  step: number
}

/**
 * Project one session's committed events into its structured learning trace.
 * Events are consumed in sequence order; unpaired calls and results, messages
 * before a turn opens, and trace-irrelevant events are dropped.
 * @param sessionId - session identity.
 * @param events - committed events in sequence order.
 * @param maxChars - character budget for one failure or request gist.
 * @returns the structured trace.
 */
export function project(sessionId: string, events: readonly SessionEvent[], maxChars: number): TraceRecord {
  const turns = new Map<number, BuildTurn>()
  const turnOrder: number[] = []
  let openTurn: BuildTurn | undefined
  const pendingCalls = new Map<string, PendingCall>()
  let newestTime = -1

  const markTime = (time: number): void => {
    if (time > newestTime) newestTime = time
  }
  const stepOf = (turn: number, step: number): BuildStep | undefined => {
    return turns.get(turn)?.steps.get(step)
  }
  const enhanceTime = (built: BuildStep, time: number): void => {
    built.finishedAt = new Date(time).toISOString()
  }

  for (const event of events) {
    markTime(event.time)
    switch (event.type) {
      case 'turn/start': {
        const turn = event.data.turn
        let built = turns.get(turn)
        if (built === undefined) {
          built = {
            turn,
            startedAt: new Date(event.time).toISOString(),
            endedAt: null,
            endReason: null,
            request: null,
            steps: new Map(),
            stepOrder: [],
            failures: [],
          }
          turns.set(turn, built)
          turnOrder.push(turn)
        }
        openTurn = built
        break
      }
      case 'user/message': {
        if (openTurn === undefined || openTurn.request !== null) break
        const gist = truncateUtf8(textOf(event.data.content).replace(/\s+/gu, ' ').trim(), maxChars)
        openTurn.request = gist.length === 0 ? null : gist
        break
      }
      case 'step/start': {
        const built = stepOf(event.data.turn, event.data.step)
        if (built !== undefined) break
        const turn = turns.get(event.data.turn)
        if (turn === undefined) break
        const step: BuildStep = {
          turn: event.data.turn,
          step: event.data.step,
          startedAt: new Date(event.time).toISOString(),
          finishedAt: null,
          interrupted: false,
          retries: 0,
          usage: null,
          calls: [],
        }
        turn.steps.set(step.step, step)
        turn.stepOrder.push(step.step)
        break
      }
      case 'assistant/message': {
        const built = stepOf(event.data.turn, event.data.step)
        if (built === undefined) break
        built.usage = event.data.usage ?? built.usage
        if (event.data.interrupted === true) built.interrupted = true
        enhanceTime(built, event.time)
        break
      }
      case 'assistant/attempt': {
        const built = stepOf(event.data.turn, event.data.step)
        if (built === undefined) break
        built.retries += 1
        enhanceTime(built, event.time)
        break
      }
      case 'tool/call': {
        pendingCalls.set(String(event.data.callId), {
          name: event.data.name,
          turn: event.data.turn,
          step: event.data.step,
        })
        break
      }
      case 'tool/result': {
        const pending = pendingCalls.get(String(event.data.message.source.callId))
        if (pending !== undefined) {
          pendingCalls.delete(String(event.data.message.source.callId))
        }
        const built = stepOf(event.data.turn, event.data.step)
        if (pending === undefined || built === undefined) break
        const block = event.data.message.content[0]
        const isError = block.isError === true
        const message = isError
          ? truncateUtf8(textOf(block.content).replace(/\s+/gu, ' ').trim(), maxChars) || event.data.error?.code || ''
          : null
        const at = new Date(event.time).toISOString()
        const call: TraceToolCall = {
          callId: String(event.data.message.source.callId),
          name: pending.name,
          ok: !isError,
          errorName: event.data.error?.name ?? null,
          errorCode: event.data.error?.code ?? null,
          message,
          at,
        }
        const callIndex = built.calls.length
        built.calls.push(call)
        if (isError) {
          const turn = turns.get(pending.turn)
          if (turn !== undefined) {
            turn.failures.push({
              callId: call.callId,
              tool: call.name,
              message: message || pending.name,
              at,
              turn: pending.turn,
              step: pending.step,
              callIndex,
            })
          }
        }
        enhanceTime(built, event.time)
        break
      }
      case 'turn/end': {
        const built = turns.get(event.data.turn)
        if (built === undefined) break
        built.endedAt = new Date(event.time).toISOString()
        built.endReason = event.data.reason.kind
        break
      }
      default:
        break
    }
  }

  const tracedTurns: TraceTurn[] = turnOrder
    .map(turn => toTraceTurn(turns.get(turn) as BuildTurn))
  return {
    sessionId,
    updatedAt: newestTime === -1 ? null : new Date(newestTime).toISOString(),
    turnCount: tracedTurns.length,
    turns: tracedTurns,
    usage: sumUsage(tracedTurns.flatMap(turn => turn.steps.map(step => step.usage))),
  }
}

/** Build one turn's final shape, attaching ranked causes to each failure. */
function toTraceTurn(turn: BuildTurn): TraceTurn {
  const steps: TraceStep[] = turn.stepOrder.map((step) => {
    const built = turn.steps.get(step) as BuildStep
    const failures = built.calls.filter(call => !call.ok).length
    return {
      turn: built.turn,
      step: built.step,
      startedAt: built.startedAt,
      finishedAt: built.finishedAt,
      interrupted: built.interrupted,
      retries: built.retries,
      usage: built.usage,
      calls: built.calls,
      failures,
    }
  })
  const failures: TraceFailure[] = turn.failures.map(failure => ({
    callId: failure.callId,
    tool: failure.tool,
    message: failure.message,
    at: failure.at,
    causes: causesOf(failure, turn),
  }))
  return {
    turn: turn.turn,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    endReason: turn.endReason,
    latencyMs: turn.endedAt === null ? null : Date.parse(turn.endedAt) - Date.parse(turn.startedAt),
    request: turn.request,
    steps,
    failures,
  }
}

/**
 * Rank one failure's root-cause candidates by proximity, most likely first:
 * the failing call itself, the same-step calls before it (its input
 * producers), the previous step's calls (the context producer), retrieval
 * calls that may have missed, then the turn's request. A missing context level
 * simply drops out of the ranking.
 * @param failure - the failure being attributed.
 * @param turn - the owning turn after its full projection.
 * @returns the ranked candidates.
 */
function causesOf(failure: PendingFailure, turn: BuildTurn): TraceCause[] {
  const causes: TraceCause[] = [{
    kind: 'tool',
    turn: failure.turn,
    step: failure.step,
    tool: failure.tool,
    reason: 'the call itself failed',
  }]
  const own = turn.steps.get(failure.step)
  if (own !== undefined) {
    for (const call of own.calls.slice(0, failure.callIndex)) {
      causes.push({
        kind: 'tool',
        turn: failure.turn,
        step: own.step,
        tool: call.name,
        reason: 'an earlier call in the same step may have produced the failing input',
      })
    }
  }
  const previous = turn.steps.get(failure.step - 1)
  if (previous !== undefined) {
    for (const call of previous.calls) {
      causes.push({
        kind: 'tool',
        turn: failure.turn,
        step: previous.step,
        tool: call.name,
        reason: 'the previous step produced the context this call consumed',
      })
    }
  }
  for (const step of turn.stepOrder) {
    if (step > failure.step) break
    const built = turn.steps.get(step) as BuildStep
    for (const call of built.calls) {
      if (call.callId === failure.callId) continue
      if (!isRetrieval(call.name)) continue
      causes.push({
        kind: 'retrieval',
        turn: failure.turn,
        step: built.step,
        tool: call.name,
        reason: 'retrieval may have missed the knowledge this call needed',
      })
    }
  }
  if (turn.request !== null) {
    causes.push({
      kind: 'request',
      turn: failure.turn,
      step: null,
      tool: null,
      reason: 'the request may have been under-specified',
    })
  }
  return causes
}

/**
 * Sum token accounting across settled assistant messages. Optional counters
 * appear only when at least one contributing usage reported them.
 * @param usages - per-step usages, null for steps without accounting.
 * @returns the summed usage, or null when nothing reported.
 */
export function sumUsage(usages: readonly (TraceStep['usage'] | null)[]): TraceRecord['usage'] {
  const seen = usages.filter(usage => usage !== null)
  if (seen.length === 0) return null
  const summed: Exclude<TraceRecord['usage'], null> = { inputTokens: 0, outputTokens: 0 }
  for (const usage of seen) {
    summed.inputTokens += usage.inputTokens
    summed.outputTokens += usage.outputTokens
    if (usage.totalTokens !== undefined) summed.totalTokens = (summed.totalTokens ?? 0) + usage.totalTokens
    if (usage.cacheReadTokens !== undefined) summed.cacheReadTokens = (summed.cacheReadTokens ?? 0) + usage.cacheReadTokens
    if (usage.cacheWriteTokens !== undefined) summed.cacheWriteTokens = (summed.cacheWriteTokens ?? 0) + usage.cacheWriteTokens
    if (usage.reasoningTokens !== undefined) summed.reasoningTokens = (summed.reasoningTokens ?? 0) + usage.reasoningTokens
  }
  return summed
}
