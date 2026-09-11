/**
 * The progress panel: the Session's standing checklist, then the files its
 * Turns produced. Both sections read what their owners already publish — the
 * `todos` projection and the Chat target's Turn data — so the panel adds no
 * folding, no store, and no request of its own. A file row opens that file in
 * the Sidebar, landing in this tab's own pane.
 */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { classifyLinkPath, IconCheckOutline14, LinkIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { fileAddressFor, workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo/client'
import type { ProgressKey } from './locales.ts'
import { producedPaths } from './progress.ts'
import css from './ProgressBody.module.css'

/** The panel's composed props: the tab it draws, the standard Session hooks, and its copy. */
export type ProgressBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'sidebarProgress'>

/** Shared empty checklist, so an absent projection is one stable value. */
const NO_TODOS: readonly TodoItem[] = []

/** One status per key, so the glyph's accessible name follows the status union. */
const STATUS_LABEL = {
  completed: 'tasks.status.completed',
  in_progress: 'tasks.status.inProgress',
  pending: 'tasks.status.pending',
} as const satisfies Record<TodoItem['status'], ProgressKey>

/**
 * The checklist row's mark: a check once the item is done, an unstarted ring
 * while pending (dashed), and a ring being drawn while in progress (the
 * stylesheet spins it). The status is the row's accessible name.
 */
function TaskMark({ status, label }: { status: TodoItem['status']; label: string }): ReactNode {
  return (
    <span className={css.mark} role="img" aria-label={label}>
      {status === 'completed' ? <IconCheckOutline14 /> : <span className={css.ring} />}
    </span>
  )
}

/**
 * The Session's progress: its checklist while the projection carries one, then
 * every file its loaded Turns produced. With neither, one line says so.
 * @param props - tab information, the standard Session hooks, and the locale seat.
 * @returns the two sections, or the empty line.
 */
export function ProgressBody({
  useChat, useProjection, useSessions, sessionId, useTabInfo, t,
}: ProgressBodyProps): ReactNode {
  const todos = useProjection('todos') ?? NO_TODOS
  const timeline = useChat(snapshot => snapshot.timeline)
  const cwd = useSessions(sessions => sessions.byId[sessionId]?.cwd)
  const { tab } = useTabInfo()
  const files = useMemo(() => producedPaths(timeline), [timeline])

  if (todos.length === 0 && files.length === 0) {
    return <p className={css.empty} data-progress-state="empty">{t('empty')}</p>
  }
  const done = todos.filter(item => item.status === 'completed').length
  return (
    <div className={css.root} data-progress-state="progress">
      {todos.length > 0 && (
        <section className={css.section} data-progress-section="tasks" aria-label={t('tasks.title')}>
          <div className={css.header}>
            <span className={css.title}>{t('tasks.title')}</span>
            <span className={css.count}>{t('tasks.progress', { done, total: todos.length })}</span>
          </div>
          <ul className={css.list}>
            {todos.map(item => (
              <li key={item.content} className={css.task} data-status={item.status}>
                <TaskMark status={item.status} label={t(STATUS_LABEL[item.status])} />
                <span className={css.label}>{item.content}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {files.length > 0 && (
        <section className={css.section} data-progress-section="output" aria-label={t('output.title')}>
          <div className={css.header}>
            <span className={css.title}>{t('output.title')}</span>
            <span className={css.count}>
              {files.length === 1
                ? t('output.countOne', { count: files.length })
                : t('output.count', { count: files.length })}
            </span>
          </div>
          <ul className={css.list}>
            {files.map(path => (
              <li key={path} className={css.item}>
                <button
                  type="button"
                  className={css.file}
                  // The whole path disambiguates two turns' files that share a
                  // basename; the row itself shows the last segment.
                  title={path}
                  aria-label={t('open', { name: path })}
                  onClick={() => { tab.actions.openResource(fileAddressFor(sessionId, cwd, path)) }}
                >
                  <LinkIcon kind={classifyLinkPath(path)} className={css.fileIcon} />
                  <span className={css.label}>{workspaceTitleOf(path) || path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
