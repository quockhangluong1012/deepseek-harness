/** `desktopNotifications` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  turnFinished: '回合已完成',
  approvalNeeded: '需要审批',
  questionAsked: '有新问题',
  jobFinished: '后台任务已结束',
  unnamedSession: '未命名会话',
} satisfies Record<string, string>

/** Desktop-notifications dictionary key union. */
export type DesktopNotificationsKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  turnFinished: 'Turn finished',
  approvalNeeded: 'Approval needed',
  questionAsked: 'New question',
  jobFinished: 'Background job finished',
  unnamedSession: 'Unnamed session',
} satisfies Record<DesktopNotificationsKey, string>
