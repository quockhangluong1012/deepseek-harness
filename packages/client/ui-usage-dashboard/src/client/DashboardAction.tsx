/**
 * The left-sidebar Dashboard entry: a footer-action trigger row plus its
 * full-viewport all-sessions panel.
 *
 * The trigger lives in `sidebar.footer.action` beside Settings, so it renders
 * in both the wide column and the 56px rail. The panel is a fixed-position
 * descendant of that row (the Settings shell's precedent): a mask plus a
 * centered dialog holding the cross-session summary — the range filter, the
 * window stat cards, the stacked daily chart, and the per-model table — read
 * from the Host ledger over the `usageDashboard` Remote namespace. The right
 * Sidebar keeps the current session only and fetches nothing.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import clsx from 'clsx'
import { IconCloseOutlineRegular, IconGaugeOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the sidebar footer-action SlotMap row into this program.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { UsageRange } from '@deepseek-ai/dsh-usage-ledger/types'
import { SummaryBody, USAGE_RANGES } from './display.tsx'
import type { UsageInjected } from './face.ts'
import { DEFAULT_USAGE_RANGE } from './store.ts'
import type { UsageStore } from './store.ts'
import css from './DashboardAction.module.css'
import bodyCss from './UsageDashboard.module.css'

/** The overlay's bucket in the shared dashboard store. */
export const DASHBOARD_OVERLAY_ID = 'dashboard-overlay' as TabId

/** The footer action's composed props: the column state, the shared store and fetch face, and copy. */
export type DashboardActionProps =
  & PropsRuntime<'sidebar.footer.action'>
  & PropsStore<UsageStore>
  & InjectFace<UsageInjected>
  & PropsLocale<'sidebarUsage'>

/**
 * Render the Dashboard trigger and, while open, its all-sessions panel.
 * @param props - composed slot props.
 * @returns the trigger row plus the modal dialog when open.
 */
export function DashboardAction({ wide, useStore, actions, loadSummary, t }: DashboardActionProps): ReactNode {
  const [open, setOpen] = useState(false)
  // One lifetime for the dialog's fetch bookkeeping: the store outlives the
  // dialog, so a reopened panel reads its settled summary without refetching.
  const [lifetime] = useState(() => new AbortController())
  const state = useStore(s => s.byTab[DASHBOARD_OVERLAY_ID])
  const range = state?.range ?? DEFAULT_USAGE_RANGE
  const summary = state?.summaries[range]
  const loading = state?.loading ?? false
  const failure = state?.failure

  // First open fetches the default range; a reopened dialog with a settled
  // summary reads it without a round trip, and a range switch without one
  // fetches it the same way.
  const started = state !== undefined
  useEffect(() => {
    if (!open) return
    if (!started) {
      actions.selectRange(DASHBOARD_OVERLAY_ID, DEFAULT_USAGE_RANGE)
      loadSummary(DASHBOARD_OVERLAY_ID, DEFAULT_USAGE_RANGE, lifetime.signal)
    } else if (summary === undefined && !loading && failure === undefined) {
      loadSummary(DASHBOARD_OVERLAY_ID, range, lifetime.signal)
    }
  }, [open, lifetime, started, summary, loading, failure, range, actions, loadSummary])

  // Document-level Escape closes the dialog while it is open.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])

  const hasData = (summary?.totals.requests ?? 0) > 0
  const label = t('action.open')

  return (
    <>
      <Tooltip label={label} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={clsx(css.trigger, !wide && css.rail)}
          aria-label={label}
          aria-expanded={open}
          data-dashboard-action="trigger"
          onClick={() => { setOpen(true) }}
        >
          <IconGaugeOutlineRegular size={wide ? 16 : 18} />
          {wide && <span className={css.triggerLabel}>{label}</span>}
        </button>
      </Tooltip>
      {open && (
        <div className={css.overlay} role="presentation" data-dashboard-action="overlay">
          <div className={css.mask} aria-hidden="true" data-dashboard-action="mask" onClick={() => { setOpen(false) }} />
          <div className={css.panel} role="dialog" aria-modal="true" aria-label={t('overlay.title')}>
            <div className={css.header}>
              <h2 className={css.title}>{t('overlay.title')}</h2>
              <button
                type="button"
                className={css.close}
                aria-label={t('overlay.close')}
                data-dashboard-action="close"
                onClick={() => { setOpen(false) }}
              >
                <IconCloseOutlineRegular size={14} />
              </button>
            </div>
            <div className={css.body}>
              <section className={bodyCss.section} aria-label={t('filter.label')} data-usage-section="filter">
                <div className={bodyCss.filters} role="group" aria-label={t('filter.label')}>
                  {USAGE_RANGES.map(candidate => (
                    <FilterButton
                      key={candidate}
                      candidate={candidate}
                      active={candidate === range}
                      label={t(`filter.${candidate}`)}
                      onSelect={() => { actions.selectRange(DASHBOARD_OVERLAY_ID, candidate) }}
                    />
                  ))}
                </div>
              </section>
              {summary === undefined ? (
                failure !== undefined && !loading ? (
                  <div className={bodyCss.status} data-usage-summary="failed">
                    <p className={clsx(bodyCss.statusLine, bodyCss.failed)}>{t('state.failed', { message: failure.code })}</p>
                    <button
                      type="button"
                      className={bodyCss.retry}
                      data-usage-retry
                      onClick={() => { loadSummary(DASHBOARD_OVERLAY_ID, range, lifetime.signal) }}
                    >
                      {t('state.retry')}
                    </button>
                  </div>
                ) : (
                  <div className={bodyCss.status} data-usage-summary="loading">
                    <p className={bodyCss.statusLine}>{t('state.loading')}</p>
                  </div>
                )
              ) : (
                <SummaryBody
                  summary={summary}
                  hasData={hasData}
                  loading={loading}
                  failureCode={failure?.code}
                  t={t}
                  onRetry={() => { loadSummary(DASHBOARD_OVERLAY_ID, range, lifetime.signal) }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** One range toggle in the overlay's filter row. */
function FilterButton({ candidate, active, label, onSelect }: {
  candidate: UsageRange
  active: boolean
  label: string
  onSelect: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={clsx(bodyCss.filter, active && bodyCss.filterOn)}
      aria-pressed={active}
      data-usage-filter={candidate}
      onClick={onSelect}
    >
      {label}
    </button>
  )
}
