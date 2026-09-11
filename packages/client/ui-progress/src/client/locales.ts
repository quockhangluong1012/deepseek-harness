/**
 * `sidebarProgress` namespace dictionaries, and the namespace's declaration.
 *
 * Section titles and their counts, the three task statuses, and the file
 * opener's accessible name all live here; the panel carries no text of its own.
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarProgress'>` or `PropsLocale<'sidebarProgress'>` needs
 * only this file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Progress panel type name, section counts, task statuses, and the empty line. */
    sidebarProgress: ProgressKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'type.label': '进度',
  'guide.title': '进度',
  'guide.description': '这个会话的任务清单，以及它产出的文件。',
  'tasks.title': '任务',
  'tasks.progress': '{done}/{total}',
  'tasks.status.completed': '已完成',
  'tasks.status.inProgress': '进行中',
  'tasks.status.pending': '待处理',
  'output.title': '产出文件',
  'output.count': '{count} 个文件',
  'output.countOne': '{count} 个文件',
  'open': '打开 {name}',
  empty: '还没有任务或文件。助手开始工作后会显示在这里。',
} satisfies Record<string, string>

/** Progress dictionary key union. */
export type ProgressKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Progress',
  'guide.title': 'Progress',
  'guide.description': 'This session\'s task list and the files it produced.',
  'tasks.title': 'Tasks',
  'tasks.progress': '{done}/{total}',
  'tasks.status.completed': 'Completed',
  'tasks.status.inProgress': 'In progress',
  'tasks.status.pending': 'Pending',
  'output.title': 'Output',
  'output.count': '{count} files',
  'output.countOne': '{count} file',
  'open': 'Open {name}',
  empty: 'No tasks or files yet. They appear here once the agent starts working.',
} satisfies Record<ProgressKey, string>
