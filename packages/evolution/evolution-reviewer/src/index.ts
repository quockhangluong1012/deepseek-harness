/**
 * Evolution background reviewer (`ctx.evolutionReviewer`): per-turn
 * produced-file indexing, gated per-turn lessons extraction, ranked recall
 * of prior scope work into the brief, and on-demand rebuild from session
 * history. Extraction is a deterministic derivation: the model answers one
 * turn with a batch of `confirms` / `contradicts` / `new` decisions about the
 * relevance-bounded slice of the scope's current artifacts it was shown, and
 * a failure logs a warning and leaves the stored artifacts as they were.
 *
 * The reviewer never scans session history synchronously. It buffers the
 * current turn's events as they arrive on `session/event` and flushes the
 * buffer at `turn/end`; rebuilds select their material through the
 * asynchronous `sessionQuery` search seam. Turns in flight while the reviewer
 * mounts extract from their observed suffix.
 * @module @deepseek-ai/dsh-evolution-reviewer
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { deadline } from '@deepseek-ai/dsh-timeout'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { EvolutionExtraction, EvolutionOutput, LessonDecision } from '@deepseek-ai/dsh-evolution-memory'
import { EvolutionScopeId, RECALL_LABEL_PREFIX, utf8Bytes } from '@deepseek-ai/dsh-evolution-memory'
import { skillCreationEvidence } from '@deepseek-ai/dsh-evolution-skill-telemetry'
import { extractionSystemPrompt, frameExtractionRequest, parseExtractionDecisions } from './protocol.ts'
import type { ExtractionDecision, IndexedArtifact } from './protocol.ts'
import { selectRelevantArtifacts } from './relevance.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Background evolution-lessons derivation owner. */
    evolutionReviewer: EvolutionReviewer
  }
}

/** Deployment choices for review scheduling and budgets. Fields read alphabetically. */
export interface Config {
  /** Minimum gap between two extractions for one scope. */
  cooldownMs?: number
  /** Turn-end extraction mode: `auto` queues the turn, `never` extracts at once. */
  defer?: 'auto' | 'never'
  /** Age ceiling for a queued turn, measured from its session's first snapshot. */
  deferMaxAgeMs?: number
  /** Whether a completed turn triggers extraction; output indexing always runs. */
  enabled?: boolean
  /** Transcript budget per call in UTF-8 bytes. */
  maxInputBytes?: number
  /**
   * Output token cap per call. Sized for the decision protocol's output, which
   * scales with the decisions one turn produces: a `new` candidate carries full
   * artifact fields, while a `confirms`/`contradicts` is a few tokens, and the
   * default covers roughly ten decisions with headroom.
   */
  maxOutputTokens?: number
  /** Skip extraction for trivial turns below this admitted-text byte size. */
  minTurnTextBytes?: number
  /** Route override model; must be paired with `provider`. */
  model?: string
  /** Which successful tool calls count as productions. */
  outputTools?: string[]
  /** Scope-identity namespace placed before the workspace key. */
  profile?: string
  /** Route override provider; must be paired with `model`. */
  provider?: string
  /** Sessions scanned by a rebuild. */
  rebuildSessionLimit?: number
  /** Ranked recall results selected per search, for sessions and for events. */
  recallLimit?: number
  /** Cap on the recall query derived from a turn's newest human message. */
  recallQueryChars?: number
  /** Most artifacts one extraction call shows the model, most relevant first. */
  relevantArtifactLimit?: number
  /** Call deadline in milliseconds. */
  timeoutMs?: number
  /** Stage background extractions for approval instead of writing them. */
  writeApproval?: boolean
}

/** Scope namespace used when the composition names none. */
export const DEFAULT_PROFILE = 'default'

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  cooldownMs: z.number().step(1).min(0).default(60000),
  defer: z.union(['auto', 'never']).default('auto'),
  deferMaxAgeMs: z.number().step(1).min(0).default(1800000),
  enabled: z.boolean().default(true),
  maxInputBytes: z.number().step(1).min(1).default(131072),
  // A decision batch scales with the decisions one turn produces, so the cap
  // is sized for roughly ten of them.
  maxOutputTokens: z.number().step(1).min(1).default(2048),
  minTurnTextBytes: z.number().step(1).min(0).default(200),
  model: z.string(),
  outputTools: z.array(z.string()).default(['write', 'edit', 'str_replace_editor']),
  profile: z.string().default(DEFAULT_PROFILE),
  provider: z.string(),
  rebuildSessionLimit: z.number().step(1).min(1).default(20),
  recallLimit: z.number().step(1).min(1).default(20),
  recallQueryChars: z.number().step(1).min(1).default(160),
  relevantArtifactLimit: z.number().step(1).min(1).default(20),
  timeoutMs: z.number().step(1).min(1).default(60000),
  writeApproval: z.boolean().default(false),
})

/** Normalized configuration. Fields read alphabetically. */
export interface ResolvedConfig {
  cooldownMs: number
  defer: 'auto' | 'never'
  deferMaxAgeMs: number
  enabled: boolean
  maxInputBytes: number
  maxOutputTokens: number
  minTurnTextBytes: number
  model?: string
  outputTools: readonly string[]
  profile: string
  provider?: string
  rebuildSessionLimit: number
  recallLimit: number
  recallQueryChars: number
  relevantArtifactLimit: number
  timeoutMs: number
  writeApproval: boolean
}

