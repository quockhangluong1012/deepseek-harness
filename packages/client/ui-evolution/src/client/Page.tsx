/**
 * Evolution journey page body: one Scope's recorded evolution over a
 * switchable window, its staged writes awaiting a decision, the curator's
 * recorded passes, and the brief's charged bytes against its ceiling. Pure
 * props: facts arrive through the page Remote and the locale seat, and the
 * component owns only viewing state. Pending rows read the record projection,
 * which the follow stream keeps live, so a decision retires its row in the same
 * step the controller answers.
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type {
  CuratorPassSummary,
  EvolutionCuratorStatus,
  EvolutionMemoryValue,
  JourneyTimeline,
  StagedWrite,
  TimelineDayBucket,
  UsageRange,
} from '../types.ts'
import { followEvolution } from './rpc.ts'
import type { PageRemote } from './rpc.ts'
import type { EvolutionKey } from './locales.ts'
import css from './Page.module.css'

/** Locale seat. */
export type PageTranslate = (key: EvolutionKey, params?: Record<string, string | number>) => string

/** The four windows the range switch offers, in switch order. */
export const RANGES = ['today', '7d', '30d', 'all'] as const

/** Page props: the open Scope plus the Remote verbs and the locale seat. */
export interface EvolutionPageProps {
  /** Open Scope's Workspace identity, or null while none is selected. */
  scopeId: string | null
  /** Scope title (the Workspace name) for the header, or null. */
  scopeTitle: string | null
  /** Throwing Remote verbs plus the follow transport. */
  remote: PageRemote
  /** Locale seat. */
  t: PageTranslate
}

/**
 * Days that carry activity: a zero-filled bucket of a bounded range is a
 * calendar fact, not an event, so it never becomes a row.
 * @param timeline - the Scope's timeline.
 * @returns the buckets holding a delta or a decided staged write.
 */
export function activeDays(timeline: JourneyTimeline): readonly TimelineDayBucket[] {
  return timeline.days.filter(day =>
    day.deltas.length > 0 || day.stagedApproved > 0 || day.stagedRejected > 0)
}

/**
 * One bucket's non-zero tallies, in the fixed order the delta families render.
 * @param bucket - the day bucket.
 * @param t - locale seat.
 * @returns the tally labels, empty for a quiet day.
 */
export function bucketTallies(bucket: TimelineDayBucket, t: PageTranslate): readonly string[] {
  const entries: ReadonlyArray<readonly [EvolutionKey, number]> = [
    ['tally.instructions', bucket.deltas.filter(delta => delta.kind === 'instructions').length],
    ['tally.lessons', bucket.deltas.filter(delta => delta.kind === 'lessons').length],
    ['tally.profile', bucket.deltas.filter(delta => delta.kind === 'profile').length],
    ['tally.context', bucket.contextAttached],
    ['tally.outputs', bucket.outputsIndexed],
    ['tally.staged', bucket.stagedOpened],
    ['tally.approved', bucket.stagedApproved],
    ['tally.rejected', bucket.stagedRejected],
  ]
  return entries
    .filter(([, count]) => count > 0)
    .map(([key, count]) => t(key, { n: count }))
}

/**
 * Bar width for one charged family, clamped so an over-capacity record still
 * fills its track exactly.
 * @param bytes - charged bytes of the family.
 * @param capacity - the configured ceiling.
 * @returns the width as a percentage.
 */
