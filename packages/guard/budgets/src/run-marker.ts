/**
 * The kernel's durable run marker, read from the events the guard is delivered.
 *
 * This guard declares no dependency on the kernel's vocabulary: a delivered
 * event is a log view — a type name, a time, and a payload validated field by
 * field — because the log is a durable boundary. An event that is not a run
 * marker, or that carries no usable run identity, yields nothing and leaves the
 * run ceilings unmeasurable.
 * @module @deepseek-ai/dsh-budgets/run-marker
 */

/** One durable run marker: the run a `task/created` event opened, and when it appeared. */
export interface RunMarker {
  /** Stable run identity of the executor lifetime. */
  readonly runId: string
  /** Unix epoch milliseconds of the marker event. */
  readonly at: number
}

/** One event as this module reads it: a log view, not the session's own union. */
export interface BudgetLogEvent {
  /** Event type name. */
  readonly type: string
  /** Unix epoch milliseconds. */
  readonly time: number
  /** Event payload, validated field by field where it is read. */
  readonly data: unknown
}

/**
 * The run marker one event carries.
 * @param event - the delivered event, read as a log view.
 * @returns the run identity and its arrival time, or undefined when the event opens no measurable run.
 */
export function runMarkerOf(event: BudgetLogEvent): RunMarker | undefined {
  if (event.type !== 'task/created') return undefined
  const payload = typeof event.data === 'object' && event.data !== null
    ? event.data as Record<string, unknown>
    : undefined
  const metadata = typeof payload?.metadata === 'object' && payload.metadata !== null
    ? payload.metadata as Record<string, unknown>
    : undefined
  const runId = metadata?.runId
  return typeof runId === 'string' && runId.length > 0 ? { runId, at: event.time } : undefined
}
