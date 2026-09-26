/**
 * Deployment-level scheduled routines: durable definitions that start a new
 * Workspace-backed Session each time one comes due, plus the human `/routine`
 * command that manages them.
 *
 * @module @deepseek-ai/dsh-schedule-routines
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { brandString } from '@deepseek-ai/dsh-brand'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-workspace'
import { startWorkspaceSession } from '@deepseek-ai/dsh-workspace-session'
import type { WorkspaceSessionSpec } from '@deepseek-ai/dsh-workspace-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import { EMPTY_ROUTINES, ROUTINES_KEY, workspaceRoutinesDomainSpec } from './spec.ts'
import type { RoutinesState } from './spec.ts'
import {
  InvalidRoutineError,
  RoutineLimitError,
  UnknownRoutineError,
} from './types.ts'
import type { RoutineId, RoutineRecord, RoutineSpec } from './types.ts'

export const name = 'schedule-routines'
/** Services the scheduler and its command need before init runs. */
export const inject = [
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'commands',
  'permissionPresets',
  'sessionTitle',
  'storageDomain',
  'workspaceRegistry',
]

/** Deployment choices for the routine scheduler. */
export interface Config {
  /** Seconds between due-routine checks; the tick only reads the durable cursors. */
  tickSeconds?: number
  /** Agent composition every routine Session mounts unless its record says otherwise. */
  agentPreset?: string
  /** Sandbox and approval preset every routine Session runs under. */
  permissionPreset?: string
  /** Ceiling on stored routines, so an unattended feature cannot grow without bound. */
  maxRoutines?: number
}

export const Config: z<Config> = z.object({
  tickSeconds: z.number().step(1).min(1).default(30),
  agentPreset: z.string().default('standard'),
  permissionPreset: z.string().default('workspace-write'),
  maxRoutines: z.number().step(1).min(1).default(25),
})

/** Argument grammar for `/routine`; anything else reports usage. */
const ROUTINE_USAGE = 'Usage: /routine | /routine add <minutes> <prompt> | /routine pause <id> | /routine resume <id> | /routine remove <id>'

/** The `/routine` command definition identity. */
const ROUTINE_DEFINITION = CommandDefinitionId('@deepseek-ai/dsh-schedule-routines/routine')

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Owner of the durable routine list and its timer. */
    routines: RoutineScheduler
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Programmatic input admitted by a scheduled routine. */
    routine: {
      readonly kind: 'routine'
      readonly routineId: string
      readonly form: 'notice'
      readonly summary: string
    }
  }
}

/** Split one command's raw input on whitespace. */
function splitArgs(raw: string): string[] {
  return raw.trim().split(/\s+/u).filter(part => part.length > 0)
}

/** One stored record as the typed routine record with its branded identity. */
function toRecord(stored: RoutinesState['routines'][number]): RoutineRecord {
  return { ...stored, id: brandString<RoutineId>(stored.id) }
}

/** One typed routine record as the stored shape, branding erased. */
function toStored(record: RoutineRecord): RoutinesState['routines'][number] {
  return { ...record, id: String(record.id) }
}

/** Render one stored routine as a single list line. */
function formatRoutine(record: RoutineRecord): string {
  const state = record.enabled ? `next ${record.nextDueAt}` : 'paused'
  return `- ${record.id} every ${String(record.everyMinutes)}m: ${record.title} (${state})`
}

/** Title derived from a routine prompt, bounded to one readable line. */
function titleFromPrompt(prompt: string): string {
  const single = prompt.replace(/\s+/gu, ' ').trim()
  return single.length > 60 ? `${single.slice(0, 57)}...` : single
}

/** Next due instant strictly after `now`, skipping every missed occurrence. */
function advanceDue(record: Pick<RoutineRecord, 'everyMinutes' | 'nextDueAt'>, now: Date): string {
  const stepMs = record.everyMinutes * 60_000
  let due = Date.parse(record.nextDueAt)
  if (!Number.isFinite(due)) due = now.getTime()
  while (due <= now.getTime()) due += stepMs
  return new Date(due).toISOString()
}

/**
 * Durable routine store and the timer that starts a new Session when one comes
 * due. Routines run only while this process is up: a due instant that passes
 * during downtime is skipped, not caught up, so a restarted Desktop app never
 * starts a backlog of Sessions at boot.
 */
export class RoutineScheduler extends Service {
  static Config: z<Config> = Config

  static inject = [
    'agents',
    'agentDefaultModel',
    'agentPresets',
    'commands',
    'permissionPresets',
    'sessionTitle',
    'storageDomain',
    'workspaceRegistry',
  ]

  private readonly config: Required<Config>
  private table?: KvTable<string, RoutinesState>
  private state: RoutinesState = EMPTY_ROUTINES
  /** Routine ids currently starting a Session, so one tick cannot start two. */
  private readonly firing = new Set<string>()
  private cancel = new AbortController()

