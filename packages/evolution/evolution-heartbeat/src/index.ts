/**
 * Host-wide idle-triggered task scheduling (`ctx.evolutionHeartbeat`): the
 * generic autonomous-maintenance engine behind the Evolutionary Harness.
 *
 * The plugin is mounted once per host and owns a single timer: it observes
 * host-wide session activity, runs one awaited start-time due-check, and then
 * ticks every `tickMinutes`. A registered task runs only once its interval
 * elapsed since its last attempt and the host stayed idle long enough. The
 * first due-check of a task seeds its bookkeeping and defers one interval, so
 * mounting the engine never fires every task at once. A failing task is
 * recorded and never stops the other tasks in the same pass. Stored objects
 * never leak by reference.
 * @module @deepseek-ai/dsh-evolution-heartbeat
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session'
import { heartbeatDomainSpec } from './spec.ts'
import type {
  HeartbeatBookkeeping,
  HeartbeatReport,
  HeartbeatRunOptions,
  HeartbeatTask,
  HeartbeatTaskReport,
  HeartbeatTaskState,
} from './types.ts'

export type * from './types.ts'
export { heartbeatBookkeeping, heartbeatDomainSpec } from './spec.ts'

/** Task names become domain record keys, so they must be path-safe on every OS. */
const TASK_NAME_RE = /^[a-zA-Z0-9_.-]+$/

/** Milliseconds in one hour. */
const HOUR_MS = 3_600_000

/** Host idleness reported before this process observed any session activity. */
const UNOBSERVED_IDLE_MS = Number.POSITIVE_INFINITY

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host-wide idle-triggered task registry. */
    evolutionHeartbeat: EvolutionHeartbeat
  }
}

/** Deployment choices for the heartbeat engine. */
export interface Config {
  /** Master switch; removal-equivalent off state starts no timer and runs no task. */
  enabled?: boolean
  /** Minutes between host-wide due-checks. */
  tickMinutes?: number
  /** Default minimum observed idle hours before a task may run. */
  minIdleHours?: number
}

/** Validated deployment choices. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  tickMinutes: z.number().step(1).min(1).default(15),
  minIdleHours: z.number().step(1).min(0).default(2),
})

/** Normalized configuration used by the engine. */
export interface ResolvedConfig {
  enabled: boolean
  tickMinutes: number
  minIdleHours: number
}

/**
 * Resolve defaults for the optional engine fields.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const { enabled = true, tickMinutes = 15, minIdleHours = 2 } = config
  return { enabled, tickMinutes, minIdleHours }
}

/**
 * One registered task with its engine-resolved idle threshold. A registration
 * carries only what the engine schedules; the work itself stays the consumer's.
 */
interface ResolvedTask {
  /** Minimum hours between two attempts. */
  intervalHours: number
  /** Effective minimum idle hours before a run. */
  minIdleHours: number
  /** The registered work. */
  run: (signal: AbortSignal) => Promise<void> | void
}

/**
 * Host-wide idle-triggered task registry. Opens the `evolution_heartbeat`
 * domain at init and closes it through `ctx.effect`.
 */
export class EvolutionHeartbeat extends Service {
  static inject = ['storageDomain']

  private table?: KvTable<string, HeartbeatBookkeeping>
  private readonly resolved: ResolvedConfig
  private readonly tasks = new Map<string, ResolvedTask>()
  /** Newest host-wide session activity this process observed, or null before any. */
  private lastActivityAt: number | null = null
  /** Cancellation for the task attempt in flight, aborted at teardown. */
  private active: AbortController | undefined

