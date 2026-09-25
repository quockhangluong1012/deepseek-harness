/**
 * Pure usage-ledger fold: session-log usage samples become ledger counters,
 * and ledger counters become range summaries. No Cordis, no I/O — the Host
 * service owns persistence and the Remote face, and every function here is
 * unit-testable in isolation.
 *
 * One billed attempt is one provider usage sample on an `assistant/message`
 * or `assistant/attempt` event. Retries count: each sample represents tokens
 * a previous request already spent. A sample that fails validation is
 * skipped, never zero-filled, so the ledger stays an under-count rather
 * than inventing billing.
 * @module @deepseek-ai/dsh-usage-ledger/src/aggregate
 */

import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { AssistantMessage, LlmModelCost, LlmModelCostRates, TokenUsage } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { UsageDayAggregate, UsageLedgerState, UsageModelAggregate } from './spec.ts'
import type {
  UsageDayBucket,
  UsageModelRow,
  UsageRange,
  UsageSummary,
} from './types.ts'

/** Milliseconds from UTC to the dashboard's fixed reporting zone. */
export const UTC7_OFFSET_MS = 7 * 60 * 60 * 1000

/** Route attribution when a step never settles with a provider/model route. */
export const UNKNOWN_ROUTE = 'unknown'

/** Separator inside ledger model keys (day, provider, model never carry NUL). */
export const MODEL_KEY_SEPARATOR = '\u0000'

/**
 * Whether a value is a usable token count.
 * @param value - candidate count.
 * @returns true for non-negative safe integers.
 */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** One validated usage sample with its exact billed total. */
export interface NormalizedSample {
  /** Billed prompt tokens (`uncached + cacheRead + cacheWrite`). */
  readonly inputTokens: number
  /** Billed completion tokens. */
  readonly outputTokens: number
  /** Prompt tokens served from cache. */
  readonly cacheReadTokens: number
  /** Prompt tokens written to cache. */
  readonly cacheWriteTokens: number
  /** Exact prompt-plus-output total. */
  readonly totalTokens: number
}

/**
 * Validate one provider usage sample under the token-meter's exact-total
 * rule: a reported total must cover the known prompt plus output, and a
 * missing total requires both cache buckets before it is derived.
 * @param usage - the provider-reported sample.
 * @returns the normalized sample, or undefined when it cannot be proven.
 */
export function normalizeSample(usage: TokenUsage): NormalizedSample | undefined {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens } = usage
  if (!isCount(inputTokens) || !isCount(outputTokens)) return undefined
  if (cacheReadTokens !== undefined && !isCount(cacheReadTokens)) return undefined
  if (cacheWriteTokens !== undefined && !isCount(cacheWriteTokens)) return undefined
  if (reasoningTokens !== undefined && (!isCount(reasoningTokens) || reasoningTokens > outputTokens)) {
    return undefined
  }
  const cacheRead = cacheReadTokens ?? 0
  const cacheWrite = cacheWriteTokens ?? 0
  const knownPrompt = inputTokens + cacheRead + cacheWrite
  if (!Number.isSafeInteger(knownPrompt)) return undefined
  if (totalTokens !== undefined) {
    if (!isCount(totalTokens)) return undefined
    const exactPrompt = totalTokens - outputTokens
    if (!isCount(exactPrompt) || exactPrompt < knownPrompt) return undefined
    if (cacheReadTokens !== undefined && cacheWriteTokens !== undefined && exactPrompt !== knownPrompt) {
      return undefined
    }
    return { inputTokens: knownPrompt, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens }
  }
  if (cacheReadTokens === undefined || cacheWriteTokens === undefined) return undefined
  const derivedTotal = knownPrompt + outputTokens
  if (!Number.isSafeInteger(derivedTotal)) return undefined
  return { inputTokens: knownPrompt, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: derivedTotal }
}

/**
 * Estimate one validated attempt's USD cost from per-million-token route
 * rates. The greatest tier whose threshold is strictly below billed input
 * tokens prices the whole sample, matching pi-ai catalog semantics.
 * @param sample - normalized billed input, cache, and output counts.
 * @param cost - exact route pricing resolved for the attempt.
 * @returns estimated USD amount.
 */
export function priceSample(sample: NormalizedSample, cost: LlmModelCost): number {
  let rates: LlmModelCostRates = cost
  let matchedThreshold = -1
  for (const tier of cost.tiers ?? []) {
    if (sample.inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matchedThreshold) {
      rates = tier
      matchedThreshold = tier.inputTokensAbove
    }
  }
  const uncachedInputTokens = sample.inputTokens - sample.cacheReadTokens - sample.cacheWriteTokens
  return (
    uncachedInputTokens * rates.inputPerMTok
    + sample.outputTokens * rates.outputPerMTok
    + sample.cacheReadTokens * rates.cacheReadPerMTok
    + sample.cacheWriteTokens * rates.cacheWritePerMTok
  ) / 1_000_000
}

/**
 * The provider/model route of one assistant message.
 * @param message - the settled assistant message.
 * @returns the route, or undefined when either side is empty.
 */
