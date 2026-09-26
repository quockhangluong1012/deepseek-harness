/** Global quick prompt: accelerator policy, its user preference, and the native window. */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent } from 'electron'
import type { DesktopLocale } from './locale.ts'
import {
  QUICK_PROMPT_IPC,
  type QuickPromptOperations,
  type QuickPromptShortcutCandidate,
} from './quick-prompt-api.ts'

/** Accelerator offered before the user changes it; every platform reserves it without conflict. */
export const DEFAULT_QUICK_PROMPT_ACCELERATOR = 'CommandOrControl+Shift+Space'

/** Shell preference file under the Electron user-data directory. */
export const QUICK_PROMPT_PREFERENCE_FILE = 'desktop-preferences.json'

/** Electron accelerator modifier names accepted in a stored or captured combination. */
const ACCELERATOR_MODIFIERS: Record<string, true> = {
  CommandOrControl: true, Command: true, Control: true, Alt: true, AltGr: true,
  Option: true, Shift: true, Super: true, Meta: true,
}

/** Named keys Electron accepts besides single letters, digits, and function keys. */
const ACCELERATOR_KEYS: Record<string, true> = {
  Space: true, Tab: true, Backspace: true, Delete: true, Insert: true, Return: true, Enter: true,
  Up: true, Down: true, Left: true, Right: true, Home: true, End: true, PageUp: true, PageDown: true,
  Escape: true, Esc: true, PrintScreen: true, Plus: true,
  '`': true, '-': true, '=': true, '[': true, ']': true, ';': true, '\'': true, '\\': true,
  ',': true, '.': true, '/': true,
}

/** KeyboardEvent.code values that keep their name in an accelerator. */
const CODE_KEYS: Record<string, string> = {
  Space: 'Space', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Enter: 'Enter', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Escape: 'Escape',
  PrintScreen: 'PrintScreen', Backquote: '`', Minus: '-', Equal: '=',
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: '\'',
  Comma: ',', Period: '.', Slash: '/',
}

/**
 * Validate an accelerator before it reaches the global-shortcut registry.
 * @param value - accelerator text from the preference file or from a captured combination.
 * @returns the accelerator unchanged when Electron can register that combination.
 */
export function resolveQuickPromptAccelerator(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) {
    throw new Error('desktop quick prompt: the global shortcut must be a non-empty, untrimmed-free string')
  }
  const components = value.split('+')
  const key = components.at(-1)
  const modifiers = components.slice(0, -1)
  const knownKey = key !== undefined
    && (ACCELERATOR_KEYS[key] === true || /^[A-Z0-9]$/u.test(key) || /^F(?:[1-9]|1\d|2[0-4])$/u.test(key))
  if (!knownKey || modifiers.length === 0
    || !modifiers.every(modifier => ACCELERATOR_MODIFIERS[modifier] === true)
    || new Set(modifiers).size !== modifiers.length) {
    throw new Error(`desktop quick prompt: invalid global shortcut ${JSON.stringify(value)}`)
  }
  // Shift alone would capture ordinary typing in every application.
  if (!modifiers.some(modifier => modifier !== 'Shift')) {
    throw new Error('desktop quick prompt: the global shortcut needs Control, Alt, Command, or Super')
  }
  return value
}

/**
 * Read the global shortcut the user chose.
 * @param file - preference JSON under the Electron user-data directory.
 * @returns the stored accelerator, or the default when the file or field is absent.
 */
export async function readQuickPromptAccelerator(file: string): Promise<string> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    // An absent preference file is the only reason to keep the default; a failed read stays loud.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return DEFAULT_QUICK_PROMPT_ACCELERATOR
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch (error) {
    throw new Error(`desktop quick prompt: ${file} is not valid JSON`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`desktop quick prompt: ${file} must contain a JSON object`)
  }
  const stored: unknown = 'quickPromptAccelerator' in parsed ? parsed.quickPromptAccelerator : undefined
  if (stored === undefined) return DEFAULT_QUICK_PROMPT_ACCELERATOR
  try {
    return resolveQuickPromptAccelerator(stored)
  } catch (error) {
    throw new Error(`desktop quick prompt: ${file} has an unusable quickPromptAccelerator`, { cause: error })
  }
}

/**
 * Persist the global shortcut the user captured.
 * @param file - preference JSON under the Electron user-data directory.
 * @param accelerator - accelerator Electron accepted.
 */
export async function writeQuickPromptAccelerator(file: string, accelerator: string): Promise<void> {
  await writeFile(file, `${JSON.stringify({ quickPromptAccelerator: accelerator }, null, 2)}\n`)
}

/**
 * Compose an Electron accelerator from one captured key combination.
 * @param candidate - keys the renderer observed; `code` is a KeyboardEvent.code.
 * @param platform - operating system; the Meta key names Command on macOS and Super elsewhere.
 * @returns the accelerator, or undefined when that combination cannot be one.
 */
