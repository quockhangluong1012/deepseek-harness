/**
 * Track A0 turn-economics baseline (SPEC-EVOLUTIONARY-AGENT-RUNTIME §35.2).
 *
 * Reads the recorded sessions under a root directory through the shipped
 * readers — the keyless fixture reader (`@deepseek-ai/dsh-llm-replay`, which
 * decodes and migrates through `@deepseek-ai/dsh-session-format-catalog`) for
 * the log, and the session query reader's surface fold
 * (`@deepseek-ai/dsh-session-query`) for the model-visible classification —
 * and measures the six Track A0 quantities:
 *
 * - input tokens by context source kind, from the `context/compiled` records
 *   `@deepseek-ai/dsh-agent-context` appends;
 * - model calls per turn, foreground and background, with background requests
 *   attributed to the turn open when they were issued;
 * - cache-hit ratio, from provider usage samples validated by
 *   `@deepseek-ai/dsh-usage-ledger`'s own sample rules; unprovable samples are
 *   skipped rather than zero-filled, so the report states how many sessions
 *   carried one;
 * - supersedes per session, the snapshot briefs that replaced a producer's
 *   visible node;
 * - log-only events per tool call, from the reader's surface classification;
 * - startup time, the interval between a session's creation and its first turn.
 *
 * The output is a stable JSON report plus a short human summary, so two runs
 * are comparable; it is a measurement, not a gate. Committed snapshot fixtures
 * normalize event timestamps to zero, so startup latency is measurable only
 * for logs that carry a clock and the report states how many did.
 *
 * Run: `tsx scripts/measure-turn-economics.ts [--sessions-root PATH] [--json-out PATH]`.
 * @module scripts/measure-turn-economics
 */

import { realpathSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { parseArgs } from 'node:util'
import type { ContextSourceKind } from '@deepseek-ai/dsh-agent-context'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { buildSessionEventRecords } from '@deepseek-ai/dsh-session-query'
import type { SessionEventSurface } from '@deepseek-ai/dsh-session-query'
import { normalizeSample, sampleOfAttempt, sampleOfMessage } from '@deepseek-ai/dsh-usage-ledger'
import { parseSessionHeader, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { snapshotSlot } from '../packages/core/agent-loop/src/snapshot-injections.ts'

/**
 * Event types that each record one model request outside the turn loop: the
 * title generator, the DeepSeek web-search synthesizer, and one compaction
 * summary. A `compaction/prune` is model-free and is deliberately absent; an
 * unmarked summary from a template or remote summarizer is a request through a
 * seam this log cannot prove, so the count stays provable-only like the ledger's.
 */
const BACKGROUND_REQUEST_TYPES: Readonly<Record<string, true>> = {
  'session/title-llm-request': true,
  'web/deepseek-search-llm-request': true,
  'compaction/summary': true,
}

/** Canonical recorded-session fixture filename: `session[.n][.vN].jsonl`. */
const SESSION_FILE = /^session(?:\.([1-9]\d*))?(?:\.v([1-9]\d*))?\.jsonl$/u

/** One recorded session: its corpus key, creation time, parsed events, and their surface. */
export interface RecordedSession {
  /** Session path relative to the measured root, with `/` separators. */
  readonly key: string
  /** Session creation time in Unix epoch milliseconds; 0 when the log carries none. */
  readonly createdAt: number
  /** Current-format events in log order, as the reader returned them. */
  readonly events: readonly SessionEvent[]
  /**
   * One surface classification per event, in log order, from the session
   * query reader's own fold — `current` model context, `shadowed` replaced
   * context, or `log-only`.
   */
  readonly surfaces: readonly SessionEventSurface[]
}

/** Billed model requests of one session, split by where the request came from. */
export interface ModelCallCounts {
  /** Requests the turn loop issued: every settling `assistant/message` and abandoned `assistant/attempt`. */
  readonly foreground: number
  /** Auxiliary requests outside the turn loop: title, web search, and compaction summary. */
  readonly background: number
  /** Background requests recorded while no turn was open. */
  readonly backgroundOutsideTurn: number
  /** Foreground plus background. */
  readonly total: number
}

/** Model calls one turn made. */
export interface TurnModelCalls {
  /** Turn number as the log recorded it. */
  readonly turn: number
  /** Foreground plus background calls attributed to this turn. */
  readonly modelCalls: number
  /** Background calls attributed to this turn. */
  readonly backgroundCalls: number
}

/** Input tokens by context source kind, with the cache economics of the same samples. */
export interface TokenEconomics {
  /** Placed-source tokens summed per `context/compiled` source kind. */
  readonly inputTokensBySource: Readonly<Record<ContextSourceKind, number>>
  /** `context/compiled` records the session holds. */
  readonly compiledRecords: number
  /** Billed prompt tokens (`uncached + cacheRead + cacheWrite`). */
  readonly billedInputTokens: number
  /** Prompt tokens served from cache. */
  readonly cacheReadTokens: number
  /** Provable provider usage samples behind the billed counts. */
  readonly usageSamples: number
  /** `cacheReadTokens / billedInputTokens`, the ledger's rule; 0 without billed input. */
  readonly cacheHitRatio: number
}

/** Everything one recorded session contributed to the baseline. */
export interface SessionEconomics {
  /** Session path relative to the measured root, with `/` separators. */
  readonly key: string
  /** Session creation time in Unix epoch milliseconds; 0 when the log carries none. */
  readonly createdAt: number
  /** Events the reader returned for this session. */
  readonly events: number
  /** `turn/start` events. */
  readonly turns: number
  /** `step/start` events. */
  readonly steps: number
  /** `tool/call` events. */
  readonly toolCalls: number
  /** Billed model requests, foreground and background. */
  readonly modelCalls: ModelCallCounts
  /** One row per turn, ascending. */
  readonly perTurn: readonly TurnModelCalls[]
  /** Input tokens by source kind and the cache economics. */
  readonly tokens: TokenEconomics
  /** User messages whose source presents a snapshot (`form: 'snapshot'`). */
  readonly snapshotMessages: number
  /** Snapshot messages whose source declares `supersedes`. */
  readonly supersedeDeclarations: number
  /** Declarations that replaced a producer's visible node on the surface. */
  readonly supersedes: number
  /** Events that never entered the model surface. */
  readonly logOnlyEvents: number
  /** Events a later replacement removed from the model surface. */
  readonly shadowedEvents: number
  /** Log-only events per tool call; 0 without tool calls. */
  readonly logOnlyPerToolCall: number
  /** Milliseconds from session creation to the first turn open; null without a clock. */
  readonly startupMs: number | null
  /** Events the log holds before its first turn opens. */
  readonly preTurnEvents: number
}

/** Per-turn call rates across every measured session. */
export interface PerTurnTotals {
  /** Least calls any turn made. */
  readonly min: number
  /** Most calls any turn made. */
  readonly max: number
  /** Mean calls per turn. */
  readonly mean: number
}

/** What the corpus showed about startup. */
export interface StartupEconomics {
  /** Sessions whose log carries both a creation time and event times. */
  readonly sessionsWithClock: number
  /** Median creation-to-first-turn milliseconds; null without a clock. */
  readonly medianMs: number | null
  /** Slowest creation-to-first-turn milliseconds; null without a clock. */
  readonly maxMs: number | null
  /** Events logged before the first turn opens, over every session. */
  readonly preTurnEvents: PerTurnTotals
}

/** Corpus-wide totals of every measured quantity. */
export interface TurnEconomicsTotals {
  /** Recorded sessions measured. */
  readonly sessions: number
  /** Events read. */
  readonly events: number
  /** `turn/start` events. */
  readonly turns: number
  /** `step/start` events. */
  readonly steps: number
  /** `tool/call` events. */
  readonly toolCalls: number
  /** Billed model requests, foreground and background. */
  readonly modelCalls: ModelCallCounts
  /** Model calls per turn across every session. */
  readonly perTurn: PerTurnTotals
  /** Background calls per turn; `turnsAboveOne` is the §35.4 background-call signal. */
  readonly backgroundPerTurn: { readonly max: number; readonly turnsAboveOne: number }
  /** Input tokens by source kind and the cache economics. */
  readonly tokens: TokenEconomics
  /** Sessions that hold at least one `context/compiled` record. */
  readonly sessionsWithCompiledContext: number
  /** Sessions with at least one provable provider usage sample. */
  readonly sessionsWithUsage: number
  /** User messages whose source presents a snapshot. */
  readonly snapshotMessages: number
  /** Snapshot messages declaring `supersedes`. */
  readonly supersedeDeclarations: number
  /** Supersedes that replaced a visible node. */
  readonly supersedes: number
  /** Most supersedes one session made. */
  readonly maxSupersedesPerSession: number
  /** Events that never entered the model surface. */
  readonly logOnlyEvents: number
  /** Events a later replacement removed from the model surface. */
  readonly shadowedEvents: number
  /** Log-only events per tool call; 0 without tool calls. */
  readonly logOnlyPerToolCall: number
  /** Startup facts. */
  readonly startup: StartupEconomics
}

/** The measured baseline: one row per session and their totals. */
export interface TurnEconomicsMeasurement {
  /** Per-session rows, ascending by key. */
  readonly sessions: readonly SessionEconomics[]
  /** Corpus-wide totals. */
  readonly totals: TurnEconomicsTotals
}

/** One recorded session the reader refused; it contributes to no total. */
export interface UnreadableSession {
  /** Session path relative to the measured root, with `/` separators. */
  readonly key: string
  /** Why the shipped reader refused it. */
  readonly message: string
}

/** The report the command prints and writes. */
export interface TurnEconomicsReport extends TurnEconomicsMeasurement {
  /** Report schema version; compare runs only across one version. */
  readonly schemaVersion: 1
  /** Sessions root as it was passed on the command line. */
  readonly sessionsRoot: string
  /** Discovered fixtures the reader could not decode, in key order. */
  readonly unreadable: readonly UnreadableSession[]
}

/** A discovered session fixture: its root-relative key and absolute path. */
interface DiscoveredSession {
  /** Session path relative to the measured root, with `/` separators. */
  readonly key: string
  /** Absolute path to the fixture. */
  readonly path: string
}

/** One turn's running call tallies. */
interface TurnTally {
  readonly turn: number
  modelCalls: number
  backgroundCalls: number
}

/** Every source kind at zero, in reporting order; spread it to get an independent tally. */
const ZERO_SOURCE_TOKENS: Readonly<Record<ContextSourceKind, number>> = {
  policy: 0, task: 0, plan: 0, memory: 0, evidence: 0, artifact: 0, history: 0, tool: 0,
}

/** Round to four decimals so two runs on one corpus render byte-identical JSON. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/**
 * Midpoint of a sample, or 0 when it is empty.
 * @param values - the sample.
 * @returns the median value.
 */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted[Math.floor(sorted.length / 2)]
  if (middle === undefined) return 0
  if (sorted.length % 2 === 1) return middle
  return ((sorted[sorted.length / 2 - 1] ?? 0) + middle) / 2
}

/** Measure one recorded session. */
function measureSession(session: RecordedSession): SessionEconomics {
  const inputTokensBySource = { ...ZERO_SOURCE_TOKENS }
  const perTurn = new Map<number, TurnTally>()
  const tally = (turn: number): TurnTally => {
    let row = perTurn.get(turn)
    if (row === undefined) {
      row = { turn, modelCalls: 0, backgroundCalls: 0 }
      perTurn.set(turn, row)
    }
    return row
  }
  let events = 0
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let foreground = 0
  let background = 0
  let backgroundOutsideTurn = 0
  let openTurn: number | null = null
  let compiledRecords = 0
  let billedInputTokens = 0
  let cacheReadTokens = 0
  let usageSamples = 0
  let snapshotMessages = 0
  let supersedeDeclarations = 0
  let supersedes = 0
  let logOnlyEvents = 0
  let shadowedEvents = 0
  let startupMs: number | null = null
  let preTurnEvents = 0

  for (const [index, event] of session.events.entries()) {
    events += 1
    const surface = session.surfaces[index]
    if (surface === undefined) throw new Error(`${session.key}: no surface classification for event ${index}`)
    if (surface === 'shadowed') shadowedEvents += 1
    else if (surface === 'log-only') logOnlyEvents += 1
    // Auxiliary requests are recognized by type, not by a merged payload shape.
    if (BACKGROUND_REQUEST_TYPES[event.type] === true) {
      background += 1
      if (openTurn === null) backgroundOutsideTurn += 1
      else {
        const row = tally(openTurn)
        row.modelCalls += 1
        row.backgroundCalls += 1
      }
    }
    switch (event.type) {
      case 'turn/start':
        turns += 1
        openTurn = event.data.turn
        tally(event.data.turn)
        if (turns === 1) preTurnEvents = index
        if (startupMs === null && session.createdAt > 0 && event.time > 0) startupMs = event.time - session.createdAt
        break
      case 'turn/end':
        openTurn = null
        break
      case 'step/start':
        steps += 1
        break
      case 'tool/call':
        toolCalls += 1
        break
      case 'assistant/message':
      case 'assistant/attempt': {
        foreground += 1
        tally(event.data.turn).modelCalls += 1
        const usage = event.type === 'assistant/message' ? sampleOfMessage(event) : sampleOfAttempt(event)
        const sample = usage === undefined ? undefined : normalizeSample(usage)
        if (sample !== undefined) {
          usageSamples += 1
          billedInputTokens += sample.inputTokens
          cacheReadTokens += sample.cacheReadTokens
        }
        break
      }
      case 'context/compiled':
        compiledRecords += 1
        for (const entry of event.data.included) inputTokensBySource[entry.kind] += entry.tokens
        break
      case 'user/message': {
        const source = event.data.source
        if ('form' in source && source.form === 'snapshot') {
          snapshotMessages += 1
          if (snapshotSlot(source) !== undefined) {
            supersedeDeclarations += 1
            if (event.surfaceOp !== 'append') supersedes += 1
          }
        }
        break
      }
      default:
        // Merge-extensible map: a plugin event outside the measured set contributes no metric.
        break
    }
  }

  const perTurnRows = [...perTurn.values()]
    .sort((left, right) => left.turn - right.turn)
    .map(row => ({ turn: row.turn, modelCalls: row.modelCalls, backgroundCalls: row.backgroundCalls }))
  // A session that never opened a turn logged its whole history before one.
  if (turns === 0) preTurnEvents = events
  return {
    key: session.key,
    createdAt: session.createdAt,
    events,
    turns,
    steps,
    toolCalls,
    modelCalls: { foreground, background, backgroundOutsideTurn, total: foreground + background },
    perTurn: perTurnRows,
    tokens: {
      inputTokensBySource,
      compiledRecords,
      billedInputTokens,
      cacheReadTokens,
      usageSamples,
      cacheHitRatio: billedInputTokens === 0 ? 0 : round(cacheReadTokens / billedInputTokens),
    },
    snapshotMessages,
    supersedeDeclarations,
    supersedes,
    logOnlyEvents,
    shadowedEvents,
    logOnlyPerToolCall: toolCalls === 0 ? 0 : round(logOnlyEvents / toolCalls),
    startupMs,
    preTurnEvents,
  }
}

/**
 * Measure the turn economics of recorded sessions. Pure: it reads only the
 * events it is given, so a corpus read by any shipped reader is measurable.
 * @param sessions - parsed sessions in any order.
 * @returns per-session rows sorted by key and their totals.
 */
export function measureTurnEconomics(sessions: readonly RecordedSession[]): TurnEconomicsMeasurement {
  const rows = sessions.map(measureSession).sort((left, right) => left.key.localeCompare(right.key))
  const inputTokensBySource = { ...ZERO_SOURCE_TOKENS }
  const perTurnRows: TurnModelCalls[] = []
  const startupSamples: number[] = []
  let events = 0
  let turns = 0
  let steps = 0
  let toolCalls = 0
  let foreground = 0
  let background = 0
  let backgroundOutsideTurn = 0
  let compiledRecords = 0
  let billedInputTokens = 0
  let cacheReadTokens = 0
  let usageSamples = 0
  let sessionsWithCompiledContext = 0
  let sessionsWithUsage = 0
  let snapshotMessages = 0
  let supersedeDeclarations = 0
  let supersedes = 0
  let maxSupersedesPerSession = 0
  let logOnlyEvents = 0
  let shadowedEvents = 0
  const preTurnEvents: number[] = []
  for (const row of rows) {
    events += row.events
    turns += row.turns
    steps += row.steps
    toolCalls += row.toolCalls
    foreground += row.modelCalls.foreground
    background += row.modelCalls.background
    backgroundOutsideTurn += row.modelCalls.backgroundOutsideTurn
    perTurnRows.push(...row.perTurn)
    for (const [kind, tokens] of Object.entries(row.tokens.inputTokensBySource)) {
      inputTokensBySource[kind as ContextSourceKind] += tokens
    }
    compiledRecords += row.tokens.compiledRecords
    billedInputTokens += row.tokens.billedInputTokens
    cacheReadTokens += row.tokens.cacheReadTokens
    usageSamples += row.tokens.usageSamples
    if (row.tokens.compiledRecords > 0) sessionsWithCompiledContext += 1
    if (row.tokens.usageSamples > 0) sessionsWithUsage += 1
    snapshotMessages += row.snapshotMessages
    supersedeDeclarations += row.supersedeDeclarations
    supersedes += row.supersedes
    maxSupersedesPerSession = Math.max(maxSupersedesPerSession, row.supersedes)
    logOnlyEvents += row.logOnlyEvents
    shadowedEvents += row.shadowedEvents
    preTurnEvents.push(row.preTurnEvents)
    if (row.startupMs !== null) startupSamples.push(row.startupMs)
  }
  const callsPerTurn = perTurnRows.map(row => row.modelCalls)
  const backgroundPerTurn = perTurnRows.map(row => row.backgroundCalls)
  return {
    sessions: rows,
    totals: {
      sessions: rows.length,
      events,
      turns,
      steps,
      toolCalls,
      modelCalls: { foreground, background, backgroundOutsideTurn, total: foreground + background },
      perTurn: {
        min: callsPerTurn.length === 0 ? 0 : Math.min(...callsPerTurn),
        max: callsPerTurn.length === 0 ? 0 : Math.max(...callsPerTurn),
        mean: callsPerTurn.length === 0 ? 0 : round(callsPerTurn.reduce((sum, calls) => sum + calls, 0) / callsPerTurn.length),
      },
      backgroundPerTurn: {
        max: backgroundPerTurn.length === 0 ? 0 : Math.max(...backgroundPerTurn),
        turnsAboveOne: backgroundPerTurn.filter(calls => calls > 1).length,
      },
      tokens: {
        inputTokensBySource,
        compiledRecords,
        billedInputTokens,
        cacheReadTokens,
        usageSamples,
        cacheHitRatio: billedInputTokens === 0 ? 0 : round(cacheReadTokens / billedInputTokens),
      },
      sessionsWithCompiledContext,
      sessionsWithUsage,
      snapshotMessages,
      supersedeDeclarations,
      supersedes,
      maxSupersedesPerSession,
      logOnlyEvents,
      shadowedEvents,
      logOnlyPerToolCall: toolCalls === 0 ? 0 : round(logOnlyEvents / toolCalls),
      startup: {
        sessionsWithClock: startupSamples.length,
        medianMs: startupSamples.length === 0 ? null : median(startupSamples),
        maxMs: startupSamples.length === 0 ? null : Math.max(...startupSamples),
        preTurnEvents: {
          min: preTurnEvents.length === 0 ? 0 : Math.min(...preTurnEvents),
          max: preTurnEvents.length === 0 ? 0 : Math.max(...preTurnEvents),
          mean: preTurnEvents.length === 0 ? 0 : round(preTurnEvents.reduce((sum, count) => sum + count, 0) / preTurnEvents.length),
        },
      },
    },
  }
}

/**
 * Render the short human summary of a report.
 * @param report - the report to describe.
 * @returns newline-joined summary lines, without a trailing newline.
 */
export function formatTurnEconomicsSummary(report: TurnEconomicsReport): string {
  const { totals } = report
  const sources = Object.entries(totals.tokens.inputTokensBySource)
    .map(([kind, tokens]) => `${kind} ${tokens}`)
    .join(', ')
  const startup = totals.startup
  const rates = startup.sessionsWithClock === 0
    ? `startup latency unmeasurable (0 of ${totals.sessions} sessions carry a clock)`
    : `startup latency median ${startup.medianMs ?? 0} ms, max ${startup.maxMs ?? 0} ms over ${startup.sessionsWithClock} of ${totals.sessions} sessions`
  return [
    `${report.sessionsRoot}: ${totals.sessions} sessions, ${totals.turns} turns, ${totals.steps} steps, `
      + `${totals.toolCalls} tool calls, ${totals.events} events`,
    `model calls: ${totals.modelCalls.total} (${totals.modelCalls.foreground} foreground, `
      + `${totals.modelCalls.background} background, ${totals.modelCalls.backgroundOutsideTurn} outside a turn)`,
    `per turn: calls max ${totals.perTurn.max}, mean ${totals.perTurn.mean}; `
      + `background calls max ${totals.backgroundPerTurn.max}, ${totals.backgroundPerTurn.turnsAboveOne} turns above one`,
    `input tokens by source: ${sources} `
      + `(${totals.tokens.compiledRecords} compiled records in ${totals.sessionsWithCompiledContext} of ${totals.sessions} sessions)`,
    `cache: billed input ${totals.tokens.billedInputTokens}, cache read ${totals.tokens.cacheReadTokens}, `
      + `hit ratio ${totals.tokens.cacheHitRatio} (${totals.sessionsWithUsage} of ${totals.sessions} sessions with usage)`,
    `supersedes: ${totals.supersedes} replacements (${totals.supersedeDeclarations} declarations) over `
      + `${totals.snapshotMessages} snapshot messages; max per session ${totals.maxSupersedesPerSession}`,
    `log volume: ${totals.logOnlyEvents} log-only and ${totals.shadowedEvents} shadowed events; `
      + `${totals.logOnlyPerToolCall} log-only events per tool call`,
    `startup: ${rates}; events before the first turn mean ${startup.preTurnEvents.mean}`,
    ...report.unreadable.length === 0
      ? ['unreadable fixtures: 0']
      : [`unreadable fixtures: ${report.unreadable.length}`,
        ...report.unreadable.map(refusal => `  ${refusal.key}: ${refusal.message}`)],
  ].join('\n')
}

/**
 * Discover the selected recorded-session fixture in every directory under a root.
 * One generation per parent/ordinal role is selected — the numerically highest,
 * as replay, record, and refresh do — and directories without a fixture are skipped,
 * so a corpus may hold borrowed scenarios and unrelated files.
 * @param root - absolute sessions root.
 * @returns discovered fixtures sorted by key.
 */
async function discoverSessions(root: string): Promise<DiscoveredSession[]> {
  const found: DiscoveredSession[] = []
  const visit = async (directory: string): Promise<void> => {
    const selected = new Map<number, { version: number; name: string }>()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name))
        continue
      }
      const match = SESSION_FILE.exec(entry.name)
      if (match === null) continue
      const ordinal = match[1] === undefined ? 0 : Number(match[1])
      const version = match[2] === undefined ? 0 : Number(match[2])
      const previous = selected.get(ordinal)
      if (previous === undefined || version > previous.version) selected.set(ordinal, { version, name: entry.name })
    }
    for (const file of selected.values()) {
      found.push({
        key: relative(root, join(directory, file.name)).split(sep).join('/'),
        path: join(directory, file.name),
      })
    }
  }
  await visit(root)
  return found.sort((left, right) => left.key.localeCompare(right.key))
}

