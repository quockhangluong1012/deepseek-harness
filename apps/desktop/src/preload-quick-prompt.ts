/** Localized quick-prompt copy and the shell-owned operations behind it. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import {
  QUICK_PROMPT_IPC,
  type QuickPromptApi,
  type QuickPromptShortcutCandidate,
  type QuickPromptShortcutResult,
  type QuickPromptSubmitResult,
} from './quick-prompt-api.ts'

const localePrefix = '--dsh-quick-prompt-locale='
const acceleratorPrefix = '--dsh-quick-prompt-accelerator='
const locale = process.argv.find(argument => argument.startsWith(localePrefix))?.slice(localePrefix.length)
if (locale === undefined) throw new Error('desktop quick prompt: missing window locale')
const api: QuickPromptApi = {
  ...resolveDesktopLocale(locale),
  accelerator: process.argv.find(argument => argument.startsWith(acceleratorPrefix))?.slice(acceleratorPrefix.length) ?? '',
  submit: (text: string) => ipcRenderer.invoke(QUICK_PROMPT_IPC.submit, text) as Promise<QuickPromptSubmitResult>,
  setShortcut: (candidate: QuickPromptShortcutCandidate) =>
    ipcRenderer.invoke(QUICK_PROMPT_IPC.shortcut, candidate) as Promise<QuickPromptShortcutResult>,
  close: () => { ipcRenderer.send(QUICK_PROMPT_IPC.close) },
}
contextBridge.exposeInMainWorld('dshQuickPrompt', api)
