import { useMemo, useState } from 'react'
import {
  DisclosureRow, IconChevronRightOutlineRegular, StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TaskStatus } from '@deepseek-ai/dsh-agent-kernel/src/types.ts'
import type { KernelTaskData } from './task-definition.ts'
import type { KernelTaskKey } from './locales.ts'
import css from './KernelTaskPanel.module.css'

/** Complete keyed Chat renderer props. */
export type KernelTaskPanelProps =
  PropsRuntime<'conversation.chat.node', 'kernel-task'>
  & PropsLocale<'kernelTask'>

const STATUS_KEYS = {
  intake: 'status.intake',
  planning: 'status.planning',
  ready: 'status.ready',
  executing: 'status.executing',
  observing: 'status.observing',
  verifying: 'status.verifying',
  recovering: 'status.recovering',
  'awaiting-approval': 'status.awaiting-approval',
  'awaiting-user': 'status.awaiting-user',
  paused: 'status.paused',
  completed: 'status.completed',
  failed: 'status.failed',
  cancelled: 'status.cancelled',
} as const satisfies Record<TaskStatus, KernelTaskKey>

/** Dot state for one task status; an interrupted run is a warning, not a failure. */
function dotState(data: KernelTaskData): StateDotState {
  if (data.interrupted) return 'warning'
  switch (data.status) {
    case 'completed': return 'done'
    case 'failed': return 'error'
    case 'cancelled':
    case 'paused':
    case 'awaiting-approval':
    case 'awaiting-user': return 'warning'
    case 'intake':
    case 'planning':
    case 'ready':
    case 'executing':
    case 'observing':
    case 'verifying':
    case 'recovering': return 'ongoing'
    /* v8 ignore next -- TaskStatus is closed and every variant is handled above. */
    default: return data.status satisfies never
  }
}

/** Human-readable objective, falling back to copy when the task recorded none. */
function readableObjective(objective: string, t: KernelTaskPanelProps['t']): string {
  return objective === '' ? t('task.empty') : objective
}

/** Every configured ceiling, in a stable order. */
function budgetEntries(data: KernelTaskData): readonly (readonly [string, number])[] {
  const budget = data.budget
  const entries: (readonly [string, number | undefined])[] = [
    ['maxSteps', budget.maxSteps],
    ['maxToolCalls', budget.maxToolCalls],
    ['maxTokens', budget.maxTokens],
    ['maxWallMs', budget.maxWallMs],
    ['maxCostUsd', budget.maxCostUsd],
    ['maxSubagentDepth', budget.maxSubagentDepth],
  ]
  return entries.filter((entry): entry is readonly [string, number] => entry[1] !== undefined)
}

/**
 * One durable task contract: its objective and status collapsed, its plan,
 * budget, verification, checkpoint, and research record expanded.
 * @param props - the keyed Chat renderer props.
 * @returns the rendered node.
 */
export function KernelTaskPanel({ node, t }: KernelTaskPanelProps) {
  const data = node.data
  const [open, setOpen] = useState(data.status !== 'completed' && !data.interrupted)
  const budget = useMemo(() => budgetEntries(data), [data.budget])
  const summary = [
    t('revision.one', { revision: data.revision }),
    ...data.openActions === 0 ? [] : [t('openActions', { count: data.openActions })],
    ...data.unresolvedFailures.length === 0 ? [] : [t('failures', { count: data.unresolvedFailures.length })],
    ...data.interrupted ? [t('task.interrupted')] : [],
  ].join(' · ')
  return (
    <div className={css.task} data-task-status={data.status} data-task-interrupted={data.interrupted}>
      <DisclosureRow
        icon={<IconChevronRightOutlineRegular />}
        title={readableObjective(data.objective, t)}
        open={open}
        onToggle={() => { setOpen(current => !current) }}
        expandable
        expandOnRowClick
        previewChevron={false}
        keepContentWhenOpen
        rowClassName={css.header}
        leadingClassName={css.leading}
        titleClassName={css.title}
        collapsedContent={(
          <>
            <span className={css.dotSlot}><StateDot state={dotState(data)} /></span>
            <span className={css.status} data-task-status-text>
              {data.interrupted ? t('task.interrupted') : t(STATUS_KEYS[data.status])}
            </span>
            <span className={css.separator} aria-hidden />
            <span className={css.summary} data-task-summary>{summary}</span>
          </>
        )}
      >
        <div className={css.body}>
          <p className={css.line} data-task-profile>{t('profile.agent', { name: data.agentProfile })}</p>
          <p className={css.line} data-task-policy>{t('profile.policy', { name: data.policyProfile })}</p>
          <p className={css.line} data-task-budget>
            {t('budget.title')}: {budget.length === 0
              ? t('budget.unbounded')
              : budget.map(([name, value]) => `${name}=${String(value)}`).join(', ')}
          </p>
          <p className={css.line} data-task-plan>
            {data.planRevision === undefined
              ? t('plan.empty')
              : `${t('plan.title', { revision: data.planRevision })}: ${data.planSteps.map(step => t('plan.step', { text: step })).join(' → ')}`}
          </p>
          <p className={css.line} data-task-verification>
            {data.verification === undefined
              ? t('verification.none')
              : [
                t('verification.title', { status: data.verification.status }),
                t('verification.verifier', { version: data.verification.verifierVersion }),
                ...data.verification.criteria.map(criterion => t('verification.criterion', {
                  id: criterion.criterionId,
                  status: criterion.status,
                })),
              ].join(' · ')}
          </p>
          {data.checkpoint === undefined ? null : (
            <p className={css.line} data-task-checkpoint>
              {t('checkpoint.title', { id: data.checkpoint.checkpointId })}
              {' · '}
              {t('checkpoint.reason', { reason: data.checkpoint.reason })}
              {' · '}
              {t('checkpoint.cover', { seq: data.checkpoint.sessionSeq })}
            </p>
          )}
          <p className={css.line} data-task-research>
            {t('research.title')}: {t('research.counts', {
              evidence: data.evidence,
              claims: data.claims,
              hypotheses: data.hypotheses,
            })}
          </p>
          {data.claimRecords.length === 0 ? null : (
            <p className={css.line} data-task-lineage>
              {t('lineage.title')}: {data.claimRecords.map(claim => [
                t('lineage.claim', { statement: claim.statement, status: claim.status, confidence: claim.confidence }),
                ...claim.evidence.map(ev => t('lineage.evidence', { kind: ev.kind, ref: ev.contentRef, trust: ev.trust })),
              ].join(' — ')).join('; ')}
            </p>
          )}
          {data.unresolvedFailures.length === 0 ? null : (
            <p className={css.line} data-task-failures data-task-failure-kinds={data.unresolvedFailures.join(',')}>
              {t('failures', { count: data.unresolvedFailures.length })}
            </p>
          )}
        </div>
      </DisclosureRow>
    </div>
  )
}