export function acceleratorFromCandidate(
  candidate: QuickPromptShortcutCandidate,
  platform: NodeJS.Platform,
): string | undefined {
  const key = candidate.code.startsWith('Key') ? candidate.code.slice(3)
    : candidate.code.startsWith('Digit') ? candidate.code.slice(5)
      : /^F(?:[1-9]|1\d|2[0-4])$/u.test(candidate.code) ? candidate.code
        : CODE_KEYS[candidate.code]
  if (key === undefined) return undefined
  const modifiers = [
    ...candidate.control ? ['Control'] : [],
    ...candidate.alt ? ['Alt'] : [],
    ...candidate.shift ? ['Shift'] : [],
    ...candidate.meta ? [platform === 'darwin' ? 'Command' : 'Super'] : [],
  ]
  if (modifiers.length === 0) return undefined
  const composed = [...modifiers, key].join('+')
  try {
    return resolveQuickPromptAccelerator(composed)
  } catch {
    // The captured key cannot be an accelerator; the window reports the invalid combination.
    return undefined
  }
}

/**
 * Resolve the quick prompt window's native material and controls.
 * @param platform - operating system hosting Electron.
 * @param locale - shell-owned localized copy.
 * @param accelerator - currently registered global shortcut, shown for editing.
 * @returns a sandboxed window that stays above the workspace without taking a taskbar seat.
 */
export function quickPromptWindowOptions(
  platform: NodeJS.Platform,
  locale: DesktopLocale,
  accelerator: string,
): BrowserWindowConstructorOptions {
  return {
    width: 560,
    height: 208,
    useContentSize: true,
    show: false,
    center: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: locale.messages.quickPromptTitle,
    backgroundColor: platform === 'darwin' ? '#00000000' : '#FFFFFF',
    ...(platform === 'darwin' ? { vibrancy: 'menu' as const, visualEffectState: 'active' as const } : {}),
    webPreferences: {
      preload: fileURLToPath(new URL('./preload-quick-prompt.cjs', import.meta.url)),
      additionalArguments: [`--dsh-quick-prompt-locale=${locale.id}`, `--dsh-quick-prompt-accelerator=${accelerator}`],
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  }
}

let disposeActiveHandlers: (() => void) | undefined

/**
 * Open the process's sole quick prompt window.
 * Replaces IPC ownership immediately; the caller closes the previous native window.
 * @param locale - shell-owned localized copy for this window.
 * @param accelerator - currently registered global shortcut.
 * @param operations - prompt submission and shortcut replacement.
 * @returns the visible window; a failed load destroys it before rejecting.
 */
export async function openQuickPromptWindow(
  locale: DesktopLocale,
  accelerator: string,
  operations: QuickPromptOperations,
): Promise<BrowserWindow> {
  const window = new BrowserWindow(quickPromptWindowOptions(process.platform, locale, accelerator))
  disposeActiveHandlers?.()
  let active = true
  const disposeHandlers = (): void => {
    if (!active) return
    active = false
    for (const channel of [QUICK_PROMPT_IPC.submit, QUICK_PROMPT_IPC.shortcut, QUICK_PROMPT_IPC.close]) {
      ipcMain.removeHandler(channel)
      ipcMain.removeListener(channel, assertSender)
    }
    disposeActiveHandlers = undefined
  }
  disposeActiveHandlers = disposeHandlers
  function assertSender(event: IpcMainInvokeEvent): void {
    if (!active || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('desktop quick prompt: rejected IPC from an unowned frame')
    }
  }
  ipcMain.handle(QUICK_PROMPT_IPC.submit, async (event, value: unknown) => {
    assertSender(event)
    if (typeof value !== 'string') throw new Error('desktop quick prompt: the prompt must be text')
    return operations.submit(value)
  })
  ipcMain.handle(QUICK_PROMPT_IPC.shortcut, async (event, value: unknown) => {
    assertSender(event)
    return operations.setShortcut(shortcutCandidate(value))
  })
  ipcMain.on(QUICK_PROMPT_IPC.close, assertSender)
  window.once('closed', disposeHandlers)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => { event.preventDefault() })
  try {
    await window.loadFile(join(app.getAppPath(), 'renderer', 'quick-prompt.html'))
  } catch (error) {
    disposeHandlers()
    if (!window.isDestroyed()) window.destroy()
    throw error
  }
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Another window can replace ownership during loadFile.
  if (active && !window.isDestroyed()) {
    window.show()
    window.focus()
  }
  return window
}

/** Reject a captured combination that is not the renderer's key report. */
function shortcutCandidate(value: unknown): QuickPromptShortcutCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop quick prompt: invalid key combination')
  }
  // IPC is a wire boundary: read each field as unknown and check it before use.
  const candidate: Record<string, unknown> = { ...value }
  if (typeof candidate.code !== 'string' || candidate.code.length > 32
    || typeof candidate.control !== 'boolean' || typeof candidate.alt !== 'boolean'
    || typeof candidate.shift !== 'boolean' || typeof candidate.meta !== 'boolean') {
    throw new Error('desktop quick prompt: invalid key combination')
  }
  return {
    code: candidate.code,
    control: candidate.control,
    alt: candidate.alt,
    shift: candidate.shift,
    meta: candidate.meta,
  }
}