  /**
   * @param ctx - context the scheduler registers its service on.
   * @param config - tick cadence, default composition, and the routine ceiling.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'routines')
    this.config = {
      tickSeconds: config.tickSeconds ?? 30,
      agentPreset: config.agentPreset ?? 'standard',
      permissionPreset: config.permissionPreset ?? 'workspace-write',
      maxRoutines: config.maxRoutines ?? 25,
    }
  }

  /**
   * Every stored routine, newest last.
   * @returns the durable records in creation order.
   */
  list(): readonly RoutineRecord[] {
    return this.state.routines.map(toRecord)
  }

  /**
   * Store one new routine due `everyMinutes` from now.
   * @param spec - title, workspace, prompt, and cadence.
   * @returns the stored record.
   * @throws InvalidRoutineError on an unsupported argument, RoutineLimitError at the ceiling.
   */
  async create(spec: RoutineSpec): Promise<RoutineRecord> {
    const now = new Date()
    if (!isAbsolute(spec.workspacePath)) {
      throw new InvalidRoutineError(`routine workspacePath must be absolute, got ${JSON.stringify(spec.workspacePath)}`)
    }
    if (spec.prompt.trim().length === 0) throw new InvalidRoutineError('routine prompt must not be blank')
    if (!Number.isSafeInteger(spec.everyMinutes) || spec.everyMinutes <= 0) {
      throw new InvalidRoutineError('routine cadence must be a positive whole number of minutes')
    }
    if (this.state.routines.length >= this.config.maxRoutines) throw new RoutineLimitError(this.config.maxRoutines)
    const record: RoutineRecord = {
      id: brandString<RoutineId>(`routine-${randomUUID()}`),
      title: spec.title.trim().length === 0 ? titleFromPrompt(spec.prompt) : spec.title.trim(),
      workspacePath: spec.workspacePath,
      prompt: spec.prompt,
      agentPreset: this.config.agentPreset,
      permissionPreset: this.config.permissionPreset,
      everyMinutes: spec.everyMinutes,
      enabled: true,
      createdAt: now.toISOString(),
      lastFiredAt: null,
      nextDueAt: new Date(now.getTime() + spec.everyMinutes * 60_000).toISOString(),
    }
    await this.persist({ routines: [...this.state.routines, toStored(record)] })
    return record
  }

  /**
   * Remove one stored routine.
   * @param id - routine identity.
   * @returns nothing.
   * @throws UnknownRoutineError when no such routine is stored.
   */
  async remove(id: RoutineId): Promise<void> {
    this.require(id)
    await this.persist({ routines: this.state.routines.filter(record => record.id !== String(id)) })
  }

  /**
   * Pause or resume one stored routine.
   * @param id - routine identity.
   * @param enabled - whether it may start new sessions.
   * @returns the stored record.
   * @throws UnknownRoutineError when no such routine is stored.
   */
  async setEnabled(id: RoutineId, enabled: boolean): Promise<RoutineRecord> {
    const current = this.require(id)
    const next: RoutineRecord = { ...current, enabled }
    await this.persist({
      routines: this.state.routines.map(record => record.id === String(id) ? toStored(next) : record),
    })
    return next
  }

  /**
   * Start a Session for every routine due at or before the current instant.
   * @returns the ids that started a Session this pass.
   */
  async runDue(): Promise<readonly RoutineId[]> {
    const now = new Date()
    const started: RoutineId[] = []
    for (const record of this.list()) {
      if (!record.enabled || this.firing.has(record.id)) continue
      if (Date.parse(record.nextDueAt) > now.getTime()) continue
      this.firing.add(record.id)
      try {
        await this.startSession(record)
        started.push(record.id)
        await this.advance(record, now, now.toISOString())
      } catch (error: unknown) {
        this.ctx.logger.warn('schedule-routines: routine %s failed to start: %o', record.id, error)
        // The cadence advances past the failed occurrence: a routine is a
        // schedule, not a retry queue, so one bad start cannot spin the tick.
        await this.advance(record, now, record.lastFiredAt)
      } finally {
        this.firing.delete(record.id)
      }
    }
    return started
  }

  private require(id: RoutineId): RoutineRecord {
    const record = this.state.routines.find(candidate => candidate.id === String(id))
    if (record === undefined) throw new UnknownRoutineError(id)
    return toRecord(record)
  }

  private async advance(record: RoutineRecord, now: Date, lastFiredAt: string | null): Promise<void> {
    const next: RoutineRecord = { ...record, lastFiredAt, nextDueAt: advanceDue(record, now) }
    await this.persist({
      routines: this.state.routines.map(candidate => candidate.id === String(record.id) ? toStored(next) : candidate),
    })
  }

  private async persist(state: RoutinesState): Promise<void> {
    await this.table?.put(ROUTINES_KEY, state)
    this.state = state
  }