  /**
   * @param ctx - Host context carrying the storage domain.
   * @param config - engine cadence and the default idle threshold.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'evolutionHeartbeat')
    this.resolved = resolveConfig(config)
  }

  /**
   * Open the domain, observe host-wide activity, and own the maintenance
   * schedule. The start-time due-check runs first and awaits, so a short-lived
   * CLI process cannot exit before a due task ran; the repeating tick is
   * `unref()`ed and disposed through `ctx.effect`.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(heartbeatDomainSpec)
    this.ctx.effect(() => () => domain.close(), 'evolution-heartbeat.domainClose')
    this.table = domain.table('tasks')
    this.ctx.on('session/event', () => {
      this.lastActivityAt = Date.now()
    })
    if (!this.resolved.enabled) return
    this.ctx.effect(() => () => this.active?.abort(), 'evolution-heartbeat.abort')
    await this.runDue()
    this.ctx.effect(() => {
      const timer = setInterval(() => {
        void this.runDue().catch((error: unknown) => {
          this.ctx.logger.warn(`evolution heartbeat scheduled pass failed: ${String(error)}`)
        })
      }, this.resolved.tickMinutes * 60_000)
      timer.unref()
      return () => {
        clearInterval(timer)
      }
    }, 'evolution-heartbeat.tick')
  }

  /**
   * Register one task. The task runs only while its registration is live, so a
   * consumer disposes it by calling the returned disposer. A task registered
   * after start-up is seeded by the next due-check and defers one interval.
   * @param task - identity, cadence, and the work to run.
   * @returns the disposer removing the task; idempotent.
   */
  register(task: HeartbeatTask): () => void {
    if (!TASK_NAME_RE.test(task.name)) {
      throw new Error(`evolution-heartbeat: task name '${task.name}' must match ${TASK_NAME_RE}`)
    }
    if (this.tasks.has(task.name)) {
      throw new Error(`evolution-heartbeat: task '${task.name}' is already registered`)
    }
    if (!Number.isFinite(task.intervalHours) || task.intervalHours < 1) {
      throw new Error(`evolution-heartbeat: task '${task.name}' intervalHours must be at least 1`)
    }
    const minIdleHours = task.minIdleHours ?? this.resolved.minIdleHours
    if (!Number.isFinite(minIdleHours) || minIdleHours < 0) {
      throw new Error(`evolution-heartbeat: task '${task.name}' minIdleHours must not be negative`)
    }
    this.tasks.set(task.name, { intervalHours: task.intervalHours, minIdleHours, run: task.run })
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.tasks.delete(task.name)
    }
  }

  /**
   * Inspect the registered tasks' schedule and last outcome.
   * @param name - one task's identity, or every task when omitted.
   * @returns one state per matching task, in registration order.
   */
  state(name?: string): HeartbeatTaskState[] {
    const table = this.requireTable()
    const now = Date.now()
    const idleMs = this.idleMsAt(now, undefined)
    const names = name === undefined
      ? [...this.tasks.keys()]
      : this.tasks.has(name) ? [name] : []
    return names.map((taskName) => {
      const task = this.tasks.get(taskName) as ResolvedTask
      const row = table.get(taskName)
      const lastRunAtMs = row === undefined ? null : row.lastRunAtMs
      const lastError = row === undefined ? null : row.lastError
      const intervalElapsed = lastRunAtMs === null || now - lastRunAtMs >= task.intervalHours * HOUR_MS
      return {
        name: taskName,
        intervalHours: task.intervalHours,
        minIdleHours: task.minIdleHours,
        lastRunAt: lastRunAtMs === null ? null : new Date(lastRunAtMs).toISOString(),
        lastError,
        due: intervalElapsed && idleMs >= task.minIdleHours * HOUR_MS,
      }
    })
  }

  /**
   * Read one task's last attempt instant.
   * @param name - task identity.
   * @returns the ISO-8601 instant, or null when unknown or never attempted.
   */
  lastRunAt(name: string): string | null {
    const row = this.requireTable().get(name)
    return row === undefined ? null : new Date(row.lastRunAtMs).toISOString()
  }

  /**
   * Consider every registered task once, in registration order. A task whose
   * bookkeeping is absent is seeded and deferred; a task whose interval has
   * not elapsed, or whose idle gate is unsatisfied, is deferred. Tasks run
   * sequentially, and a failing task is recorded without stopping the pass.
   * @param options - clock, idleness, and force overrides.
   * @returns one entry per registered task.
   */
  async runDue(options: HeartbeatRunOptions = {}): Promise<HeartbeatReport> {
    const now = options.now ?? Date.now()
    const at = new Date(now).toISOString()
    const idleMs = this.idleMsAt(now, options.idleMs)
    const tasks: HeartbeatTaskReport[] = []
    for (const [name, task] of [...this.tasks]) {
      if (!options.force) {
        const row = this.requireTable().get(name)
        if (row === undefined) {
          await this.stamp(name, now, null)
          tasks.push({ name, outcome: 'seeded' })
          continue
        }
        if (now - row.lastRunAtMs < task.intervalHours * HOUR_MS) {
          tasks.push({ name, outcome: 'deferred', reason: `interval ${task.intervalHours}h has not elapsed` })
          continue
        }
        if (idleMs < task.minIdleHours * HOUR_MS) {
          tasks.push({ name, outcome: 'deferred', reason: `idle ${task.minIdleHours}h has not been observed` })
          continue
        }
      }
      tasks.push(await this.attempt(name, task, now))
    }
    return { at, tasks }
  }

  /**
   * Run one registered task now, ignoring its interval and the idle gate.
   * @param name - task identity.
   * @param options - clock override.
   * @returns the task's report, or undefined when no such task is registered.
   */
  async runTask(name: string, options: HeartbeatRunOptions = {}): Promise<HeartbeatTaskReport | undefined> {
    const task = this.tasks.get(name)
    if (task === undefined) return undefined
    return this.attempt(name, task, options.now ?? Date.now())
  }

  /**
   * Run one task and record its outcome. The attempt stamps the bookkeeping
   * whether it succeeded or failed, so a permanently failing task is retried
   * on its interval instead of every tick.
   */
  private async attempt(name: string, task: ResolvedTask, now: number): Promise<HeartbeatTaskReport> {
    const controller = new AbortController()
    this.active = controller
    try {
      await task.run(controller.signal)
      await this.stamp(name, now, null)
      return { name, outcome: 'ran' }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      await this.stamp(name, now, message)
      this.ctx.logger.warn(`evolution heartbeat task '${name}' failed: ${message}`)
      return { name, outcome: 'failed', error: message }
    } finally {
      this.active = undefined
    }
  }

  /** Write one task's bookkeeping row, seeding it on the first attempt. */
  private async stamp(name: string, now: number, error: string | null): Promise<void> {
    const table = this.requireTable()
    const row: HeartbeatBookkeeping = { lastRunAtMs: now, lastError: error }
    if (table.get(name) === undefined) {
      await table.put(name, row)
      return
    }
    await table.update(name, () => row)
  }

  /**
   * Host idleness at one instant. Caller-supplied milliseconds win; otherwise
   * the newest observed session activity measures it, and a host that observed
   * no activity at all counts as idle.
   */
  private idleMsAt(now: number, override: number | undefined): number {
    if (override !== undefined) return override
    return this.lastActivityAt === null ? UNOBSERVED_IDLE_MS : now - this.lastActivityAt
  }

  private requireTable(): KvTable<string, HeartbeatBookkeeping> {
    if (this.table === undefined) throw new Error('evolution heartbeat is not started yet')
    return this.table
  }
}

export default EvolutionHeartbeat