/**
 * Read every selected recorded session under a root. A fixture the shipped
 * reader refuses — a generation its migration cannot upgrade, or a damaged
 * log — is reported instead of measured, so a corpus with one stale fixture
 * still yields the baseline for the rest and never hides the loss.
 * @param root - absolute sessions root.
 * @returns parsed sessions and the refusals, each in key order.
 */
async function readSessions(root: string): Promise<{ sessions: RecordedSession[]; unreadable: UnreadableSession[] }> {
  const sessions: RecordedSession[] = []
  const unreadable: UnreadableSession[] = []
  for (const file of await discoverSessions(root)) {
    const text = await readFile(file.path, 'utf8')
    try {
      const events = parseSessionLog(text)
      // The session query reader owns the surface vocabulary; its records also
      // validate the surface, so an unreadable one is attributed to this file.
      const records = buildSessionEventRecords(SessionId(file.key), events)
      sessions.push({
        key: file.key,
        createdAt: parseSessionHeader(text).createdAt,
        events,
        surfaces: records.map(record => record.surface),
      })
    } catch (error: unknown) {
      unreadable.push({ key: file.key, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { sessions, unreadable }
}

const usage = `Usage: tsx scripts/measure-turn-economics.ts [--sessions-root PATH] [--json-out PATH]

Measures the Track A0 turn-economics baseline over recorded sessions and prints
a JSON report plus a short summary. Reads only committed logs; no model or API
key is used. The default sessions root is ./snapshots.

Options:
  --sessions-root PATH  Recorded-session root to measure (default: snapshots)
  --json-out PATH       Also write the JSON report to this file
  --help                Show this help
`

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) {
  try {
    const { values } = parseArgs({
      options: { 'sessions-root': { type: 'string' }, 'json-out': { type: 'string' }, help: { type: 'boolean' } },
      strict: true,
    })
    if (values.help) console.log(usage)
    else {
      const sessionsRoot = values['sessions-root'] ?? 'snapshots'
      const { sessions, unreadable } = await readSessions(realpathSync(sessionsRoot))
      const report: TurnEconomicsReport = {
        schemaVersion: 1,
        sessionsRoot,
        ...measureTurnEconomics(sessions),
        unreadable,
      }
      const json = `${JSON.stringify(report, null, 2)}\n`
      console.log(formatTurnEconomicsSummary(report))
      console.log(`\nReport JSON:\n${json}`)
      if (values['json-out'] !== undefined) await writeFile(values['json-out'], json, 'utf8')
    }
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error))
    console.error(usage)
    process.exitCode = 1
  }
}
