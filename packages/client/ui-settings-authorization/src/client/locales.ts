/** Copy dictionaries for the sign-in companion. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  signIn: 'Sign in',
  signOut: 'Sign out',
  signedIn: 'Signed in',
  signingIn: 'Signing in…',
  sending: 'Sending…',
  submit: 'Submit',
  cancel: 'Cancel',
  close: 'Close',
  method: 'Sign-in method',
  openPage: 'Open sign-in page',
  loadFailed: 'Loading sign-in state failed',
  retry: 'Retry',
} as const

/** Every copy key the companion renders. */
export type AuthorizationKey = keyof typeof en

/** Chinese strings, key-complete with the English source of truth. */
export const zh: Record<AuthorizationKey, string> = {
  signIn: '登录',
  signOut: '退出登录',
  signedIn: '已登录',
  signingIn: '正在登录…',
  sending: '正在发送…',
  submit: '提交',
  cancel: '取消',
  close: '关闭',
  method: '登录方式',
  openPage: '打开登录页面',
  loadFailed: '加载登录状态失败',
  retry: '重试',
}