export function messageRoute(message: AssistantMessage): { provider: string; model: string } | undefined {
  const { provider, model } = message.source
  return provider.length > 0 && model.length > 0 ? { provider, model } : undefined
}

/**
 * The usage sample of one assistant message: the top-level report wins over
 * the embedded stream sample.
 * @param event - the message event.
 * @returns the sample, or undefined when the message carries none.
 */
export function sampleOfMessage(event: SessionEvent<'assistant/message'>): TokenUsage | undefined {
  return event.data.usage ?? lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

/**
 * The usage sample of one assistant attempt: only the embedded stream
 * sample exists, and an attempt without one billed nothing provable.
 * @param event - the attempt event.
 * @returns the sample, or undefined when the attempt carries none.
 */
export function sampleOfAttempt(event: SessionEvent<'assistant/attempt'>): TokenUsage | undefined {
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage
}

/**
 * Calendar-day key of one timestamp in the dashboard's fixed zone.
 * @param time - Unix epoch milliseconds.
 * @returns `YYYY-MM-DD` in UTC+7.
 */
export function dayKeyUTC7(time: number): string {
  const shifted = new Date(time + UTC7_OFFSET_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Midnight UTC+7 starting the calendar day that contains `now`.
 * @param now - Unix epoch milliseconds.
 * @returns the day-start timestamp in true epoch milliseconds.
 */
export function dayStartUTC7(now: number): number {
  return Math.floor((now + UTC7_OFFSET_MS) / 86_400_000) * 86_400_000 - UTC7_OFFSET_MS
}

/**
 * Whether a filter range names a known window.
 * @param value - candidate range from the wire.
 * @returns true for the four supported ranges.
 */
export function isUsageRange(value: unknown): value is UsageRange {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all'
}

/**
 * Calendar days one range covers, ascending, in UTC+7. Bounded windows are
 * zero-filled so the chart always draws its frame; `all` covers only days
 * with data because the window is unbounded.
 * @param range - the requested window.
 * @param now - Unix epoch milliseconds anchoring the window.
 * @param daysWithData - day keys that carry at least one attempt.
 * @returns the day keys to report.
 */
export function daysOfRange(range: UsageRange, now: number, daysWithData: ReadonlySet<string>): string[] {
  if (range === 'all') return [...daysWithData].sort()
  const width = range === 'today' ? 1 : range === '7d' ? 7 : 30
  const start = dayStartUTC7(now) - (width - 1) * 86_400_000
  const days: string[] = []
  for (let index = 0; index < width; index += 1) days.push(dayKeyUTC7(start + index * 86_400_000))
  return days
}

/**
 * First timestamp one range admits, in true epoch milliseconds.
 * @param range - the requested window.
 * @param now - Unix epoch milliseconds anchoring the window.
 * @returns the inclusive window start, or negative infinity for `all`.
 */
export function windowStartOfRange(range: UsageRange, now: number): number {
  if (range === 'all') return Number.NEGATIVE_INFINITY
  const back = range === 'today' ? 0 : range === '7d' ? 6 : 29
  return dayStartUTC7(now) - back * 86_400_000
}

/** Mutable per-route accumulation while summarizing one window. */
interface ModelAccumulator {
  provider: string
  model: string
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/**
 * Share of billed input served from cache.
 * @param cacheReadTokens - prompt tokens served from cache.
 * @param inputTokens - billed prompt tokens.
 * @returns the share in `[0, 1]`, or `0` without billed input.
 */
export function cacheHitAvg(cacheReadTokens: number, inputTokens: number): number {
  return inputTokens <= 0 ? 0 : cacheReadTokens / inputTokens
}

/**
 * Ledger key of one route's counters on one day.
 * @param day - the UTC+7 day key.
 * @param provider - the adapter provider name.
 * @param model - the model name.
 * @returns the models-table key.
 */
export function modelKey(day: string, provider: string, model: string): string {
  return `${day}${MODEL_KEY_SEPARATOR}${provider}${MODEL_KEY_SEPARATOR}${model}`
}

/**
 * Day part of one models-table key.
 * @param key - the models-table key.
 * @returns the UTC+7 day key.
 */
export function dayOfModelKey(key: string): string {
  return key.slice(0, key.indexOf(MODEL_KEY_SEPARATOR))
}

/**
 * Add one normalized sample to the ledger counters under one route.
 * @param state - the ledger state to accumulate into.
 * @param day - the UTC+7 day key of the sample.
 * @param provider - the attributed provider.
 * @param model - the attributed model.
 * @param sample - the validated sample.
 */
export function addSample(
  state: UsageLedgerState,
  day: string,
  provider: string,
  model: string,
  sample: NormalizedSample,
): void {
  const dayRow: UsageDayAggregate = state.daily[day] ?? { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  dayRow.requests += 1
  dayRow.inputTokens += sample.inputTokens
  dayRow.outputTokens += sample.outputTokens
  dayRow.cacheReadTokens += sample.cacheReadTokens
  state.daily[day] = dayRow
  addModelOnly(state, day, provider, model, sample)
}

/**
 * Move one sample's route counters from one route to another on the same
 * day, for a step whose route arrives after its first samples. Zeroed
 * source rows are deleted so the table never accumulates empty rows.
 * @param state - the ledger state to adjust.
 * @param day - the UTC+7 day key of the sample.
 * @param from - the previously attributed route.
 * @param to - the newly settled route.
 * @param sample - the validated sample to move.
 */
export function moveSample(
  state: UsageLedgerState,
  day: string,
  from: { provider: string; model: string },
  to: { provider: string; model: string },
  sample: NormalizedSample,
): void {
  const fromKey = modelKey(day, from.provider, from.model)
  const fromRow = state.models[fromKey]
  if (fromRow !== undefined) {
    fromRow.requests -= 1
    fromRow.inputTokens -= sample.inputTokens
    fromRow.outputTokens -= sample.outputTokens
    fromRow.cacheReadTokens -= sample.cacheReadTokens
    if (fromRow.requests <= 0) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- plain JSON-keyed record; a Map breaks the stored schema
      delete state.models[fromKey]
    }
  }
  addModelOnly(state, day, to.provider, to.model, sample)
}

/**
 * Add one sample to the models table only (the day table is route-blind,
 * so route moves never touch it). Shared by {@link addSample}, whose day-row
 * half is the only difference.
 * @param state - the ledger state to accumulate into.
 * @param day - the UTC+7 day key of the sample.
 * @param provider - the attributed provider.
 * @param model - the attributed model.
 * @param sample - the validated sample.
 */
function addModelOnly(
  state: UsageLedgerState,
  day: string,
  provider: string,
  model: string,
  sample: NormalizedSample,
): void {
  const key = modelKey(day, provider, model)
  const modelRow: UsageModelAggregate = state.models[key] ?? {
    provider, model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  }
  modelRow.requests += 1
  modelRow.inputTokens += sample.inputTokens
  modelRow.outputTokens += sample.outputTokens
  modelRow.cacheReadTokens += sample.cacheReadTokens
  state.models[key] = modelRow
}

/**
 * Drop ledger counters older than the retention window. Day keys sort
 * lexicographically as chronology, so the cutoff is a string comparison.
 * @param state - the ledger state to prune.
 * @param now - Unix epoch milliseconds anchoring the window.
 * @param retentionDays - calendar days (UTC+7) to keep, counting today.
 */
export function sweepRetention(state: UsageLedgerState, now: number, retentionDays: number): void {
  const cutoff = dayKeyUTC7(dayStartUTC7(now) - (retentionDays - 1) * 86_400_000)
  for (const day of Object.keys(state.daily)) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- plain JSON-keyed record; a Map breaks the stored schema
    if (day < cutoff) delete state.daily[day]
  }
  for (const key of Object.keys(state.models)) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- plain JSON-keyed record; a Map breaks the stored schema
    if (dayOfModelKey(key) < cutoff) delete state.models[key]
  }
}

/**
 * Summarize ledger counters for one filter range.
 * @param state - the ledger counters to summarize.
 * @param range - the requested window.
 * @param now - Unix epoch milliseconds anchoring the window.
 * @returns totals, per-day buckets, and the per-model table.
 */
export function summarizeLedger(state: UsageLedgerState, range: UsageRange, now: number): UsageSummary {
  const start = windowStartOfRange(range, now)
  const inWindow = new Set(Object.keys(state.daily).filter(day => day >= dayKeyUTC7(start) || range === 'all'))
  const days = daysOfRange(range, now, inWindow)
  const totals = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  for (const [day, row] of Object.entries(state.daily)) {
    if (!inWindow.has(day)) continue
    totals.requests += row.requests
    totals.inputTokens += row.inputTokens
    totals.outputTokens += row.outputTokens
    totals.cacheReadTokens += row.cacheReadTokens
  }
  const daily: UsageDayBucket[] = days.map((day) => {
    const row = state.daily[day]
    return {
      day,
      requests: row?.requests ?? 0,
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
    }
  })
  const byModel = new Map<string, ModelAccumulator>()
  for (const [key, row] of Object.entries(state.models)) {
    if (!inWindow.has(dayOfModelKey(key))) continue
    const routeKey = `${row.provider}${MODEL_KEY_SEPARATOR}${row.model}`
    const entry = byModel.get(routeKey) ?? {
      provider: row.provider, model: row.model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    }
    entry.requests += row.requests
    entry.inputTokens += row.inputTokens
    entry.outputTokens += row.outputTokens
    entry.cacheReadTokens += row.cacheReadTokens
    byModel.set(routeKey, entry)
  }
  const models: UsageModelRow[] = [...byModel.values()]
    .map(row => ({
      provider: row.provider,
      model: row.model,
      requests: row.requests,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheHitAvg: cacheHitAvg(row.cacheReadTokens, row.inputTokens),
    }))
    .sort((left, right) => (right.inputTokens + right.outputTokens) - (left.inputTokens + left.outputTokens))
  return {
    range,
    totals: {
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheHitAvg: cacheHitAvg(totals.cacheReadTokens, totals.inputTokens),
    },
    daily,
    models,
  }
}