export function barPercent(bytes: number, capacity: number): number {
  if (capacity <= 0) return 0
  return Math.min(100, (bytes / capacity) * 100)
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/**
 * Render the evolution journey page.
 * @param props - the open Scope, Remote verbs, and locale.
 * @returns the page element.
 */
export function EvolutionPage({ scopeId, scopeTitle, remote, t }: EvolutionPageProps) {
  const [range, setRange] = useState<UsageRange>('7d')
  const [value, setValue] = useState<EvolutionMemoryValue | null>(null)
  const [timeline, setTimeline] = useState<JourneyTimeline | null>(null)
  const [curator, setCurator] = useState<EvolutionCuratorStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  // A Scope change starts a fresh reading; a post-decision refresh keeps what
  // is already on screen.
  useEffect(() => {
    setValue(null)
    setTimeline(null)
    setCurator(null)
    setError(null)
    setRange('7d')
  }, [scopeId])

  useEffect(() => {
    if (scopeId === null) return
    const controller = new AbortController()
    let cancelled = false
    const fail = (reason: unknown): void => {
      if (!cancelled) setError(messageOf(reason))
    }
    const id = scopeId as WorkspaceId
    void remote.read(id).then((next) => { if (!cancelled) setValue(next) }, fail)
    void remote.timeline(id, range, controller.signal).then((next) => { if (!cancelled) setTimeline(next) }, fail)
    void remote.curatorStatus(controller.signal).then((next) => { if (!cancelled) setCurator(next) }, fail)
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [scopeId, range, refresh, remote])

  useEffect(() => {
    if (scopeId === null) return
    let cancelled = false
    const stream = followEvolution(remote, {
      replace: (values) => {
        if (cancelled) return
        setValue(values.find(entry => String(entry.workspaceId) === scopeId) ?? null)
      },
      upsert: (entry) => {
        if (cancelled || String(entry.workspaceId) !== scopeId) return
        setValue(entry)
      },
      failed: (failure: unknown) => {
        /* v8 ignore next -- the snapshot stream suppresses failures once
        disposed, and disposal always accompanies cancellation. */
        if (!cancelled) setError(messageOf(failure))
      },
    })
    return () => {
      cancelled = true
      void stream.dispose()
    }
  }, [scopeId, remote])

  const decide = useCallback((id: WorkspaceId, stagedId: string, approve: boolean): void => {
    setDeciding(stagedId)
    setError(null)
    const call = approve ? remote.approveStaged(id, stagedId) : remote.rejectStaged(id, stagedId)
    void call.then(
      (next) => {
        setValue(next)
        setDeciding(null)
        setRefresh(token => token + 1)
      },
      (reason: unknown) => {
        setError(messageOf(reason))
        setDeciding(null)
      },
    )
  }, [remote])

  if (scopeId === null) {
    return (
      <section className={css.page} aria-label={t('page.title')} data-testid="evolution-page">
        <div className={css.header}>
          <h1 className={css.title}>{t('page.title')}</h1>
        </div>
        <p className={css.empty}>{t('page.noScope')}</p>
      </section>
    )
  }

  const loading = value === null && error === null
  const buckets = timeline === null ? null : activeDays(timeline)
  const totalDays = timeline === null ? 0 : timeline.days.length
  const pending: readonly StagedWrite[] = value?.staged ?? []
  const usedBytes = value?.usage.usedBytes ?? 0
  const capacityBytes = value?.usage.capacityBytes ?? 0
  const lessonsBytes = timeline?.cumulative.lessonsBytes ?? 0
  const profileBytes = timeline?.cumulative.profileBytes ?? 0
  const digest = timeline?.cumulative.digest ?? ''
  const passes: readonly CuratorPassSummary[] = curator?.passes ?? []

  return (
    <section className={css.page} aria-label={t('page.title')} data-testid="evolution-page">
      <div className={css.header}>
        <h1 className={css.title}>{scopeTitle ?? t('page.title')}</h1>
      </div>
      {error !== null && <p role="alert" className={css.error}>{error}</p>}
      {loading && <p role="status" className={css.status}>{t('page.loading')}</p>}

      <div className={css.cards}>
        <section aria-label={t('timeline.title')} className={`${css.card} ${css.wide}`}>
          <div className={css.cardHead}>
            <h2 className={css.cardTitle}>{t('timeline.title')}</h2>
            <div role="tablist" aria-label={t('range.label')} className={css.ranges}>
              {RANGES.map(item => (
                <Pill
                  key={item}
                  role="tab"
                  aria-selected={range === item}
                  active={range === item}
                  onClick={() => { setRange(item) }}
                >
                  {t(`range.${item}`)}
                </Pill>
              ))}
            </div>
          </div>
          {buckets === null || buckets.length === 0
            ? <p className={css.empty}>{t('timeline.empty')}</p>
            : (
              <>
                <p className={css.meta}>
                  {t('timeline.window', {
                    range: t(`range.${range}`),
                    active: buckets.length,
                    days: totalDays,
                  })}
                </p>
                <ul className={css.days} data-testid="evolution-timeline">
                  {buckets.map(bucket => (
                    <li key={bucket.day} className={css.day}>
                      <div className={css.dayHead}>
                        <span className={css.dayKey}>{bucket.day}</span>
                        <span className={css.tallies}>
                          {bucketTallies(bucket, t).map(tally => (
                            <span key={tally} className={css.tally}>{tally}</span>
                          ))}
                        </span>
                      </div>
                      <ul className={css.deltas}>
                        {bucket.deltas.map((delta, index) => (
                          <li key={`${delta.at}:${delta.kind}:${index}`} className={css.delta}>
                            <span className={css.deltaKind}>{t(`kind.${delta.kind}`)}</span>
                            <span className={css.deltaGist}>{delta.gist}</span>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </>
            )}
        </section>

        <section aria-label={t('pending.title')} className={css.card}>
          <div className={css.cardHead}>
            <h2 className={css.cardTitle}>{t('pending.title')}</h2>
          </div>
          {pending.length === 0
            ? <p className={css.empty}>{t('pending.empty')}</p>
            : (
              <ul className={css.pending} data-testid="evolution-pending">
                {pending.map(entry => (
                  <li key={entry.id} className={css.pendingRow}>
                    {/* Wire vocabulary (`memory:setLessons`) stays verbatim;
                        the gist is the entry's own one-line summary. */}
                    <span className={css.pendingGist}>{`${entry.kind}:${entry.op} ${entry.gist}`}</span>
                    <span className={css.pendingMeta}>
                      {t('pending.origin', { session: entry.originSessionId })}
                    </span>
                    <div className={css.pendingActions}>
                      <Button
                        variant="primary"
                        size="sm"
                        disabled={deciding !== null}
                        onClick={() => { decide(scopeId as WorkspaceId, entry.id, true) }}
                      >
                        {t('pending.approve')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={deciding !== null}
                        onClick={() => { decide(scopeId as WorkspaceId, entry.id, false) }}
                      >
                        {t('pending.reject')}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </section>

        <section aria-label={t('curator.title')} className={css.card}>
          <div className={css.cardHead}>
            <h2 className={css.cardTitle}>{t('curator.title')}</h2>
          </div>
          {loading
            ? <p className={css.status}>{t('page.loading')}</p>
            : curator === null || !curator.mounted
              ? <p className={css.empty}>{t('curator.unmounted')}</p>
              : passes.length === 0
                ? <p className={css.empty}>{t('curator.empty')}</p>
                : (
                  <>
                    {curator.lastRunAt !== null && (
                      <p className={css.meta}>{t('curator.lastRun', { at: curator.lastRunAt })}</p>
                    )}
                    <p className={css.meta}>{t('curator.passes', { n: passes.length })}</p>
                    <ul className={css.passes} data-testid="evolution-curator-passes">
                      {passes.map(pass => (
                        <li key={pass.passId} className={css.pass}>
                          <span className={css.passId}>{pass.passId}</span>
                          <span className={css.passMeta}>{t('curator.transitions', { n: pass.transitions })}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
        </section>

        <section aria-label={t('capacity.title')} className={css.card}>
          <div className={css.cardHead}>
            <h2 className={css.cardTitle}>{t('capacity.title')}</h2>
          </div>
          <div className={css.bars}>
            <div className={css.bar}>
              <span className={css.barLabel}>{t('capacity.used', { used: usedBytes, capacity: capacityBytes })}</span>
              <div className={css.barTrack}>
                <div className={css.barFill} style={{ width: `${barPercent(usedBytes, capacityBytes)}%` }} />
              </div>
            </div>
            <div className={css.bar}>
              <span className={css.barLabel}>{t('capacity.lessons', { bytes: lessonsBytes })}</span>
              <div className={css.barTrack}>
                <div className={css.barFill} style={{ width: `${barPercent(lessonsBytes, capacityBytes)}%` }} />
              </div>
            </div>
            <div className={css.bar}>
              <span className={css.barLabel}>{t('capacity.profile', { bytes: profileBytes })}</span>
              <div className={css.barTrack}>
                <div className={css.barFill} style={{ width: `${barPercent(profileBytes, capacityBytes)}%` }} />
              </div>
            </div>
          </div>
          {timeline !== null && <p className={css.meta}>{t('capacity.digest', { digest })}</p>}
        </section>
      </div>
    </section>
  )
}
