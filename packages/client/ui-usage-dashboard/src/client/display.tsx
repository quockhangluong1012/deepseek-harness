/**
 * Shared dashboard presentation: count formatting, stacked bar geometry, and
 * the cross-session summary body (stat cards, daily chart, per-model table).
 *
 * Both the left-sidebar all-sessions overlay and any future summary surface
 * read from here, so the two never drift into duplicated render code. The
 * right-Sidebar current-session panel reads only the count formatting and
 * the stat tile.
 */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { UsageDayBucket, UsageRange, UsageSummary } from '@deepseek-ai/dsh-usage-ledger/types'
import type { SidebarUsageKey } from './locales.ts'
import css from './UsageDashboard.module.css'

/** Filter ranges in the order the filter row offers them. */
export const USAGE_RANGES: readonly UsageRange[] = ['today', '7d', '30d', 'all']

/**
 * Display grouping for large counts.
 * @param value - the count.
 * @returns the count with thousands separators.
 */
export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

/**
 * Display share of a cache-hit average.
 * @param avg - the share in `[0, 1]`.
 * @returns percent text with one decimal.
 */
export function formatCacheHit(avg: number): string {
  return `${(avg * 100).toFixed(1)}%`
}

/**
 * Bar geometry for one day's stacked input/output total.
 * @param bucket - the day's bucket.
 * @param max - the largest day total in the window; zero draws nothing.
 * @param height - the chart's bar area height.
 * @returns input and output segment heights, bottom-up.
 */
export function barHeights(bucket: UsageDayBucket, max: number, height: number): { input: number; output: number } {
  if (max <= 0) return { input: 0, output: 0 }
  const total = bucket.inputTokens + bucket.outputTokens
  if (total <= 0) return { input: 0, output: 0 }
  const scaled = (value: number): number => Math.max(value <= 0 ? 0 : 1, (value / max) * height)
  return { input: scaled(bucket.inputTokens), output: scaled(bucket.outputTokens) }
}

/**
 * The largest stacked day total in the window.
 * @param daily - the window's day buckets.
 * @returns the maximum input-plus-output total, or zero.
 */
export function maxDayTotal(daily: readonly UsageDayBucket[]): number {
  return daily.reduce((max, bucket) => Math.max(max, bucket.inputTokens + bucket.outputTokens), 0)
}

/** Chart canvas constants. */
const CHART_HEIGHT = 96
const CHART_WIDTH = 300

/** Translate face the summary body formats through (the `sidebarUsage` namespace). */
export type SummaryText = (key: SidebarUsageKey, params?: Record<string, unknown>) => string

/** One stat tile. */
export function Card({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <li className={css.card}>
      <span className={css.cardLabel}>{label}</span>
      <span className={css.cardValue}>{value}</span>
    </li>
  )
}

/** Stacked input/output bars, one group per day. */
export function Chart({ daily, hasData }: { daily: readonly UsageDayBucket[]; hasData: boolean }): ReactNode {
  const max = maxDayTotal(daily)
  const slot = daily.length === 0 ? CHART_WIDTH : CHART_WIDTH / daily.length
  const width = Math.max(2, slot * 0.6)
  return (
    <svg
      className={css.chart}
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      role="img"
      data-usage-chart={hasData ? 'data' : 'empty'}
    >
      {daily.map((bucket, index) => {
        const { input, output } = barHeights(bucket, max, CHART_HEIGHT)
        const x = index * slot + (slot - width) / 2
        if (input + output <= 0) {
          return (
            <rect
              key={bucket.day}
              className={css.barEmpty}
              x={x}
              y={CHART_HEIGHT - 2}
              width={width}
              height={2}
              data-usage-day={bucket.day}
            />
          )
        }
        return (
          <g key={bucket.day} data-usage-day={bucket.day} data-usage-requests={bucket.requests}>
            <rect className={css.barInput} x={x} y={CHART_HEIGHT - input - output} width={width} height={input} />
            <rect className={css.barOutput} x={x} y={CHART_HEIGHT - output} width={width} height={output} />
          </g>
        )
      })}
    </svg>
  )
}

/** The fetched window: cards, chart, and table, or the failure line. */
export function SummaryBody({ summary, hasData, loading, failureCode, t, onRetry }: {
  summary: UsageSummary
  hasData: boolean
  loading: boolean
  failureCode: string | undefined
  t: SummaryText
  onRetry: () => void
}): ReactNode {
  return (
    <>
      <section className={css.section} aria-label={t('cards.requests')} data-usage-section="cards">
        <ul className={css.cards}>
          <Card label={t('cards.requests')} value={formatCount(summary.totals.requests)} />
          <Card label={t('cards.input')} value={formatCount(summary.totals.inputTokens)} />
          <Card label={t('cards.output')} value={formatCount(summary.totals.outputTokens)} />
          <Card label={t('cards.cacheHit')} value={formatCount(summary.totals.cacheReadTokens)} />
          <Card label={t('cards.cacheHitAvg')} value={formatCacheHit(summary.totals.cacheHitAvg)} />
        </ul>
      </section>
      <section className={css.section} aria-label={t('chart.title')} data-usage-section="chart">
        <h2 className={css.sectionTitle}>{t('chart.title')}</h2>
        <ul className={css.legend}>
          <li><span className={clsx(css.swatch, css.swatchInput)} aria-hidden />{t('chart.input')}</li>
          <li><span className={clsx(css.swatch, css.swatchOutput)} aria-hidden />{t('chart.output')}</li>
        </ul>
        <Chart daily={summary.daily} hasData={hasData} />
        {!hasData && <p className={css.noData} data-usage-no-data>{t('chart.noData')}</p>}
      </section>
      <section className={css.section} aria-label={t('table.title')} data-usage-section="models">
        <h2 className={css.sectionTitle}>{t('table.title')}</h2>
        {summary.models.length === 0 ? (
          <p className={css.tableEmpty} data-usage-models-empty>{t('table.empty')}</p>
        ) : (
          <table className={css.table} data-usage-models>
            <thead>
              <tr>
                <th scope="col">{t('table.model')}</th>
                <th scope="col">{t('table.requests')}</th>
                <th scope="col">{t('table.input')}</th>
                <th scope="col">{t('table.output')}</th>
                <th scope="col">{t('table.total')}</th>
                <th scope="col">{t('table.cacheHit')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.models.map(row => (
                <tr
                  key={`${row.provider}/${row.model}`}
                  data-usage-model={`${row.provider}/${row.model}`}
                >
                  <td>{row.provider} / {row.model}</td>
                  <td>{formatCount(row.requests)}</td>
                  <td>{formatCount(row.inputTokens)}</td>
                  <td>{formatCount(row.outputTokens)}</td>
                  <td>{formatCount(row.inputTokens + row.outputTokens)}</td>
                  <td>{formatCacheHit(row.cacheHitAvg)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {failureCode !== undefined && !loading && (
        <div className={css.status} data-usage-summary="failed">
          <p className={clsx(css.statusLine, css.failed)}>{t('state.failed', { message: failureCode })}</p>
          <button type="button" className={css.retry} data-usage-retry onClick={onRetry}>{t('state.retry')}</button>
        </div>
      )}
    </>
  )
}
