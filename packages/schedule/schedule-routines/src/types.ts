/**
 * Durable and human-facing `Routine` value types.
 * @module @deepseek-ai/dsh-schedule-routines/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable routine identity, unique within one deployment's routine list. */
export type RoutineId = Branded<'RoutineId'>

/**
 * Durable definition of one routine: what to start, where, and how often.
 * `nextDueAt` is the single scheduling cursor; `lastFiredAt` records the last
 * successful start for the human reading the list.
 */
export interface RoutineRecord {
  readonly id: RoutineId
  readonly title: string
  /** Absolute directory the routine's Session opens as a Workspace. */
  readonly workspacePath: string
  /** Text admitted as the new Session's first user message. */
  readonly prompt: string
  /** Agent composition the routine's Session mounts. */
  readonly agentPreset: string
  /** Sandbox and approval preset the routine's Session runs under. */
  readonly permissionPreset: string
  /** Fixed-rate cadence between starts, in minutes. */
  readonly everyMinutes: number
  /** Whether the routine may start new sessions; a paused routine keeps its cursor. */
  readonly enabled: boolean
  /** ISO-8601 instant the routine was created. */
  readonly createdAt: string
  /** ISO-8601 instant of the last successful start, or null when it never ran. */
  readonly lastFiredAt: string | null
  /** ISO-8601 instant the next start is due. */
  readonly nextDueAt: string
}

/** Human-facing input for one new routine; the service derives the rest. */
export interface RoutineSpec {
  readonly title: string
  readonly workspacePath: string
  readonly prompt: string
  readonly everyMinutes: number
}

/** Stable failure for a routine argument that cannot be accepted. */
export class InvalidRoutineError extends Error {
  /** Stable machine-readable discriminant for an unsupported routine argument. */
  readonly code = 'schedule_routines/invalid'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidRoutineError'
  }
}

/** Stable failure naming a routine id that is not stored. */
export class UnknownRoutineError extends Error {
  /** Stable machine-readable discriminant for a missing routine. */
  readonly code = 'schedule_routines/unknown'
  /** The routine id that is not stored. */
  readonly routineId: RoutineId

  constructor(routineId: RoutineId) {
    super(`no routine '${routineId}'`)
    this.name = 'UnknownRoutineError'
    this.routineId = routineId
  }
}

/** Stable failure raised when the configured routine ceiling is reached. */
export class RoutineLimitError extends Error {
  /** Stable machine-readable discriminant for a full routine list. */
  readonly code = 'schedule_routines/limit'
  /** The configured ceiling that was reached. */
  readonly limit: number

  constructor(limit: number) {
    super(`the routine list is limited to ${limit} entries`)
    this.name = 'RoutineLimitError'
    this.limit = limit
  }
}
