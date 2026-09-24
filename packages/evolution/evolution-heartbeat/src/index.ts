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

/** One active attempt owned by its exact task registration. */
interface ActiveAttempt {
  controller: AbortController
  operation: Promise<HeartbeatTaskReport>
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
  /** Attempts still owned by each task registration. */
  private readonly active = new Map<ResolvedTask, Set<ActiveAttempt>>()
  /** Scheduling passes and direct task runs still owned by this service. */
  private readonly inFlight = new Set<Promise<unknown>>()
  /** Set before teardown aborts work, so no new work starts. */
  private stopping = false

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
   * schedule. No task can be registered before this method's `ctx.provide`
   * takes effect, so the start-time due-check always finds an empty task
   * table; it runs fire-and-forget, matching the interval tick, so plugin
   * startup never waits on a background pass. The repeating tick is
   * `unref()`ed and disposed through `ctx.effect`.
   */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(heartbeatDomainSpec)
    this.table = domain.table('tasks')
    this.ctx.on('session/event', () => {
      this.lastActivityAt = Date.now()
    })
    const timer: { handle?: ReturnType<typeof setInterval> } = {}
    this.ctx.effect(() => async () => {
      clearInterval(timer.handle)
      await this.drain()
      await domain.close()
    }, 'evolution-heartbeat.lifecycle')
    if (!this.resolved.enabled) return
    const runScheduledPass = (): void => {
      void this.runDue().catch((error: unknown) => {
        this.ctx.logger.warn(`evolution heartbeat scheduled pass failed: ${String(error)}`)
      })
    }
    runScheduledPass()
    const handle = setInterval(runScheduledPass, this.resolved.tickMinutes * 60_000)
    timer.handle = handle
    handle.unref()
  }

  /**
   * Register one task. The task runs only while its registration is live. A
   * consumer disposes it by calling the returned disposer.
   * @param task - identity, cadence, and the work to run.
   * @returns an idempotent asynchronous disposer that removes the task,
   *   aborts an active attempt, and waits for it to settle.
   * @throws when teardown has begun or the task descriptor is unusable.
   */
  register(task: HeartbeatTask): () => Promise<void> {
    if (this.stopping) throw new Error('evolution-heartbeat: service is disposing')
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
    const resolved: ResolvedTask = { intervalHours: task.intervalHours, minIdleHours, run: task.run }
    this.tasks.set(task.name, resolved)
    let disposal: Promise<void> | undefined
    return () => {
      if (disposal !== undefined) return disposal
      if (this.tasks.get(task.name) === resolved) this.tasks.delete(task.name)
      const attempts = this.active.get(resolved)
      const running = attempts === undefined ? [] : [...attempts]
      for (const attempt of running) {
        attempt.controller.abort(new Error(`evolution-heartbeat: task '${task.name}' was unregistered`))
      }
      disposal = Promise.allSettled(running.map(attempt => attempt.operation)).then(() => {})
      return disposal
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
   * @returns entries for tasks reached before teardown stops the pass.
   */
  runDue(options: HeartbeatRunOptions = {}): Promise<HeartbeatReport> {
    if (this.stopping) return Promise.reject(new Error('evolution-heartbeat: service is disposing'))
    return this.track(this.runDuePass(options))
  }

  private async runDuePass(options: HeartbeatRunOptions): Promise<HeartbeatReport> {
    const now = options.now ?? Date.now()
    const at = new Date(now).toISOString()
    const idleMs = this.idleMsAt(now, options.idleMs)
    const tasks: HeartbeatTaskReport[] = []
    for (const [name, task] of [...this.tasks]) {
      if (this.stopping) break
      if (this.tasks.get(name) !== task) continue
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
  runTask(name: string, options: HeartbeatRunOptions = {}): Promise<HeartbeatTaskReport | undefined> {
    if (this.stopping) return Promise.reject(new Error('evolution-heartbeat: service is disposing'))
    const task = this.tasks.get(name)
    if (task === undefined) return Promise.resolve(undefined)
    return this.track(this.attempt(name, task, options.now ?? Date.now()))
  }

  /**
   * Run one task and record its outcome. The attempt stamps the bookkeeping
   * whether it succeeded or failed, so a permanently failing task is retried
   * on its interval instead of every tick.
   */
  private attempt(name: string, task: ResolvedTask, now: number): Promise<HeartbeatTaskReport> {
    const controller = new AbortController()
    const operation = Promise.resolve().then(() => this.runAttempt(name, task, now, controller))
    let attempts = this.active.get(task)
    if (attempts === undefined) {
      attempts = new Set()
      this.active.set(task, attempts)
    }
    const activeAttempt: ActiveAttempt = { controller, operation }
    attempts.add(activeAttempt)
    const retire = (): void => {
      attempts.delete(activeAttempt)
      if (attempts.size === 0) this.active.delete(task)
    }
    void operation.then(retire, retire)
    return operation
  }

  private async runAttempt(
    name: string,
    task: ResolvedTask,
    now: number,
    controller: AbortController,
  ): Promise<HeartbeatTaskReport> {
    try {
      await task.run(controller.signal)
      if (controller.signal.aborted) {
        return { name, outcome: 'deferred', reason: 'task attempt cancelled during teardown' }
      }
      await this.stamp(name, now, null)
      return { name, outcome: 'ran' }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return { name, outcome: 'deferred', reason: 'task attempt cancelled during teardown' }
      }
      const message = error instanceof Error ? error.message : String(error)
      await this.stamp(name, now, message)
      this.ctx.logger.warn(`evolution heartbeat task '${name}' failed: ${message}`)
      return { name, outcome: 'failed', error: message }
    }
  }

  /** Track work so teardown waits for the promise returned to its caller. */
  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation)
    void operation.then(
      () => { this.inFlight.delete(operation) },
      () => { this.inFlight.delete(operation) },
    )
    return operation
  }

  /** Abort active attempts and wait until every pass has settled. */
  private async drain(): Promise<void> {
    this.stopping = true
    for (const attempts of this.active.values()) {
      for (const attempt of attempts) {
        attempt.controller.abort(new Error('evolution-heartbeat: service disposed'))
      }
    }
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight])
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
