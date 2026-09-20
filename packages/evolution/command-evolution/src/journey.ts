/**
 * Read model and rendering behind `/journey`: one scope's recorded evolution
 * activity, bucketed on the dashboard calendar (UTC+7), beside its capacity,
 * digest, and pending approvals. The model is pure — the command supplies the
 * record it already read, so this module touches neither storage nor the
 * session log, and the Remote controller reuses it unchanged.
 *
 * A delta is emitted only for a fact the record proves: the per-family write
 * stamps separate `instructions`, `lessons`, and `profile` edits, and a record
 * whose lessons/profile stamps are absent still reads as one lessons delta from
 * its extraction or `memoryUpdatedAt`. Decided staged entries are counted from
 * the resolution ledger on the day each decision landed.
 *
 * @module @deepseek-ai/dsh-command-evolution/journey
 */

import { dayKeyUTC7, daysOfRange, windowStartOfRange } from '@deepseek-ai/dsh-usage-ledger'
import type { UsageRange } from '@deepseek-ai/dsh-usage-ledger'
import { artifactBytesOf, utf8Bytes } from '@deepseek-ai/dsh-evolution-memory'
import type { EvolutionMemoryRecord, StagedWrite } from '@deepseek-ai/dsh-evolution-memory'

export type {
  JourneyTimeline,
  TimelineCumulative,
  TimelineDayBucket,
  TimelineDelta,
  TimelineDeltaKind,
  TimelinePending,
} from './types.ts'

import type {
  JourneyTimeline,
  TimelineDayBucket,
  TimelineDelta,
  TimelineDeltaKind,
  TimelinePending,
} from './types.ts'

/**
 * Everything the timeline reads, so the caller owns storage access.
 */
export interface TimelineInput {
  /** The scope record, or undefined when the scope has none yet. */
  record: EvolutionMemoryRecord | undefined
  /** Charged bytes for the scope. */
  usedBytes: number
  /** Configured capacity ceiling. */
  capacityBytes: number
  /** Digest of the brief's current inputs. */
  digest: string
  /** Requested window. */
  range: UsageRange
  /** Unix epoch milliseconds anchoring the window. */
  now: number
}

/**
 * Place one ISO instant on its calendar day. The record's instants are
 * ISO-8601, which sorts chronologically as text.
 * @param at - ISO-8601 instant from the record.
 * @returns the `YYYY-MM-DD` key in UTC+7.
 */
function dayOf(at: string): string {
  return dayKeyUTC7(Date.parse(at))
}

/**
 * Attribute one family's write instant: the extraction that landed at exactly
 * that instant names its provenance, and every other write is a hand edit.
 * @param record - the scope record carrying the extraction.
 * @param at - the family's write instant.
 * @returns the gist and the session the write is attributable to.
 */
function writeProvenance(
  record: EvolutionMemoryRecord,
  at: string,
): { gist: string; sessionId: string | null } {
  const extraction = record.lastExtraction
  if (extraction === null || extraction.at !== at) return { gist: 'edited by hand', sessionId: null }
  return {
    gist: `${extraction.origin} · ${extraction.provider}/${extraction.model}`,
    sessionId: extraction.sessionId,
  }
}

/**
 * Every change the record proves, ascending by instant.
 * @param record - the scope record, when one exists.
 * @returns the deltas, or an empty list without a record.
 */
function recordDeltas(record: EvolutionMemoryRecord | undefined): TimelineDelta[] {
  if (record === undefined) return []
  const deltas: TimelineDelta[] = []
  const push = (kind: TimelineDeltaKind, at: string, gist: string, sessionId: string | null): void => {
    deltas.push({ day: dayOf(at), kind, gist, sessionId, at })
  }
  if (record.instructionsUpdatedAt != null) {
    const provenance = writeProvenance(record, record.instructionsUpdatedAt)
    push('instructions', record.instructionsUpdatedAt, provenance.gist, provenance.sessionId)
  }
  const lessonsAt = record.lessonsUpdatedAt
  const profileAt = record.profileUpdatedAt
  if (lessonsAt != null || profileAt != null) {
    if (lessonsAt != null) {
      const provenance = writeProvenance(record, lessonsAt)
      push('lessons', lessonsAt, provenance.gist, provenance.sessionId)
    }
    if (profileAt != null) {
      const provenance = writeProvenance(record, profileAt)
      push('profile', profileAt, provenance.gist, provenance.sessionId)
    }
  } else if (record.lastExtraction !== null) {
    const extraction = record.lastExtraction
    push('lessons', extraction.at, `${extraction.origin} · ${extraction.provider}/${extraction.model}`, extraction.sessionId)
  } else if (record.memoryUpdatedAt !== null) {
    push('lessons', record.memoryUpdatedAt, 'edited by hand', null)
  }
  for (const item of record.contextItems) {
    push('context', item.addedAt, item.label, null)
  }
  for (const output of record.outputs) {
    push('outputs', output.at, `${output.tool} ${output.path}`, output.sessionId)
  }
  for (const entry of record.staged) {
    const gist = entry.blockedReason === null
      ? `${entry.kind}:${entry.op} ${entry.gist}`
      : `${entry.kind}:${entry.op} ${entry.gist} (blocked: ${entry.blockedReason})`
    push('staged', entry.createdAt, gist, entry.originSessionId)
  }
  // ISO-8601 instants sort chronologically as text.
  return deltas.sort((left, right) => left.at.localeCompare(right.at))
}

/**
 * Project one staged entry onto its pending row.
 * @param entry - staged entry from the scope record.
 * @returns the pending row.
 */
