/** `review` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'review'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'kind.code': '代码审查',
  'kind.security': '安全审查',
  'target.uncommitted': '未提交的更改',
  'target.ref': '与 {ref} 比较',
  'findings.label': '问题列表',
  'findings.empty': '未发现问题',
  'findings.count.one': '{count} 个问题',
  'findings.count.other': '{count} 个问题',
  'severity.high': '高',
  'severity.medium': '中',
  'severity.low': '低',
}

/** English dictionary (same key set). */
export const en: Record<ReviewKey, string> = {
  'kind.code': 'Code review',
  'kind.security': 'Security review',
  'target.uncommitted': 'Uncommitted changes',
  'target.ref': 'Against {ref}',
  'findings.label': 'Findings',
  'findings.empty': 'No findings',
  'findings.count.one': '{count} finding',
  'findings.count.other': '{count} findings',
  'severity.high': 'High',
  'severity.medium': 'Medium',
  'severity.low': 'Low',
}

/** Union of this namespace's dictionary keys. */
export type ReviewKey = keyof typeof zh