/**
 * Resolve defaults and validate the provider/model pair and the profile.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const hasProvider = config.provider !== undefined
  const hasModel = config.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('evolution-reviewer: provider and model must be supplied together')
  }
  const profile = config.profile ?? DEFAULT_PROFILE
  if (profile.length === 0) throw new Error('evolution-reviewer: profile must be non-empty')
  if (profile.includes(':')) {
    throw new Error(`evolution-reviewer: profile must not contain ':', got ${JSON.stringify(profile)}`)
  }
  return {
    cooldownMs: config.cooldownMs ?? 60000,
    defer: config.defer ?? 'auto',
    deferMaxAgeMs: config.deferMaxAgeMs ?? 1800000,
    enabled: config.enabled ?? true,
    maxInputBytes: config.maxInputBytes ?? 131072,
    maxOutputTokens: config.maxOutputTokens ?? 2048,
    minTurnTextBytes: config.minTurnTextBytes ?? 200,
    outputTools: config.outputTools ?? ['write', 'edit', 'str_replace_editor'],
    profile,
    rebuildSessionLimit: config.rebuildSessionLimit ?? 20,
    recallLimit: config.recallLimit ?? 20,
    recallQueryChars: config.recallQueryChars ?? 160,
    relevantArtifactLimit: config.relevantArtifactLimit ?? 20,
    timeoutMs: config.timeoutMs ?? 60000,
    writeApproval: config.writeApproval ?? false,
    ...hasProvider && hasModel ? { provider: config.provider, model: config.model } : {},
  }
}

/** Timeout reason code for review calls. */
export const EVOLUTION_REVIEW_TIMEOUT = 'EVOLUTION_REVIEW_TIMEOUT'

interface TranscriptRow {
  role: string
  text: string
}

/** One buffered tool call awaiting its result. */
interface BufferedCall {
  callId: string
  name: string
  args: string
}

/** The current turn's observable state, flushed at `turn/end`. */
interface TurnBuffer {
  turn: number
  rows: TranscriptRow[]
  calls: BufferedCall[]
  outcomes: Map<string, boolean>
}

/** One turn waiting behind the defer queue's deadline for its session. */
interface DeferredTurn {
  scope: EvolutionScopeId
  session: Session
  turn: number
  rows: TranscriptRow[]
  route: { provider: string; model: string }
  timer: ReturnType<typeof setTimeout>
}

/** Provenance of one extraction call, everything but its route and session. */
interface ExtractionMeta {
  at: string
  turn: number
  inputBytes: number
  origin: 'background_review' | 'rebuild'
}

/**
 * Drop what can still push a decision batch past the store's lessons cap: the
 * `new` decision carrying the longest statement, or — once no `new` decision is
 * left — every contradiction's replacement statement, which keeps its counter
 * bump and loses only the text update.
 *
 * A whole fact either fits or is deferred to a later turn, which is a cleaner
 * failure than a mid-sentence clip; a contradiction's counter is the fact the
 * decision reported, and its text is the part that can be deferred.
 * @param decisions - the batch the store rejected.
 * @returns the reduced batch and what was dropped, or undefined when nothing in
 * the batch can shrink it any further.
 */
function reduceOverCapBatch(
  decisions: readonly LessonDecision[],
): { decisions: LessonDecision[]; note: string } | undefined {
  let longest = -1
  let longestBytes = -1
  for (const [index, decision] of decisions.entries()) {
    if (decision.kind !== 'new') continue
    const bytes = utf8Bytes(decision.candidate.statement)
    if (bytes > longestBytes) {
      longestBytes = bytes
      longest = index
    }
  }
  if (longest !== -1) {
    return {
      decisions: decisions.filter((_, index) => index !== longest),
      note: `a new artifact statement of ${longestBytes} bytes`,
    }
  }
  const corrects = (decision: LessonDecision): boolean =>
    decision.kind === 'contradicts' && decision.statement !== undefined
  if (!decisions.some(corrects)) return undefined
  return {
    decisions: decisions.map(decision => corrects(decision) && decision.kind === 'contradicts'
      ? { kind: 'contradicts', artifactId: decision.artifactId, confidence: decision.confidence }
      : decision),
    note: "the contradictions' replacement statements",
  }
}

/**
 * Read the text of one message's content blocks.
 * @param content - message content blocks.
 * @returns concatenated text of the text blocks.
 */