  /** Start the Workspace-backed Session one routine describes. */
  private async startSession(record: RoutineRecord): Promise<void> {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const spec: WorkspaceSessionSpec = {
      workspacePath: record.workspacePath,
      sessionId: brandString<SessionId>(`routine-${randomUUID()}`),
      title: record.title,
      agentPreset: record.agentPreset,
      permissionPreset: record.permissionPreset,
      modelSelection: { ...selection },
      agentOptions: { provider: selection.provider, model: selection.model },
      owner: 'schedule-routines',
    }
    const message: UserMessage = createUserMessage({
      content: [{ type: 'text', text: record.prompt }],
      source: {
        kind: 'routine',
        routineId: String(record.id),
        form: 'notice',
        summary: boundContextSummary(`Scheduled routine "${record.title}" started this session`),
      },
    })
    await startWorkspaceSession(this.ctx, spec, message, this.cancel.signal)
  }

  /** Execute one `/routine` invocation. */
  private async execute(invocation: CommandInvocation): Promise<CommandResult> {
    const [verb, ...rest] = splitArgs(invocation.rawInput)
    if (verb === undefined || (verb === 'list' && rest.length === 0)) {
      const routines = this.list()
      return {
        kind: 'success',
        text: routines.length === 0 ? 'No routines.' : `${String(routines.length)} routine(s):\n${routines.map(formatRoutine).join('\n')}`,
      }
    }
    if (verb === 'add') {
      const [minutes, ...promptParts] = rest
      const prompt = promptParts.join(' ')
      const cadence = Number(minutes)
      if (minutes === undefined || prompt.length === 0 || !Number.isSafeInteger(cadence)) {
        return { kind: 'error', text: ROUTINE_USAGE }
      }
      const workspacePath = invocation.agent.session.header.cwd
      if (workspacePath === undefined) {
        return { kind: 'error', text: 'This session has no working directory to schedule a routine in.' }
      }
      try {
        const record = await this.create({ title: '', workspacePath, prompt, everyMinutes: cadence })
        return {
          kind: 'success',
          text: `Routine '${record.id}' runs every ${String(record.everyMinutes)}m in ${record.workspacePath}; next ${record.nextDueAt}.`,
        }
      } catch (error: unknown) {
        if (error instanceof InvalidRoutineError || error instanceof RoutineLimitError) {
          return { kind: 'error', text: `${error.message}.` }
        }
        throw error
      }
    }
    if ((verb === 'pause' || verb === 'resume' || verb === 'remove') && rest.length === 1) {
      const id = brandString<RoutineId>(rest[0] as string)
      try {
        if (verb === 'remove') await this.remove(id)
        else await this.setEnabled(id, verb === 'resume')
      } catch (error: unknown) {
        if (error instanceof UnknownRoutineError) return { kind: 'error', text: `No routine '${id}'.` }
        throw error
      }
      return {
        kind: 'success',
        text: verb === 'remove'
          ? `Removed routine '${id}'.`
          : `Routine '${id}' is now ${verb === 'resume' ? 'active' : 'paused'}.`,
      }
    }
    return { kind: 'error', text: ROUTINE_USAGE }
  }

  protected async [Service.init](): Promise<void> {
    // Misconfiguration fails loud at load: an unknown preset here would
    // otherwise surface as a routine that never starts a usable Session.
    this.ctx.permissionPresets.resolve(this.config.permissionPreset)
    await this.ctx.agentPresets.resolve(this.config.agentPreset)

    const domain = await this.ctx.storageDomain.open(workspaceRoutinesDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'schedule-routines: domain close')
    this.table = domain.table('routines')
    this.state = this.table.get(ROUTINES_KEY) ?? EMPTY_ROUTINES
    // Downtime is skipped, not replayed: every cursor that passed while this
    // process was down moves to its next future instant before the first tick.
    const now = new Date()
    const advanced = this.state.routines.map(record => (
      record.enabled && Date.parse(record.nextDueAt) <= now.getTime()
        ? { ...record, nextDueAt: advanceDue(record, now) }
        : record
    ))
    if (advanced.some((record, index) => record.nextDueAt !== this.state.routines[index]?.nextDueAt)) {
      await this.persist({ routines: advanced })
    }

    this.ctx.effect(() => {
      const timer = setInterval(() => {
        void this.runDue().catch((error: unknown) => {
          this.ctx.logger.warn('schedule-routines: tick failed: %o', error)
        })
      }, this.config.tickSeconds * 1000)
      timer.unref()
      return () => {
        clearInterval(timer)
        this.cancel.abort(new Error('schedule-routines disposed'))
        this.cancel = new AbortController()
      }
    }, 'schedule-routines: tick')

    this.ctx.commands.register({
      definitionId: ROUTINE_DEFINITION,
      name: 'routine',
      description: 'List, add, pause, resume, or remove scheduled routines that start new sessions',
      input: { hint: 'add <minutes> <prompt> | pause <id> | resume <id> | remove <id>' },
      handler: (invocation: CommandInvocation) => this.execute(invocation),
    })
  }
}

export default RoutineScheduler
export { EMPTY_ROUTINES, ROUTINES_KEY, workspaceRoutinesDomainSpec } from './spec.ts'
export { InvalidRoutineError, RoutineLimitError, UnknownRoutineError } from './types.ts'
export type { RoutineId, RoutineRecord, RoutineSpec } from './types.ts'
