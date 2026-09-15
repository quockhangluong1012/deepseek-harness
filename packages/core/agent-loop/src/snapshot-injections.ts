/**
 * Surface state for pre-step snapshots that declare `supersedes` (the
 * evolution-memory brief): the newest one from a producer replaces that
 * producer's previous one on the surface, so the model reads the live brief
 * instead of every brief ever injected. The log keeps every injection and only
 * the surface is folded this way, so the replacement is a view: a human
 * transcript and a log replay still see each snapshot where it was committed.
 * Snapshots that do not declare it — a reading per step, whose later entry
 * measures elapsed time against the earlier one — always append.
 * @module @deepseek-ai/dsh-agent-loop/snapshot-injections
 */

import type { Context } from '@deepseek-ai/cordis'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionSeq, SurfaceIntent, UserMessage } from '@deepseek-ai/dsh-session'

/** Committed events from the newest backward; the restore scan stops at the first match. */
function eventsNewestFirst(session: Session): readonly SessionEvent[] {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().toReversed()
}

/** One source that declared a superseding snapshot. */
type SnapshotSource = UserMessage['source'] & { form: 'snapshot'; supersedes: true }

/**
 * Narrow a source to the superseding snapshot form.
 * @param source - the source a pre-step listener declared.
 * @returns true when the source presents named sections and supersedes.
 */
function isSnapshotSource(source: UserMessage['source']): source is SnapshotSource {
  return 'form' in source && source.form === 'snapshot' && 'supersedes' in source
}

/**
 * Identity two snapshots share when the later one supersedes the earlier:
 * the producer alone. A snapshot's sections are its payload, so two briefs
 * from one plugin are one slot even when their content, digest, or scope
 * differs — the older brief in a moved session is exactly the stale one. A
 * source that declares no `supersedes`, such as a per-step reading that a
 * later reading measures elapsed time against, has no slot and appends.
 * @param source - the source a pre-step listener declared.
 * @returns the producing slot, or undefined for a source that always appends.
 */
export function snapshotSlot(source: UserMessage['source']): string | undefined {
  if (!isSnapshotSource(source)) return undefined
  return source.kind === 'plugin' ? `plugin:${source.plugin}` : `kind:${source.kind}`
}

/**
 * Which surface node holds each producer's live snapshot, read from the
 * committed log: the newest live snapshot per producer, skipping one a later
 * replacement shadowed.
 * @param session - session whose surface the injections enter.
 * @returns the restored slot map.
 */
export function restoreSnapshotSlots(session: Session): Map<string, SessionSeq> {
  const retained = new Map<string, SessionSeq>()
  const surface = new Set(session.surface.nodes)
  for (const event of eventsNewestFirst(session)) {
    if (event.type !== 'user/message') continue
    const slot = snapshotSlot(event.data.source)
    if (slot === undefined || retained.has(slot)) continue
    if (surface.has(event.seq)) retained.set(slot, event.seq)
  }
  return retained
}

/**
 * Tracks which surface node holds each producer's live snapshot and hands the
 * loop the surface intent that supersedes it. Restores from the committed log
 * once, then follows authoritative session events.
 */
export class SnapshotInjectionProjection {
  private readonly retained: Map<string, SessionSeq>

  /**
   * Restore projection state once, then follow authoritative session events.
   * @param ctx - agent-scoped event context.
   * @param session - session whose surface the injections enter.
   */
  constructor(ctx: Context, session: Session) {
    this.retained = restoreSnapshotSlots(session)

    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message') {
        const slot = snapshotSlot(event.data.source)
        if (slot !== undefined) this.retained.set(slot, event.seq)
      }
      // A landed replacement shadows the node this projection retained — the
      // snapshot message itself can be one — and the producer's next snapshot
      // then appends into an empty slot again.
      if (this.retained.size === 0 || !isReplacementSurfaceEvent(event)) return
      // oxlint-disable-next-line typescript/no-non-null-assertion -- a committed replacement always cites every node it shadowed
      const sources = event.sourceEventSeqs!
      for (const [slot, seq] of this.retained) {
        if (sources.includes(seq)) this.retained.delete(slot)
      }
    })
  }

  /**
   * The surface intent one injected message enters with: the slot's previous
   * node is replaced, and any other message appends.
   * @param source - the source the pre-step listener declared on the message.
   * @returns the intent to pass to {@link Session.append}.
   */
  intentFor(source: UserMessage['source']): SurfaceIntent<'user/message'> {
    const slot = snapshotSlot(source)
    const previous = slot === undefined ? undefined : this.retained.get(slot)
    if (previous === undefined) return { surfaceOp: 'append' }
    return { surfaceOp: { op: 'replace', startSeq: previous, endSeq: previous }, sourceEventSeqs: [previous] }
  }
}