function textOfContent(content: readonly { type: string; text?: string }[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Admit one live event into the extraction transcript. Only human
 * `user/message` and `assistant/message` rows pass; injected context never
 * feeds back into the document derived from it.
 * @param event - the live session event.
 * @returns the transcript row, or undefined when the event carries none.
 */
function admittedRow(event: SessionEvent): TranscriptRow | undefined {
  if (event.type === 'user/message') {
    const data = event.data as { source?: { kind?: string }; content: { type: string; text?: string }[] }
    if (data.source?.kind !== 'user') return undefined
    const text = textOfContent(data.content)
    return text.length === 0 ? undefined : { role: 'user', text }
  }
  if (event.type !== 'assistant/message') return undefined
  const message = (event.data as { message: { content: { type: string; text?: string }[] } }).message
  const text = textOfContent(message.content)
  return text.length === 0 ? undefined : { role: 'assistant', text }
}

/**
 * Decode one tool result into its call linkage and failure flag.
 * @param data - the result event data.
 * @returns the linked call outcome, or undefined when unlinked.
 */
function parseToolOutcome(
  data: { callId?: string; message: { content: readonly { toolCallId?: string; isError?: boolean }[] } },
): { callId: string; failed: boolean } | undefined {
  const block = data.message.content[0]
  const callId = data.callId ?? block?.toolCallId
  if (callId === undefined) return undefined
  return { callId, failed: block?.isError === true }
}

/**
 * Extract the produced-file path from tool arguments. The file key wins over
 * the path key; read-only editor commands never produce files.
 * @param name - tool name.
 * @param argsJson - raw JSON arguments.
 * @returns the trimmed path, or undefined when absent or unparseable.
 */
function producedPath(name: string, argsJson: string): string | undefined {
  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return undefined
  }
  if (typeof args !== 'object' || args === null) return undefined
  const fields = args as Record<string, unknown>
  if (name === 'str_replace_editor') {
    const command = fields['command']
    if (command === 'view' || command === 'undo_edit') return undefined
  }
  for (const key of ['file_path', 'path']) {
    const value = fields[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * Cap transcript rows to a UTF-8 budget, dropping the oldest first. A lone
 * over-budget row is kept whole instead of dropped.
 * @param rows - rows in chronological order.
 * @param maxBytes - transcript budget in UTF-8 bytes.
 * @returns the kept suffix and its byte size.
 */
function capRowsByBytes(rows: TranscriptRow[], maxBytes: number): { rows: TranscriptRow[]; inputBytes: number } {
  let start = 0
  while (start + 1 < rows.length && Buffer.byteLength(JSON.stringify(rows.slice(start)), 'utf8') > maxBytes) {
    start += 1
  }
  const kept = rows.slice(start)
  return { rows: kept, inputBytes: Buffer.byteLength(JSON.stringify(kept), 'utf8') }
}

/**
 * Report whether a resolved path stays inside the scope directory.
 * @param parent - scope directory.
 * @param child - resolved candidate path.
 * @returns whether the candidate is the directory or below it.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Split one finished model response into lessons text and truncation flag.
 * @param assembler - the settled block assembler.
 * @returns the joined text and whether the model stopped on its token cap.
 */
function finishText(assembler: BlockAssembler): { text: string; truncated: boolean } {
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    const error = new Error(finish.failure.message) as Error & { code?: string }
    error.code = finish.failure.code
    throw error
  }
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('evolution review extraction must return text only')
  }
  const text = blocks.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
  if (finish.kind === 'max-tokens') return { text, truncated: true }
  if (finish.kind !== 'stop') throw new Error(`evolution review extraction rejected finish '${finish.kind}'`)
  return { text, truncated: false }
}

/**
 * Read the workspace key out of a scope identity. Profiles never contain a
 * separator, so the first one divides the key.
 * @param scopeId - scope identity.
 * @returns the workspace key, or the whole key when no separator exists.
 */
function scopeWorkspaceKey(scopeId: EvolutionScopeId): string {
  const key = String(scopeId)
  const separator = key.indexOf(':')
  return separator === -1 ? key : key.slice(separator + 1)
}

/**
 * Derive the recall query from the newest human message of one turn.
 * @param rows - admitted transcript rows of the turn.
 * @param maxChars - cap on the normalized query text.
 * @returns the collapsed query, or undefined when the turn carries no human text.
 */
function recallQueryOf(rows: readonly TranscriptRow[], maxChars: number): string | undefined {
  const human = [...rows].reverse().find(row => row.role === 'user')
  if (human === undefined) return undefined
  const collapsed = human.text.replace(/\s+/gu, ' ').trim()
  return collapsed.length === 0 ? undefined : collapsed.slice(0, maxChars)
}

/**
 * Background reviewer. One scope never runs two extractions at once; a turn
 * is never blocked by one.
 */
export class EvolutionReviewer extends Service {
  static inject = ['llm', 'sessions', 'evolutionMemory', 'workspaceRegistry']

  private readonly resolved: ResolvedConfig
  private readonly buffers = new Map<string, TurnBuffer>()
  private readonly deferredTurns = new Map<string, DeferredTurn>()
  private readonly bySession = new Map<string, AbortController>()
  private readonly chains = new Map<string, Promise<void>>()
  private readonly inFlight = new Set<AbortController>()
  private readonly lastExtractionAt = new Map<string, number>()
  private readonly lastHumanText = new Map<string, string>()

  /**
   * @param ctx - Host context carrying the registry, store, and LLM.
   * @param config - review scheduling, budget, and route choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionReviewer')
    this.resolved = resolveConfig(config)
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.onSessionEvent(session, event)
    })
    ctx.on('session/disposed', (session: Session) => {
      const key = String(session.id)
      this.buffers.delete(key)
      this.dropDeferred(key)
      const controller = this.bySession.get(key)
      if (controller !== undefined) {
        controller.abort(new Error(`evolution review for session '${key}' disposed`))
        this.bySession.delete(key)
      }
    })
    ctx.effect(() => () => {
      for (const controller of this.inFlight) controller.abort(new Error('evolution reviewer disposed'))
      this.inFlight.clear()
      this.bySession.clear()
      this.buffers.clear()
      this.lastHumanText.clear()
      // Abort bound work; a queued turn is dropped, never started.
      for (const pending of this.deferredTurns.values()) clearTimeout(pending.timer)
      this.deferredTurns.clear()
    }, 'evolution-reviewer.teardown')
  }

  /**
   * Rebuild the scope's lessons from its chat history, read through the
   * asynchronous session query seam: ranked recall selects candidate events
   * first, and each one still passes the shared admission rule.
   *
   * A rebuild folds its findings into the artifacts already stored — the same
   * relevance-bounded decision protocol a live turn uses, run against the whole
   * selected history instead of one turn's buffer — so it confirms and corrects
   * what it finds rather than wiping what is there. Rebuilds write directly
   * even when background approval staging is on: the caller explicitly asked
   * for them.
   * @param scopeId - scope identity.
   * @param signal - caller cancellation.
   * @returns resolution after the store write.
   */
  async rebuild(scopeId: EvolutionScopeId, signal: AbortSignal): Promise<void> {
    const key = String(scopeId)
    const workspaceKey = scopeWorkspaceKey(scopeId)
    const workspace = workspaceKey === 'global'
      ? undefined
      : this.ctx.workspaceRegistry.get(WorkspaceId(workspaceKey))
    if (workspace === undefined) {
      if (workspaceKey === 'global') {
        throw new RemoteError(
          'evolution/extraction-failed',
          `evolution rebuild for '${key}' covers no workspace sessions`,
          { scopeId: key },
        )
      }
      throw new RemoteError('workspace/not-found', `Workspace "${workspaceKey}" not found`, {
        workspaceId: WorkspaceId(workspaceKey),
      })
    }
    const sessionQuery = this.ctx.get('sessionQuery')
    if (sessionQuery === undefined) {
      throw new RemoteError(
        'evolution/extraction-failed',
        `evolution rebuild for '${key}' needs the session query seam`,
        { scopeId: key },
      )
    }
    const sessionIds = this.rebuildableSessions(workspace)
    // Ranked recall selects the material; an absent or empty recall falls back
    // to the exact surface scan so a rebuild never replaces a document from
    // nothing.
    const ranked = await this.rankedRows(key, workspace.path, sessionIds)
    const rows = ranked ?? await this.exactRows(sessionQuery, sessionIds)
    const route = this.resolveRebuildRoute(sessionIds)
    if (route === undefined) {
      throw new RemoteError(
        'evolution/extraction-failed',
        `evolution rebuild for '${key}' resolved no model route`,
        { scopeId: key },
      )
    }
    // Rows accumulate oldest-session-first so the byte cap drops the oldest
    // text; the framed transcript is newest-session-first.
    const { rows: cappedOldest, inputBytes } = capRowsByBytes(rows, this.resolved.maxInputBytes)
    const framed = [...cappedOldest].reverse()
    const firstSession = sessionIds[0] ?? ('' as SessionId)
    await this.extract(scopeId, route, framed, signal, firstSession, {
      at: new Date().toISOString(),
      turn: 0,
      inputBytes,
      origin: 'rebuild',
    })
  }

  /**
   * Route one live event into the turn buffer or the turn-end flush.
   * @param session - owning session.
   * @param event - the delivered event.
   */
  private onSessionEvent(session: Session, event: SessionEvent): void {
    if (event.type === 'turn/start') {
      this.beginTurn(session, event.data.turn)
      return
    }
    if (event.type === 'turn/end') {
      void this.onTurnEnd(session, event.data.turn)
      return
    }
    this.bufferEvent(session, event)
  }

  /**
   * List the sessions a rebuild may read: archived sessions dropped, newest
   * first capped to the rebuild limit.
   * @param workspace - registry workspace holding the session roster.
   * @returns readable session ids in registry order.
   */
  private rebuildableSessions(workspace: { sessionIds: readonly SessionId[] }): SessionId[] {
    const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds.map(id => String(id)))
    return workspace.sessionIds
      .filter(id => !archived.has(String(id)))
      .slice(0, this.resolved.rebuildSessionLimit)
  }

  /**
   * Select rebuild material by rank instead of by scan: the ranked search
   * seam names the scope's own sessions inside one directory, and every
   * selected event still passes the shared admission rule.
   *
   * Rows accumulate least-relevant-first so the transcript byte cap drops
   * recall rather than the strongest match, and the caller's framing reversal
   * puts the strongest match first. An absent seam, no observed human text,
   * or a failing search returns undefined so the caller scans exactly.
   * @param scopeKey - storage-facing scope identity used by the log messages.
   * @param directory - scope directory every selected session must sit in.
   * @param sessionIds - authorized session roster of the scope.
   * @returns admitted rows, or undefined when ranked recall cannot run.
   */
  private async rankedRows(
    scopeKey: string,
    directory: string,
    sessionIds: readonly SessionId[],
  ): Promise<TranscriptRow[] | undefined> {
    const sessionQuery = this.ctx.get('sessionQuery')
    if (sessionQuery?.searchSessions === undefined
      || sessionQuery.searchEvents === undefined
      || sessionQuery.readEvent === undefined) return undefined
    const query = this.lastHumanText.get(scopeKey)
    if (query === undefined) return undefined
    try {
      const sessions = await sessionQuery.searchSessions({
        query,
        sessionFilters: [
          { kind: 'id', values: [...sessionIds] },
          { kind: 'cwd', values: [directory] },
        ],
        limit: this.resolved.recallLimit,
      })
      const rows: TranscriptRow[] = []
      for (const session of [...sessions.items].reverse()) {
        const events = await sessionQuery.searchEvents({
          sessionId: session.header.id,
          query,
          filters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }],
          limit: this.resolved.recallLimit,
        })
        for (const hit of [...events.items].reverse()) {
          const window = await sessionQuery.readEvent({ sessionId: session.header.id, seq: hit.seq })
          const row = admittedRow(window.target)
          if (row !== undefined) rows.push(row)
        }
      }
      return rows.length === 0 ? undefined : rows
    } catch (error) {
      this.ctx.logger.warn(`evolution rebuild ranked recall failed for '${scopeKey}': ${String(error)}`)
      return undefined
    }
  }

  /**
   * Read every roster session's current surface and admit it through the same
   * rule the live path uses.
   * @param sessionQuery - mounted session query seam.
   * @param sessionIds - authorized session roster, newest first.
   * @returns admitted rows, oldest session first.
   */
  private async exactRows(
    sessionQuery: SessionQueryEngine,
    sessionIds: readonly SessionId[],
  ): Promise<TranscriptRow[]> {
    const rows: TranscriptRow[] = []
    for (const sessionId of [...sessionIds].reverse()) {
      try {
        const { events } = await sessionQuery.readSurface(sessionId)
        for (const event of events) {
          const row = admittedRow(event)
          if (row !== undefined) rows.push(row)
        }
      } catch (error) {
        this.ctx.logger.warn(`evolution review rebuild skipped session '${String(sessionId)}': ${String(error)}`)
      }
    }
    return rows
  }

  private beginTurn(session: Session, turn: number): void {
    this.buffers.set(String(session.id), { turn, rows: [], calls: [], outcomes: new Map() })
  }

  private bufferEvent(session: Session, event: SessionEvent): void {
    const buffered = this.buffers.get(String(session.id))
    if (buffered === undefined) return
    const row = admittedRow(event)
    if (row !== undefined) {
      buffered.rows.push(row)
      return
    }
    if (event.type === 'tool/call') {
      const data = event.data as { callId: string; name: string; arguments: string }
      buffered.calls.push({ callId: data.callId, name: data.name, args: data.arguments })
    } else if (event.type === 'tool/result') {
      const outcome = parseToolOutcome(event.data)
      if (outcome !== undefined) buffered.outcomes.set(outcome.callId, outcome.failed)
    }
  }

  private async onTurnEnd(session: Session, turn: number): Promise<void> {
    // Background derivation must never reject into the session observer:
    // disposal or storage races fail soft with a warning instead.
    const key = String(session.id)
    const buffered = this.buffers.get(key)
    this.buffers.delete(key)
    try {
      await this.observeTurn(session, turn, buffered)
    } catch (error) {
      this.ctx.logger.warn(`evolution review turn observation failed: ${String(error)}`)
    }
  }

  private async observeTurn(session: Session, turn: number, buffered: TurnBuffer | undefined): Promise<void> {
    const membership = await this.resolveWorkspace(session)
    if (membership === undefined) return
    await this.indexOutputs(session, membership, buffered)
    const rows = buffered?.rows ?? []
    // The newest human request is remembered for a later ranked rebuild even
    // while background extraction is off.
    const scopeKey = String(membership.scope)
    const query = recallQueryOf(rows, this.resolved.recallQueryChars)
    if (query !== undefined) this.lastHumanText.set(scopeKey, query)
    if (!this.resolved.enabled) return
    await this.refreshRecall(session, membership, query)
    const admittedBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.text, 'utf8'), 0)
    if (admittedBytes < this.resolved.minTurnTextBytes) return
    const now = Date.now()
    const last = this.lastExtractionAt.get(scopeKey) ?? Number.NEGATIVE_INFINITY
    if (now - last < this.resolved.cooldownMs) return
    const route = this.resolveTurnRoute(session)
    if (route === undefined) {
      this.ctx.logger.warn(`evolution review extraction skipped for '${scopeKey}': no model route`)
      return
    }
    if (this.resolved.defer === 'never') {
      this.enqueueExtraction(membership.scope, session, turn, rows, route)
      return
    }
    this.queueDeferred(membership.scope, session, turn, rows, route)
  }

  /**
   * Replace the scope's single recalled context item with the strongest
   * ranked hit for this turn's human request, so the next brief carries
   * prior work the scope already did.
   *
   * Ranked recall only. The hit must come from a session in the scope
   * directory, must not be the asking session itself, and must pass the same
   * admission rule the transcript uses — an injected brief or instruction
   * message is never recalled back into the context it came from. A missing
   * search seam, a failed search, or an unchanged recall writes nothing, and
   * a store rejection warns instead of failing the turn.
   * @param session - session whose turn just ended.
   * @param membership - resolved scope and directory of that session.
   * @param query - recall query derived from the turn, absent without human text.
   */
  private async refreshRecall(
    session: Session,
    membership: { scope: EvolutionScopeId; path: string },
    query: string | undefined,
  ): Promise<void> {
    if (query === undefined) return
    const sessionQuery = this.ctx.get('sessionQuery')
    if (sessionQuery?.searchSessions === undefined || sessionQuery.readEvent === undefined) return
    try {
      const sessions = await sessionQuery.searchSessions({
        query,
        sessionFilters: [{ kind: 'cwd', values: [membership.path] }],
        limit: this.resolved.recallLimit,
      })
      const hit = sessions.items.find(candidate => String(candidate.header.id) !== String(session.id))
      if (hit === undefined) return
      const window = await sessionQuery.readEvent({ sessionId: hit.header.id, seq: hit.bestMatch.seq })
      if (admittedRow(window.target) === undefined) return
      const label = `${RECALL_LABEL_PREFIX}${String(hit.header.id)}`
      const text = hit.bestMatch.snippet
      const existing = this.ctx.evolutionMemory.read(membership.scope)?.contextItems
        .filter(item => item.label.startsWith(RECALL_LABEL_PREFIX)) ?? []
      if (existing.length === 1 && existing[0]?.kind === 'text' && existing[0].label === label && existing[0].text === text) return
      for (const item of existing) await this.ctx.evolutionMemory.removeContextItem(membership.scope, item.id)
      await this.ctx.evolutionMemory.addContextItem(membership.scope, { kind: 'text', label, text })
    } catch (error) {
      this.ctx.logger.warn(`evolution review recall failed for '${String(membership.scope)}': ${String(error)}`)
    }
  }

  /**
   * Queue one turn for extraction at its session's defer deadline.
   *
   * A turn that closes before the flush replaces the pending entry's snapshot
   * (turn, rows, route) while the original deadline and timer stand: a busy
   * session coalesces into one extraction that never runs later than its first
   * snapshot's deadline. The cooldown was checked when the turn was queued and
   * is deliberately not re-checked at flush time.
   * @param scope - resolved workspace scope.
   * @param session - owning session, whose id keys the queue.
   * @param turn - turn number of the snapshot.
   * @param rows - admitted transcript rows of the snapshot.
   * @param route - resolved model route of the snapshot.
   */
  private queueDeferred(
    scope: EvolutionScopeId,
    session: Session,
    turn: number,
    rows: TranscriptRow[],
    route: { provider: string; model: string },
  ): void {
    const key = String(session.id)
    const pending = this.deferredTurns.get(key)
    if (pending !== undefined) {
      pending.turn = turn
      pending.rows = rows
      pending.route = route
      return
    }
    const timer = setTimeout(() => {
      this.flushDeferred(key)
    }, this.resolved.deferMaxAgeMs)
    // Node-only host: the queue must never pin the event loop open; a timer
    // type without `unref` (browser-like) simply stays ref'd.
    const nodeTimer: { unref?: () => void } = timer
    nodeTimer.unref?.()
    this.deferredTurns.set(key, {
      scope,
      session,
      turn,
      rows,
      route,
      timer,
    })
  }

  /**
   * Run a due deferred turn through the immediate path's per-scope chain.
   * @param key - session id keying the queue.
   */
  private flushDeferred(key: string): void {
    const pending = this.deferredTurns.get(key)
    // A dropped entry may still reach here when its already-armed timer fires;
    // disposal and teardown abort bound work instead of starting it.
    if (pending === undefined) return
    this.deferredTurns.delete(key)
    this.enqueueExtraction(pending.scope, pending.session, pending.turn, pending.rows, pending.route)
  }

  /**
   * Drop one session's queued turn without extracting it.
   * @param key - session id keying the queue.
   */
  private dropDeferred(key: string): void {
    const pending = this.deferredTurns.get(key)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.deferredTurns.delete(key)
  }

  /**
   * Run one extraction behind its scope's chain, so a scope never runs two at
   * once. The entry drops itself when no later turn superseded it.
   * @param scope - resolved workspace scope.
   * @param session - owning session.
   * @param turn - turn number the snapshot came from.
   * @param rows - admitted transcript rows.
   * @param route - resolved model route.
   */
  private enqueueExtraction(
    scope: EvolutionScopeId,
    session: Session,
    turn: number,
    rows: readonly TranscriptRow[],
    route: { provider: string; model: string },
  ): void {
    const scopeKey = String(scope)
    const previous = this.chains.get(scopeKey) ?? Promise.resolve()
    const current = previous.then(async () => {
      await this.runExtraction(scope, session, turn, rows, route)
    })
    this.chains.set(scopeKey, current)
    void current.then(() => {
      if (this.chains.get(scopeKey) === current) this.chains.delete(scopeKey)
    })
  }

  private async runExtraction(
    scope: EvolutionScopeId,
    session: Session,
    turn: number,
    rows: readonly TranscriptRow[],
    route: { provider: string; model: string },
  ): Promise<void> {
    const controller = new AbortController()
    this.inFlight.add(controller)
    this.bySession.set(String(session.id), controller)
    try {
      const { rows: capped, inputBytes } = capRowsByBytes([...rows], this.resolved.maxInputBytes)
      await this.extract(scope, route, capped, controller.signal, session.id, {
        at: new Date().toISOString(),
        turn,
        inputBytes,
        origin: 'background_review',
      })
      this.lastExtractionAt.set(String(scope), Date.now())
    } catch (error) {
      this.ctx.logger.warn(`evolution review extraction failed for '${String(scope)}': ${String(error)}`)
    } finally {
      this.inFlight.delete(controller)
      if (this.bySession.get(String(session.id)) === controller) this.bySession.delete(String(session.id))
    }
  }

  private async indexOutputs(
    session: Session,
    membership: { scope: EvolutionScopeId; path: string },
    buffered: TurnBuffer | undefined,
  ): Promise<void> {
    if (buffered === undefined) return
    const tools = new Set(this.resolved.outputTools)
    const cwd = session.header.cwd ?? process.cwd()
    const entries: EvolutionOutput[] = []
    for (const call of buffered.calls) {
      const entry = await this.producedEntry(session, membership.path, tools, cwd, call, buffered.outcomes)
      if (entry !== undefined) entries.push(entry)
    }
    if (entries.length === 0) return
    try {
      await this.ctx.evolutionMemory.recordOutputs(membership.scope, entries)
      const record = this.ctx.evolutionMemory.read(membership.scope)
      if (record !== undefined && record.outputs.length > 0) {
        const evidence = skillCreationEvidence(record.outputs.map(output => output.path))
        if (evidence.fires) {
          const gist = `Repeated output${evidence.repeated.length > 1 ? 's' : ''}: ${evidence.repeated.map(r => r.path).join(', ')}`
          try {
            await this.ctx.evolutionMemory.stageWrite({
              scopeId: membership.scope,
              kind: 'skill',
              op: 'create',
              payload: { paths: evidence.repeated.map(r => r.path), counts: evidence.repeated.map(r => r.count) },
              originSessionId: String(session.id),
              gist,
            })
          } catch (error) {
            this.ctx.logger.warn(`evolution review skill proposal staging failed: ${String(error)}`)
          }
        }
      }
    } catch (error) {
      this.ctx.logger.warn(`evolution review output indexing failed for '${String(membership.scope)}': ${String(error)}`)
    }
  }

  /**
   * Resolve one buffered tool call to a produced-file entry.
   * @param session - owning session for identity and timestamps.
   * @param directory - scope directory bounding the index.
   * @param tools - tool names counting as productions.
   * @param cwd - fallback directory for relative paths.
   * @param call - the buffered call.
   * @param outcomes - call outcomes by call id.
   * @returns the entry, or undefined when the call produced no indexed file.
   */
  private async producedEntry(
    session: Session,
    directory: string,
    tools: ReadonlySet<string>,
    cwd: string,
    call: BufferedCall,
    outcomes: ReadonlyMap<string, boolean>,
  ): Promise<EvolutionOutput | undefined> {
    if (!tools.has(call.name)) return undefined
    if (outcomes.get(call.callId) !== false) return undefined
    const raw = producedPath(call.name, call.args)
    if (raw === undefined) return undefined
    const resolved = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
    // A missing file resolves to itself: it may still be inside the
    // scope (created later) and is indexed by its resolved path.
    const canonical = await realpath(resolved).catch(() => resolved)
    if (!isInside(directory, canonical)) return undefined
    return { path: canonical, tool: call.name, sessionId: String(session.id), at: new Date().toISOString() }
  }

  private async resolveWorkspace(session: Session): Promise<{ scope: EvolutionScopeId; path: string } | undefined> {
    const direct = this.ctx.workspaceRegistry.list().find(workspace => workspace.sessionIds.includes(session.id))
    if (direct !== undefined) return { scope: EvolutionScopeId(this.resolved.profile, String(direct.id)), path: direct.path }
    const cwd = session.header.cwd
    const canonical = cwd === undefined ? undefined : await realpath(cwd).catch(() => undefined)
    if (canonical === undefined) return undefined
    const byPath = this.ctx.workspaceRegistry.list().find(workspace => workspace.path === canonical)
    return byPath === undefined
      ? undefined
      : { scope: EvolutionScopeId(this.resolved.profile, String(byPath.id)), path: byPath.path }
  }

  /**
   * Read the configured route override, if the composition names a pair.
   * @returns the override route, or undefined when unset.
   */
  private configuredRoute(): { provider: string; model: string } | undefined {
    return this.resolved.provider !== undefined && this.resolved.model !== undefined
      ? { provider: this.resolved.provider, model: this.resolved.model }
      : undefined
  }

  private resolveTurnRoute(session: Session): { provider: string; model: string } | undefined {
    const header = session.requestHeader()
    return this.configuredRoute() ?? (header === undefined
      ? undefined
      : { provider: header.config.provider, model: header.config.model })
  }

  private resolveRebuildRoute(sessionIds: readonly SessionId[]): { provider: string; model: string } | undefined {
    const routed = sessionIds
      .map(id => this.ctx.sessions.get(id)?.requestHeader())
      .find(header => header !== undefined)
    return this.configuredRoute() ?? (routed === undefined
      ? undefined
      : { provider: routed.config.provider, model: routed.config.model })
  }

  /**
   * Run one extraction call end to end and fold its decisions into the scope:
   * rank the scope's current artifacts against this call's transcript, show the
   * model the relevance-bounded indexed slice beside that transcript, then
   * resolve every decision back to a real artifact id and apply the batch as
   * one write — staged for approval when background approval is configured.
   * @param scope - scope identity.
   * @param route - resolved model route.
   * @param rows - transcript rows, already byte-capped.
   * @param signal - caller cancellation.
   * @param sessionId - the extracting session, stamped on every new candidate.
   * @param meta - provenance of the call.
   */
  private async extract(
    scope: EvolutionScopeId,
    route: { provider: string; model: string },
    rows: readonly TranscriptRow[],
    signal: AbortSignal,
    sessionId: SessionId,
    meta: ExtractionMeta,
  ): Promise<void> {
    const relevant = await this.indexedArtifacts(scope, rows)
    const response = await this.callModel(route, rows, relevant, signal, sessionId)
    const decisions = this.resolveDecisions(parseExtractionDecisions(response.text), relevant, String(sessionId))
    await this.applyExtraction(scope, decisions, {
      at: meta.at,
      sessionId: String(sessionId),
      provider: route.provider,
      model: route.model,
      origin: meta.origin,
      inputBytes: meta.inputBytes,
      truncated: response.truncated,
    }, meta.turn)
  }

  /**
   * Number the artifacts one extraction call may reference: the relevance-
   * bounded slice of the scope's current artifacts for this call's transcript,
   * numbered from 1 so the model addresses them without ever seeing an id.
   * @param scope - scope identity.
   * @param rows - the transcript rows this call shows the model.
   * @returns the indexed artifacts, in the order the prompt lists them.
   */
  private async indexedArtifacts(scope: EvolutionScopeId, rows: readonly TranscriptRow[]): Promise<IndexedArtifact[]> {
    const artifacts = this.ctx.evolutionMemory.read(scope)?.agentLessons ?? []
    const queryText = rows.map(row => row.text).join('\n')
    const relevant = await selectRelevantArtifacts(this.ctx, artifacts, queryText, this.resolved.relevantArtifactLimit)
    return relevant.map((artifact, offset) => ({ index: offset + 1, artifact }))
  }

  /**
   * Resolve the model's index-addressed decisions into the store's id-addressed
   * ones, against the exact list this call sent. The parser accepts any index
   * of 1 or more, so one outside that list is malformed: it is dropped with a
   * warning rather than failing the whole batch, the same tolerance the store
   * shows a decision naming an artifact a concurrent prune removed.
   *
   * A `new` candidate takes its `source` from this extraction's session, which
   * only the caller knows: the model's decision carries no provenance field.
   * @param decisions - the decisions the model reported.
   * @param relevant - the indexed artifacts this call was shown.
   * @param source - session id stamped on every new candidate.
   * @returns the resolvable decisions, in reported order.
   */
  private resolveDecisions(
    decisions: readonly ExtractionDecision[],
    relevant: readonly IndexedArtifact[],
    source: string,
  ): LessonDecision[] {
    const resolved: LessonDecision[] = []
    for (const decision of decisions) {
      if (decision.action === 'new') {
        resolved.push({
          kind: 'new',
          candidate: {
            statement: decision.statement,
            source,
            conditions: decision.conditions,
            evidence: decision.evidence,
            confidence: decision.confidence,
            scope: decision.scope,
            ...decision.ttlDays === undefined ? {} : { ttlDays: decision.ttlDays },
          },
        })
        continue
      }
      const artifactId = relevant[decision.index - 1]?.artifact.id
      if (artifactId === undefined) {
        this.ctx.logger.warn(
          `evolution review dropped a ${decision.action} decision naming index ${decision.index},`
          + ` outside the ${relevant.length} artifacts this call was shown`,
        )
        continue
      }
      resolved.push(decision.action === 'confirms'
        ? { kind: 'confirms', artifactId }
        : {
          kind: 'contradicts',
          artifactId,
          ...decision.statement === undefined ? {} : { statement: decision.statement },
          ...decision.confidence === undefined ? {} : { confidence: decision.confidence },
        })
    }
    return resolved
  }

  /**
   * Write one resolved decision batch: staged as a single `applyDecisions`
   * entry when background approval is configured, applied directly otherwise.
   * A rebuild always writes directly — the caller explicitly asked for it — and
   * an empty batch carries nothing to approve, so it applies as the provenance
   * stamp it is.
   * @param scope - scope identity.
   * @param decisions - the resolved batch.
   * @param extraction - provenance of the call that produced the batch.
   * @param turn - the turn the batch was extracted from, named in the staged gist.
   */
  private async applyExtraction(
    scope: EvolutionScopeId,
    decisions: readonly LessonDecision[],
    extraction: EvolutionExtraction,
    turn: number,
  ): Promise<void> {
    if (this.resolved.writeApproval && extraction.origin === 'background_review' && decisions.length > 0) {
      await this.ctx.evolutionMemory.stageWrite({
        scopeId: scope,
        kind: 'memory',
        op: 'applyDecisions',
        // The payload is a JSON record field; the store validates it at its
        // own write boundary.
        payload: { decisions, extraction } as unknown as JsonValue,
        originSessionId: extraction.sessionId,
        gist: `${gistOf(decisions)} from turn ${turn} of session '${extraction.sessionId}'`,
      })
      return
    }
    await this.writeDecisions(scope, decisions, extraction)
  }

  /**
   * Apply one decision batch, shedding what makes it too large for the store's
   * lessons cap instead of failing the turn.
   *
   * The cap can be exceeded by any combination of the batch's statements, so a
   * rejected batch drops the longest `new` statement and retries; once no `new`
   * decision is left, the contradictions' replacement statements go next. The
   * retry count is bounded by the batch's own `new` count plus one, after which
   * there is nothing left to drop and the failure propagates.
   * @param scope - scope identity.
   * @param decisions - the resolved batch.
   * @param extraction - provenance of the call that produced the batch.
   */
  private async writeDecisions(
    scope: EvolutionScopeId,
    decisions: readonly LessonDecision[],
    extraction: EvolutionExtraction,
  ): Promise<void> {
    let pending = decisions
    let provenance = extraction
    let retries = decisions.filter(decision => decision.kind === 'new').length + 1
    for (;;) {
      try {
        await this.ctx.evolutionMemory.applyExtractionDecisions(scope, pending, provenance)
        return
      } catch (error) {
        const failure = remoteErrorOf(error)
        if (failure?.code !== 'evolution/too-large' || retries === 0) throw error
        const reduced = reduceOverCapBatch(pending)
        if (reduced === undefined) throw error
        retries -= 1
        this.ctx.logger.warn(
          `evolution review extraction for '${String(scope)}' exceeds the store's lessons cap;`
          + ` dropping ${reduced.note} and retrying`,
        )
        pending = reduced.decisions
        provenance = { ...provenance, truncated: true }
      }
    }
  }

  /**
   * Call the model once with the indexed artifact list and this call's
   * transcript, and settle its answer.
   * @param route - resolved model route.
   * @param rows - transcript rows, already byte-capped.
   * @param relevant - the numbered artifacts the prompt lists.
   * @param signal - caller cancellation.
   * @param sessionId - the extracting session.
   * @returns the settled answer text and whether the model stopped on its cap.
   */
  private async callModel(
    route: { provider: string; model: string },
    rows: readonly TranscriptRow[],
    relevant: readonly IndexedArtifact[],
    signal: AbortSignal,
    sessionId: SessionId,
  ): Promise<{ text: string; truncated: boolean }> {
    using callDeadline = deadline(signal, this.resolved.timeoutMs, EVOLUTION_REVIEW_TIMEOUT)
    const framed = frameExtractionRequest(rows, relevant)
    const messages = [createUserMessage({
      content: [{ type: 'text', text: framed }],
      source: { kind: 'plugin', plugin: 'dsh-evolution-reviewer' },
    })]
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages,
      system: extractionSystemPrompt(),
      maxTokens: this.resolved.maxOutputTokens,
      temperature: 0,
      purpose: 'evolution-review',
      sessionId,
      signal: callDeadline.signal,
    }
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    return finishText(assembler)
  }
}

/**
 * One-line summary of a decision batch, the gist a staged entry carries.
 * @param decisions - the resolved batch.
 * @returns the confirms/contradicts/new counts.
 */
function gistOf(decisions: readonly LessonDecision[]): string {
  const count = (kind: LessonDecision['kind']): number => decisions.filter(decision => decision.kind === kind).length
  return `${count('confirms')} confirms, ${count('contradicts')} contradicts, ${count('new')} new`
}

export default EvolutionReviewer
