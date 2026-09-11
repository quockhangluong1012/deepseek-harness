/**
 * The right-Sidebar usage body: the current session only, always cumulative.
 *
 * Live session figures arrive from the current session's `tokenUsage` and
 * `sessionStats` projections, so the panel stays live without a Remote round
 * trip. It carries no range filter: the header projections are cumulative by
 * construction. Cross-session totals live in the left-sidebar Dashboard
 * overlay (`DashboardAction.tsx`) instead.
 */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges the sessionStats key into SessionProjectionMap for useProjection.
import type {} from '@deepseek-ai/dsh-session-stats/client'
import type { TokenUsageProjection } from '@deepseek-ai/dsh-token-meter/client'
import { Card, formatCacheHit, formatCount } from './display.tsx'
import css from './UsageDashboard.module.css'

/** The session panel's composed props: the tab runtime share and copy. */
export type UsageDashboardProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsLocale<'sidebarUsage'>

/**
 * Billed prompt tokens of one usage projection.
 * @param usage - the session's token-usage projection value.
 * @returns billed input tokens.
 */
export function billedInputOf(usage: TokenUsageProjection): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
}

/**
 * The current-session usage panel.
 * @param props - composed slot props.
 * @returns the session header and its cumulative stat cards.
 */
export function UsageDashboard({ useProjection, t }: UsageDashboardProps): ReactNode {
  const usage = useProjection('tokenUsage')
  const stats = useProjection('sessionStats')
  const billed = usage === undefined ? 0 : billedInputOf(usage)

  return (
    <div className={css.dashboard} data-usage-state="ready">
      <section className={css.section} aria-label={t('session.title')} data-usage-section="session">
        <h2 className={css.sectionTitle}>{t('session.title')}</h2>
        <p className={css.sessionLine} data-usage-session-line>
          {t('session.requests')}{': '}{formatCount(stats?.steps ?? 0)}{' · '}
          {t('session.input')}{': '}{formatCount(billed)}{' · '}
          {t('session.output')}{': '}{formatCount(usage?.outputTokens ?? 0)}{' · '}
          {t('session.cacheHit')}{': '}{usage === undefined ? formatCacheHit(0) : formatCacheHit(usage.cacheReadTokens / Math.max(1, billed))}
        </p>
      </section>
      <section className={css.section} aria-label={t('session.title')} data-usage-section="cards">
        <ul className={css.cards}>
          <Card label={t('session.requests')} value={formatCount(stats?.steps ?? 0)} />
          <Card label={t('session.input')} value={formatCount(billed)} />
          <Card label={t('session.output')} value={formatCount(usage?.outputTokens ?? 0)} />
          <Card label={t('session.cacheHit')} value={formatCount(usage?.cacheReadTokens ?? 0)} />
          <Card
            label={t('cards.cacheHitAvg')}
            value={usage === undefined ? formatCacheHit(0) : formatCacheHit(usage.cacheReadTokens / Math.max(1, billed))}
          />
        </ul>
      </section>
    </div>
  )
}