function pendingOf(entry: StagedWrite): TimelinePending {
  return {
    id: entry.id,
    kind: entry.kind,
    op: entry.op,
    gist: entry.gist,
    originSessionId: entry.originSessionId,
    createdAt: entry.createdAt,
    blockedReason: entry.blockedReason,
    neededEvidence: entry.neededEvidence,
  }
}

/**
 * Build the timeline for one range. Deltas and decided entries outside the
 * window are dropped before bucketing, so a bounded range never reports an
 * older day, and `all` keeps only days that carry activity.
 * @param input - record, capacity, digest, range, and clock.
 * @returns the timeline, with zero-filled buckets for bounded ranges.
 */
export function scopeTimeline(input: TimelineInput): JourneyTimeline {
  const { record, range, now } = input
  const start = windowStartOfRange(range, now)
  const deltas = recordDeltas(record).filter(delta => Date.parse(delta.at) >= start)
  const byDay = new Map<string, TimelineDelta[]>()
  for (const delta of deltas) {
    const bucket = byDay.get(delta.day)
    if (bucket === undefined) byDay.set(delta.day, [delta])
    else bucket.push(delta)
  }
  const decisionsByDay = new Map<string, { approved: number; rejected: number }>()
  for (const resolution of record?.resolutions ?? []) {
    if (Date.parse(resolution.at) < start) continue
    const day = dayOf(resolution.at)
    const decisions = decisionsByDay.get(day) ?? { approved: 0, rejected: 0 }
    if (resolution.decision === 'approved') decisions.approved += 1
    else decisions.rejected += 1
    decisionsByDay.set(day, decisions)
  }
  const daysWithData = new Set([...byDay.keys(), ...decisionsByDay.keys()])
  const days = daysOfRange(range, now, daysWithData).map((day): TimelineDayBucket => {
    const found = byDay.get(day) ?? []
    const decisions = decisionsByDay.get(day)
    return {
      day,
      deltas: found,
      contextAttached: found.filter(delta => delta.kind === 'context').length,
      outputsIndexed: found.filter(delta => delta.kind === 'outputs').length,
      stagedOpened: found.filter(delta => delta.kind === 'staged').length,
      stagedApproved: decisions?.approved ?? 0,
      stagedRejected: decisions?.rejected ?? 0,
    }
  })
  return {
    range,
    now,
    days,
    cumulative: {
      usedBytes: input.usedBytes,
      capacityBytes: input.capacityBytes,
      digest: input.digest,
      lessonsBytes: artifactBytesOf(record?.agentLessons ?? []),
      profileBytes: utf8Bytes(record?.userProfile ?? ''),
    },
    pending: (record?.staged ?? []).map(pendingOf),
  }
}

/**
 * Render one day's activity as a single line. Callers pass days that carry at
 * least one delta or decision, so the function never states an empty day.
 * @param bucket - the day bucket.
 * @returns the day line, naming the kinds that moved.
 */
function renderDay(bucket: TimelineDayBucket): string {
  const tally: Partial<Record<TimelineDeltaKind, number>> = {}
  for (const delta of bucket.deltas) tally[delta.kind] = (tally[delta.kind] ?? 0) + 1
  const counted = (kind: TimelineDeltaKind): number => tally[kind] ?? 0
  const parts = [
    counted('instructions') === 0 ? undefined : `instructions ${counted('instructions')}`,
    counted('lessons') === 0 ? undefined : `lessons ${counted('lessons')}`,
    counted('profile') === 0 ? undefined : `profile ${counted('profile')}`,
    bucket.contextAttached === 0 ? undefined : `context ${bucket.contextAttached}`,
    bucket.outputsIndexed === 0 ? undefined : `outputs ${bucket.outputsIndexed}`,
    bucket.stagedOpened === 0 ? undefined : `staged ${bucket.stagedOpened}`,
    bucket.stagedApproved === 0 ? undefined : `approved ${bucket.stagedApproved}`,
    bucket.stagedRejected === 0 ? undefined : `rejected ${bucket.stagedRejected}`,
  ].filter((entry): entry is string => entry !== undefined)
  return `${bucket.day}  ${parts.join(' · ')}`
}

/**
 * Render the timeline as host-stable CLI text. Bounded ranges keep their
 * zero-filled buckets out of the listing and report the active-day count
 * instead, so a quiet `30d` window stays one screen.
 * @param timeline - the timeline to render.
 * @returns the command text.
 */
export function renderTimeline(timeline: JourneyTimeline): string {
  const active = timeline.days.filter(day =>
    day.deltas.length > 0 || day.stagedApproved > 0 || day.stagedRejected > 0)
  const window = timeline.range === 'all'
    ? `all (${active.length} active day${active.length === 1 ? '' : 's'})`
    : `${timeline.days[0]?.day ?? '-'}..${timeline.days.at(-1)?.day ?? '-'}`
  const header = `Journey (${timeline.range}) · ${window}`
  const cumulative = timeline.cumulative
  const percent = cumulative.capacityBytes === 0
    ? 0
    : Math.round((cumulative.usedBytes / cumulative.capacityBytes) * 100)
  const capacity = `Memory ${cumulative.usedBytes}/${cumulative.capacityBytes} bytes (${percent}%) · `
    + `lessons ${cumulative.lessonsBytes} · profile ${cumulative.profileBytes} · digest ${cumulative.digest}`
  const pending = timeline.pending.length === 0
    ? 'No staged writes.'
    : `${timeline.pending.length} staged write${timeline.pending.length === 1 ? '' : 's'}; run /memory pending.`
  const body = active.length === 0
    ? ['No recorded evolution activity in this range.']
    : active.map(renderDay)
  return [header, ...body, capacity, pending].join('\n')
}
