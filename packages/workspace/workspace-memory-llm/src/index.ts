/**
 * Workspace memory extractor (`ctx.workspaceMemoryExtractor`): per-turn
 * produced-file indexing, gated per-turn memory extraction, and on-demand
 * rebuild from chat history. Extraction is a deterministic derivation;
 * failures log a warning and leave the previous document intact.
 * @module @deepseek-ai/dsh-workspace-memory-llm
 */

import { isAbsolute, relative, resolve } from 'node:path'
import { realpath } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { deadline } from '@deepseek-ai/dsh-timeout'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {} from '@deepseek-ai/dsh-workspace-memory'
import type { WorkspaceOutput } from '@deepseek-ai/dsh-workspace-memory/types'
import { extractionSystemPrompt, frameExtractionInput, truncateUtf8Bytes } from './prompt.ts'

export { extractionSystemPrompt, frameExtractionInput } from './prompt.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'workspace-memory-llm': { kind: 'workspace-memory-llm' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Background workspace-memory derivation owner. */
    workspaceMemoryExtractor: WorkspaceMemoryExtractor
  }
}

/** Deployment choices for extraction scheduling and budgets. */
export interface Config {
  /** Whether a completed turn triggers extraction; output indexing always runs. */
  autoExtract?: boolean
  /** Skip extraction for trivial turns below this admitted-text byte size. */
  minTurnTextBytes?: number
  /** Minimum gap between two extractions for one Workspace. */
  cooldownMs?: number
  /** Transcript budget per call in UTF-8 bytes. */
  maxInputBytes?: number
  /** Output token cap per call. */
  maxOutputTokens?: number
  /** Call deadline in milliseconds. */
  timeoutMs?: number
  /** Sessions scanned by a rebuild. */
  rebuildSessionLimit?: number
  /** Which successful tool calls count as productions. */
  outputTools?: string[]
  /** Route override provider; must be paired with `model`. */
  provider?: string
  /** Route override model; must be paired with `provider`. */
  model?: string
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  autoExtract: z.boolean().default(true),
  minTurnTextBytes: z.number().step(1).min(0).default(200),
  cooldownMs: z.number().step(1).min(0).default(60000),
  maxInputBytes: z.number().step(1).min(1).default(131072),
  maxOutputTokens: z.number().step(1).min(1).default(1024),
  timeoutMs: z.number().step(1).min(1).default(60000),
  rebuildSessionLimit: z.number().step(1).min(1).default(20),
  outputTools: z.array(z.string()).default(['write', 'edit', 'str_replace_editor']),
  provider: z.string(),
  model: z.string(),
})

/** Normalized configuration. */
export interface ResolvedConfig {
  autoExtract: boolean
  minTurnTextBytes: number
  cooldownMs: number
  maxInputBytes: number
  maxOutputTokens: number
  timeoutMs: number
  rebuildSessionLimit: number
  outputTools: readonly string[]
  provider?: string
  model?: string
}

/**
 * Resolve defaults and validate the provider/model pair.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const hasProvider = config.provider !== undefined
  const hasModel = config.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('workspace-memory-llm: provider and model must be supplied together')
  }
  return {
    autoExtract: config.autoExtract ?? true,
    minTurnTextBytes: config.minTurnTextBytes ?? 200,
    cooldownMs: config.cooldownMs ?? 60000,
    maxInputBytes: config.maxInputBytes ?? 131072,
    maxOutputTokens: config.maxOutputTokens ?? 1024,
    timeoutMs: config.timeoutMs ?? 60000,
    rebuildSessionLimit: config.rebuildSessionLimit ?? 20,
    outputTools: config.outputTools ?? ['write', 'edit', 'str_replace_editor'],
    ...hasProvider && hasModel ? { provider: config.provider, model: config.model } : {},
  }
}

/** Timeout reason code for extraction calls. */
export const WORKSPACE_MEMORY_TIMEOUT = 'WORKSPACE_MEMORY_TIMEOUT'

interface TranscriptRow {
  role: string
  text: string
}

function textOfContent(content: readonly ContentBlock[]): string {
  return content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

function admittedRows(events: readonly SessionEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      if (event.data.source.kind !== 'user') continue
      const text = textOfContent(event.data.content)
      if (text.length > 0) rows.push({ role: 'user', text })
    } else if (event.type === 'assistant/message') {
      const text = textOfContent(event.data.message.content)
      if (text.length > 0) rows.push({ role: 'assistant', text })
    }
  }
  return rows
}

