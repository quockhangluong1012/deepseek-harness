/**
 * The review findings panel: the rich surface one `/review` or
 * `/security-review` run leaves behind. It renders the durable
 * `review/report` record — what was reviewed, the reviewer's summary, and
 * every finding grouped high → medium → low — so findings stay readable
 * without re-reading the command's plain text.
 */

import { Tag, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewSeverity } from '@deepseek-ai/dsh-command-review'
import type { ReviewKey } from './locales.ts'
import css from './ReviewPanel.module.css'

/** Complete keyed Chat renderer props for the review panel. */
export type ReviewPanelProps = PropsRuntime<'conversation.chat.node', 'review'> & PropsLocale<'review'>

/** Severity presentation order: what a reader should act on first. */
const SEVERITY_ORDER: readonly ReviewSeverity[] = ['high', 'medium', 'low']

/** Palette and localized label each severity renders with. */
const SEVERITY_PRESENTATION = {
  high: { tone: 'danger', key: 'severity.high' },
  medium: { tone: 'warning', key: 'severity.medium' },
  low: { tone: 'quiet', key: 'severity.low' },
} as const satisfies Record<ReviewSeverity, { tone: TagTone; key: ReviewKey }>

/**
 * Render one settled independent review.
 * @param props - keyed Chat renderer props for the `review` kind.
 * @returns the review panel element.
 */
export function ReviewPanel({ node, t }: ReviewPanelProps) {
  const { kind, target, summary, findings } = node.data
  const title = t(kind === 'security' ? 'kind.security' : 'kind.code')
  const ordered = SEVERITY_ORDER.flatMap(severity => findings
    .filter(finding => finding.severity === severity)
    .map(finding => ({ severity, finding })))
  return (
    <section className={css.panel} aria-label={title} data-review-panel={kind}>
      <header className={css.header}>
        <span className={css.kind}>{title}</span>
        <span className={css.target}>{target.length === 0 ? t('target.uncommitted') : t('target.ref', { ref: target })}</span>
        <span className={css.count} data-review-count={findings.length}>
          {t(findings.length === 1 ? 'findings.count.one' : 'findings.count.other', { count: findings.length })}
        </span>
      </header>
      <p className={css.summary}>{summary}</p>
      {ordered.length === 0
        ? <p className={css.empty}>{t('findings.empty')}</p>
        : (
          <ul className={css.findings} aria-label={t('findings.label')}>
            {ordered.map(({ severity, finding }, index) => (
              <li key={`${severity}:${finding.file}:${finding.line ?? ''}:${String(index)}`} className={css.finding} data-review-severity={severity}>
                <Tag tone={SEVERITY_PRESENTATION[severity].tone} className={css.severity}>
                  {t(SEVERITY_PRESENTATION[severity].key)}
                </Tag>
                <span className={css.location}>{finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`}</span>
                <span className={css.message}>{finding.message}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
