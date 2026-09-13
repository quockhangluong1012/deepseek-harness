/**
 * Public vocabulary of the evolution heartbeat registry: the task a consumer
 * registers, the durable bookkeeping each task carries, and the pass report.
 * @module @deepseek-ai/dsh-evolution-heartbeat/src/types
 */

/**
 * One unit of autonomous maintenance registered with the heartbeat. The task
 * owns its cadence; the engine owns only the host-wide timer and the durable
 * bookkeeping.
 */
export interface HeartbeatTask {
  /** Stable task identity, also the durable bookkeeping key; unique per host. */
  name: string
  /** Minimum hours between two attempts of this task. */
  intervalHours: number
  /** Minimum observed host idle hours before this task may run; defaults to the engine's `minIdleHours`. */
  minIdleHours?: number
  /**
   * The work this task performs. A rejection is recorded against the task and
   * never stops the other tasks in the pass.
   * @param signal - aborts at plugin teardown, so a long task observes disposal.
   */
  run: (signal: AbortSignal) => Promise<void> | void
}

/**
 * Durable bookkeeping for one registered task. An absent row means the task
 * has never been attempted; the engine seeds it and defers one interval.
 */
export interface HeartbeatBookkeeping {
  /** Epoch milliseconds of the last attempt. */
  lastRunAtMs: number
  /** Message from the last failed attempt, or null when the last attempt succeeded. */
  lastError: string | null
}

/** Inspection view of one registered task's schedule and last outcome. */
export interface HeartbeatTaskState {
  /** Task identity. */
  name: string
  /** Minimum hours between two attempts. */
  intervalHours: number
  /** Effective minimum idle hours before a run. */
  minIdleHours: number
  /** ISO-8601 instant of the last attempt, or null before the first attempt. */
  lastRunAt: string | null
  /** Message from the last failed attempt, or null when the last attempt succeeded. */
  lastError: string | null
  /** Whether the interval elapsed and the idle gate was satisfied at the sampled instant. */
  due: boolean
}

/** Clock and idleness overrides for one scheduling decision. */
export interface HeartbeatRunOptions {
  /** Instant to evaluate against, defaulting to the wall clock. */
  now?: number
  /** Observed idle milliseconds, overriding the host-wide observation. */
  idleMs?: number
  /** Run regardless of the interval and the idle gate. */
  force?: boolean
}

/** Outcome of one task considered by a pass. */
export interface HeartbeatTaskReport {
  /** Task identity. */
  name: string
  /** What the pass did with this task. */
  outcome: 'ran' | 'deferred' | 'seeded' | 'failed'
  /** Why the task was deferred, absent otherwise. */
  reason?: string
  /** Failure message when `outcome` is `failed`. */
  error?: string
}

/** Outcome of one scheduling pass. */
export interface HeartbeatReport {
  /** ISO-8601 instant the pass evaluated. */
  at: string
  /** One entry per task still registered, in registration order. */
  tasks: HeartbeatTaskReport[]
}