function capRowsByBytes(rows: TranscriptRow[], maxBytes: number): { rows: TranscriptRow[]; inputBytes: number } {
  let kept: TranscriptRow[] = []
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = [rows[index] as TranscriptRow, ...kept]
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
    if (candidateBytes > maxBytes && kept.length > 0) break
    if (candidateBytes > maxBytes) {
      kept = [rows[index] as TranscriptRow]
      break
    }
    kept = candidate
  }
  return { rows: kept, inputBytes: Buffer.byteLength(JSON.stringify(kept), 'utf8') }
}

function parseProducedPath(name: string, argsJson: string): string | undefined {
  let args: unknown
  try {
    args = JSON.parse(argsJson)
  } catch {
    return undefined
  }
  if (typeof args !== 'object' || args === null) return undefined
  const record = args as Record<string, unknown>
  if (name === 'str_replace_editor') {
    const command = record['command']
    if (command === 'view' || command === 'undo_edit') return undefined
  }
  const filePath = record['file_path']
  if (typeof filePath === 'string' && filePath.trim().length > 0) return filePath.trim()
  const path = record['path']
  if (typeof path === 'string' && path.trim().length > 0) return path.trim()
  return undefined
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Background extractor. One Workspace never runs two extractions at once;
 * a turn is never blocked by one.
 */
export class WorkspaceMemoryExtractor extends Service {
  static inject = ['llm', 'sessions', 'workspaceMemory', 'workspaceRegistry']

  private readonly resolved: ResolvedConfig
  private readonly chains = new Map<string, Promise<void>>()
  private readonly lastExtractionAt = new Map<string, number>()
  private readonly inFlight = new Set<AbortController>()
  private readonly bySession = new Map<string, AbortController>()

  /**
   * @param ctx - Host context carrying the registry, store, and LLM.
   * @param config - extraction scheduling, budget, and route choices.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspaceMemoryExtractor')
    this.resolved = resolveConfig(config)
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (event.type !== 'turn/end') return
      void this.onTurnEnd(session, event.data.turn)
    })
    ctx.on('session/disposed', (session: Session) => {
      const controller = this.bySession.get(String(session.id))
      if (controller !== undefined) {
        controller.abort(new Error(`workspace-memory extraction for session '${String(session.id)}' disposed`))
        this.bySession.delete(String(session.id))
      }
    })
    ctx.effect(() => () => {
      for (const controller of this.inFlight) controller.abort(new Error('workspace-memory extractor disposed'))
      this.inFlight.clear()
      this.bySession.clear()
    }, 'workspace-memory-llm.teardown')
  }

  /**
   * Rebuild the document from the Workspace's chat history.
   * @param workspaceId - Workspace identity.
   * @param signal - caller cancellation.
   * @returns resolution after the store write.
   */
  async rebuild(workspaceId: WorkspaceId, signal: AbortSignal): Promise<void> {
    const workspace = this.ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) {
      throw new RemoteError('workspace/not-found', `Workspace "${String(workspaceId)}" not found`, {
        workspaceId,
      })
    }
    const archived = new Set((this.ctx.workspaceRegistry.archivedSessionIds).map(String))
    const sessionIds = (workspace.sessionIds)
      .filter(id => !archived.has(String(id)))
      .slice(0, this.resolved.rebuildSessionLimit)
    const rows: TranscriptRow[] = []
    const sessionQuery = this.ctx.get('sessionQuery')
    for (const sessionId of [...sessionIds].reverse()) {
      try {
        if (sessionQuery?.filterEvents !== undefined) {
          const docs = await sessionQuery.filterEvents(sessionId, [
            { kind: 'type', values: ['user/message', 'assistant/message'] },
          ])
          for (const doc of docs) {
            const text = (doc as { text?: string }).text ?? ''
            if (text.length === 0) continue
            rows.push({ role: 'user', text })
          }
        } else {
          const live = this.ctx.sessions.get(sessionId)
          if (live === undefined) continue
          // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
          for (const event of live.ownEvents()) {
            if (event.type === 'user/message') {
              const text = textOfContent(event.data.content)
              if (text.length > 0) rows.push({ role: 'user', text })
            } else if (event.type === 'assistant/message') {
              const text = textOfContent(event.data.message.content)
              if (text.length > 0) rows.push({ role: 'assistant', text })
            }
          }
        }
      } catch (error) {
        this.ctx.logger.warn(`workspace-memory rebuild skipped session '${String(sessionId)}': ${String(error)}`)
      }
    }
    const route = this.resolveRebuildRoute(sessionIds)
    if (route === undefined) {
      throw new RemoteError(
        'workspace-memory/extraction-failed',
        `workspace-memory rebuild for '${String(workspaceId)}' resolved no model route`,
        { workspaceId: String(workspaceId) },
      )
    }
    // Rows accumulate oldest-Session-first so the byte cap drops the oldest
    // text; the framed transcript is newest-Session-first.
    const { rows: cappedOldest, inputBytes } = capRowsByBytes(rows, this.resolved.maxInputBytes)
    const capped = [...cappedOldest].reverse()
    const firstSession = sessionIds[0] ?? ('' as SessionId)
    const document = await this.callModel(route, capped, '', signal, firstSession)
    await this.storeDocument(workspaceId, document.text, {
      at: new Date().toISOString(),
      sessionId: String(firstSession),
      provider: route.provider,
      model: route.model,
      inputBytes,
      truncated: document.truncated,
    })
  }

  private async onTurnEnd(session: Session, turn: number): Promise<void> {
    // Background derivation must never reject into the session observer:
    // disposal or storage races fail soft with a warning instead.
    try {
      await this.observeTurn(session, turn)
    } catch (error) {
      this.ctx.logger.warn(`workspace-memory turn observation failed: ${String(error)}`)
    }
  }

  private async observeTurn(session: Session, turn: number): Promise<void> {
    const membership = await this.resolveWorkspace(session)
    if (membership === undefined) return
    const events = this.turnEvents(session, turn)
    await this.indexOutputs(session, membership, events)
    if (!this.resolved.autoExtract) return
    const rows = admittedRows(events)
    const admittedBytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.text, 'utf8'), 0)
    if (admittedBytes < this.resolved.minTurnTextBytes) return
    const now = Date.now()
    const last = this.lastExtractionAt.get(String(membership.id)) ?? Number.NEGATIVE_INFINITY
    if (now - last < this.resolved.cooldownMs) return
    const route = this.resolveTurnRoute(session)
    if (route === undefined) {
      this.ctx.logger.warn(`workspace-memory extraction skipped for '${membership.id}': no model route`)
      return
    }
    const key = String(membership.id)
    const previous = this.chains.get(key) ?? Promise.resolve()
    const current = previous.then(async () => {
      const controller = new AbortController()
      this.inFlight.add(controller)
      this.bySession.set(String(session.id), controller)
      try {
        const { rows: capped, inputBytes } = capRowsByBytes(rows, this.resolved.maxInputBytes)
        const record = this.ctx.workspaceMemory.read(membership.id)
        const document = await this.callModel(route, capped, record?.memory ?? '', controller.signal, session.id)
        await this.storeDocument(membership.id, document.text, {
          at: new Date().toISOString(),
          sessionId: String(session.id),
          provider: route.provider,
          model: route.model,
          inputBytes,
          truncated: document.truncated,
        })
        this.lastExtractionAt.set(key, Date.now())
      } catch (error) {
        this.ctx.logger.warn(`workspace-memory extraction failed for '${membership.id}': ${String(error)}`)
      } finally {
        this.inFlight.delete(controller)
        if (this.bySession.get(String(session.id)) === controller) this.bySession.delete(String(session.id))
      }
    })
    this.chains.set(key, current)
    void current.then(() => {
      if (this.chains.get(key) === current) this.chains.delete(key)
    })
  }

  private async indexOutputs(
    session: Session,
    membership: { id: WorkspaceId; path: string },
    events: readonly SessionEvent[],
  ): Promise<void> {
    const tools = new Set(this.resolved.outputTools)
    const calls = new Map<string, { name: string; args: string }>()
    const results = new Map<string, boolean>()
    for (const event of events) {
      if (event.type === 'tool/call') {
        const data = event.data as { callId: string; name: string; arguments: string }
        calls.set(data.callId, { name: data.name, args: data.arguments })
      } else if (event.type === 'tool/result') {
        const message = event.data.message
        results.set(message.toolCallId, message.isError === true)
      }
    }
    const cwd = session.header.cwd ?? process.cwd()
    const entries: WorkspaceOutput[] = []
    for (const [callId, call] of calls) {
      if (!tools.has(call.name)) continue
      if (results.get(callId) === true) continue
      if (!results.has(callId)) continue
      const raw = parseProducedPath(call.name, call.args)
      if (raw === undefined) continue
      const resolved = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
      // A missing file resolves to itself: it may still be inside the
      // workspace (created later) and is indexed by its resolved path.
      const canonical = await realpath(resolved).catch(() => resolved)
      if (!isInside(membership.path, canonical)) continue
      entries.push({ path: canonical, tool: call.name, sessionId: String(session.id), at: new Date().toISOString() })
    }
    if (entries.length === 0) return
    try {
      await this.ctx.workspaceMemory.recordOutputs(membership.id, entries)
    } catch (error) {
      this.ctx.logger.warn(`workspace-memory output indexing failed for '${String(membership.id)}': ${String(error)}`)
    }
  }

  private turnEvents(session: Session, turn: number): SessionEvent[] {
    const events: SessionEvent[] = []
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.ownEvents()) {
      if (event.type === 'turn/start' && (event.data).turn === turn) {
        events.length = 0
        continue
      }
      events.push(event)
      if (event.type === 'turn/end' && (event.data as { turn: number }).turn === turn) break
    }
    return events
  }

  private async resolveWorkspace(session: Session): Promise<{ id: WorkspaceId; path: string } | undefined> {
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if ((workspace.sessionIds).includes(session.id)) {
        return { id: workspace.id, path: workspace.path }
      }
    }
    const cwd = session.header.cwd
    if (cwd === undefined) return undefined
    let canonical: string
    try {
      canonical = await realpath(cwd)
    } catch {
      return undefined
    }
    for (const workspace of this.ctx.workspaceRegistry.list()) {
      if (workspace.path === canonical) return { id: workspace.id, path: workspace.path }
    }
    return undefined
  }

  private resolveTurnRoute(session: Session): { provider: string; model: string } | undefined {
    if (this.resolved.provider !== undefined && this.resolved.model !== undefined) {
      return { provider: this.resolved.provider, model: this.resolved.model }
    }
    const header = session.requestHeader()
    if (header === undefined) return undefined
    return { provider: header.config.provider, model: header.config.model }
  }

  private resolveRebuildRoute(sessionIds: readonly SessionId[]): { provider: string; model: string } | undefined {
    if (this.resolved.provider !== undefined && this.resolved.model !== undefined) {
      return { provider: this.resolved.provider, model: this.resolved.model }
    }
    for (const sessionId of sessionIds) {
      const header = this.ctx.sessions.get(sessionId)?.requestHeader()
      if (header === undefined) continue
      return { provider: header.config.provider, model: header.config.model }
    }
    return undefined
  }

  private async callModel(
    route: { provider: string; model: string },
    rows: readonly TranscriptRow[],
    currentMemory: string,
    signal: AbortSignal,
    sessionId: SessionId | string,
  ): Promise<{ text: string; truncated: boolean }> {
    using callDeadline = deadline(signal, this.resolved.timeoutMs, WORKSPACE_MEMORY_TIMEOUT)
    const framed = frameExtractionInput(rows, currentMemory)
    const messages = [createUserMessage({
      content: [{ type: 'text', text: framed }],
      source: { kind: 'workspace-memory-llm' },
    })]
    const options: GenerateOptions = {
      provider: route.provider,
      model: route.model,
      messages,
      system: extractionSystemPrompt(),
      maxTokens: this.resolved.maxOutputTokens,
      temperature: 0,
      purpose: 'workspace-memory',
      sessionId: sessionId as SessionId,
      signal: callDeadline.signal,
    }
    const assembler = new BlockAssembler()
    for await (const chunk of this.ctx.llm.stream(options)) {
      callDeadline.signal.throwIfAborted()
      assembler.push(chunk)
    }
    callDeadline.signal.throwIfAborted()
    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      throw error
    }
    let truncated = false
    if (finish.kind === 'max-tokens') truncated = true
    else if (finish.kind !== 'stop') {
      throw new Error(`workspace-memory extraction rejected finish '${finish.kind}'`)
    }
    const blocks = assembler.blocks()
    if (blocks.some(block => block.type === 'tool-call')) {
      throw new Error('workspace-memory extraction must return text only')
    }
    const text = blocks.filter(block => block.type === 'text').map(block => (block as { text: string }).text).join('')
    // Over-budget output truncates at a UTF-8 boundary before the store call;
    // the store remains authoritative and `storeDocument` truncates once more
    // on a `too-large` rejection.
    return { text, truncated }
  }

  private async storeDocument(
    workspaceId: WorkspaceId,
    text: string,
    extraction: { at: string; sessionId: string; provider: string; model: string; inputBytes: number; truncated: boolean },
  ): Promise<void> {
    let candidate = text
    let truncated = extraction.truncated
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ctx.workspaceMemory.setMemory(workspaceId, candidate, {
          ...extraction,
          truncated,
        })
        return
      } catch (error) {
        const remote = (error as { code?: string; details?: { maxBytes?: number } }).code === 'workspace-memory/too-large'
          ? (error as { details: { maxBytes: number } })
          : undefined
        if (remote === undefined || attempt === 1) throw error
        candidate = truncateUtf8Bytes(candidate, remote.details.maxBytes)
        truncated = true
      }
    }
  }
}

export default WorkspaceMemoryExtractor
