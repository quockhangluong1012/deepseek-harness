/** Operations available to the isolated quick-prompt renderer. */

import type { DesktopLocale } from './locale.ts'

/** Private quick-prompt channels, installed only while its window exists. */
export const QUICK_PROMPT_IPC = {
  submit: 'dsh-quick-prompt:submit',
  shortcut: 'dsh-quick-prompt:shortcut',
  close: 'dsh-quick-prompt:close',
} as const

/** Outcome of one submitted prompt; the renderer selects the copy for each reason. */
export type QuickPromptSubmitResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: 'empty' | 'unavailable' | 'rejected' }

/** Outcome of one captured accelerator; the renderer selects the copy for each reason. */
export type QuickPromptShortcutResult =
  | { readonly ok: true; readonly accelerator: string }
  | { readonly ok: false; readonly reason: QuickPromptShortcutFailure }

/** Why a captured accelerator was refused. */
export type QuickPromptShortcutFailure = 'invalid' | 'conflict' | 'unpersisted'

/** One key combination as the renderer observed it in its own KeyboardEvent. */
export interface QuickPromptShortcutCandidate {
  readonly code: string
  readonly control: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
}

/** Host-owned operations used by the quick prompt window. */
export interface QuickPromptOperations {
  /**
   * Create a Session from the text and prompt it.
   * @param text - prompt text as typed; the main process trims and validates it.
   * @returns the Session that accepted the prompt, or why none did.
   */
  submit(text: string): Promise<QuickPromptSubmitResult>
  /**
   * Replace the global shortcut with a captured combination.
   * @param candidate - the keys the user pressed.
   * @returns the registered accelerator, or why it was refused.
   */
  setShortcut(candidate: QuickPromptShortcutCandidate): Promise<QuickPromptShortcutResult>
  /** Close the quick prompt without submitting. */
  close(): void
}

/** The renderer receives localized copy, the active accelerator, and these operations. */
export type QuickPromptApi = DesktopLocale & QuickPromptOperations & {
  /** Accelerator currently registered, or '' when the global shortcut is unavailable. */
  readonly accelerator: string
}
